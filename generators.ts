import {
  cvToString,
  serializeCV,
  type ClarityValue,
} from "@stacks/transactions";
import fc from "fast-check";

import { argToCV, functionToArbitrary } from "./shared";
import type {
  EnrichedContractInterfaceFunction,
  EnrichedParameterType,
} from "./shared.types";
import { getContractIdsImplementingTrait } from "./traits";
import type { ImplementedTraitType } from "./traits.types";

const generatorTypes = [
  "int128",
  "uint128",
  "bool",
  "principal",
  "buffer",
  "string-ascii",
  "string-utf8",
  "list",
  "tuple",
  "optional",
  "response",
  "trait_reference",
] as const;

/**
 * Top-level argument types, as named in the contract interface. A type
 * override replaces whole arguments, not nested tuple or list fields.
 */
export type GeneratorType = (typeof generatorTypes)[number];

export interface GeneratorSampleParameters {
  seed: number;
  numRuns: number;
}

/** A sampler must exercise the supplied arbitrary, not an unrelated one. */
export type ClarityGeneratorSampler = (
  arbitrary: fc.Arbitrary<ClarityValue>,
  parameters: GeneratorSampleParameters,
) => ClarityValue[];

export interface ClarityGenerator {
  arbitrary: fc.Arbitrary<ClarityValue>;
  sampler: ClarityGeneratorSampler;
}

export interface StrategyOptions {
  /** Generators for named arguments. They take precedence over `types`. */
  arguments?: Record<string, ClarityGenerator>;
  /** Generators for every top-level argument of the given type. */
  types?: Partial<Record<GeneratorType, ClarityGenerator>>;
  /** Preflight sampling parameters. Defaults to seed 0 and 100 samples. */
  validation?: Partial<GeneratorSampleParameters>;
}

/** The standard sampler. Custom samplers can add domain-specific checks. */
export const sampleClarityGenerator: ClarityGeneratorSampler = (arb, params) =>
  fc.sample(arb, params);

/**
 * Thrown for invalid generator configuration or generated values. This is a
 * tooling error, not a contract failure.
 */
export class GeneratorValidationError extends Error {
  cause?: unknown;
  constructor(message: string, options?: { cause: unknown }) {
    super(message);
    this.cause = options?.cause;
    this.name = "GeneratorValidationError";
  }
}

// The TypeScript target predates `Object.hasOwn`.
const hasOwn = (obj: object, key: string) =>
  // eslint-disable-next-line prefer-object-has-own
  Object.prototype.hasOwnProperty.call(obj, key);

// Arbitraries from another fast-check copy (e.g. its ESM build, while this
// package loads the CommonJS one) fail `instanceof`, so check the shape, as
// fast-check itself does. Preflight and per-value checks cover the rest.
const isArbitrary = (value: unknown): value is fc.Arbitrary<ClarityValue> =>
  typeof value === "object" &&
  value !== null &&
  ["generate", "shrink", "canShrinkWithoutContext", "map"].every(
    (method) =>
      typeof (value as Record<string, unknown>)[method] === "function",
  );

const typeOf = (type: EnrichedParameterType): GeneratorType =>
  typeof type === "string" ? type : (Object.keys(type)[0] as GeneratorType);

const toBigInt = (value: unknown): bigint | undefined => {
  if (typeof value === "bigint") {
    return value;
  }
  if (typeof value === "number") {
    return Number.isSafeInteger(value) ? BigInt(value) : undefined;
  }
  if (typeof value === "string" && /^-?\d+$/.test(value)) {
    return BigInt(value);
  }
  return undefined;
};

const UINT_LIMIT = BigInt(1) << BigInt(128);
const INT_LIMIT = BigInt(1) << BigInt(127);
const LONE_SURROGATE =
  /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u;

// Checks ABI shape and bounds, not contract-specific business rules.
const matchesType = (
  value: ClarityValue,
  type: EnrichedParameterType,
  traits: Record<string, ImplementedTraitType[]>,
): boolean => {
  if (!value || typeof value !== "object") {
    return false;
  }
  if (typeof type === "string") {
    if (type === "uint128" || type === "int128") {
      if (value.type !== (type === "uint128" ? "uint" : "int")) {
        return false;
      }
      const n = toBigInt(value.value);
      if (n === undefined) {
        return false;
      }
      return type === "uint128"
        ? n >= BigInt(0) && n < UINT_LIMIT
        : n >= -INT_LIMIT && n < INT_LIMIT;
    }
    if (type === "bool") {
      return value.type === "true" || value.type === "false";
    }
    return value.type === "address" || value.type === "contract";
  }
  if ("buffer" in type) {
    return (
      value.type === "buffer" &&
      /^[0-9a-f]*$/i.test(value.value) &&
      value.value.length % 2 === 0 &&
      value.value.length / 2 <= type.buffer.length
    );
  }
  if ("string-ascii" in type) {
    return (
      value.type === "ascii" &&
      [...value.value].every((char) => char.charCodeAt(0) <= 127) &&
      value.value.length <= type["string-ascii"].length
    );
  }
  if ("string-utf8" in type) {
    return (
      value.type === "utf8" &&
      !LONE_SURROGATE.test(value.value) &&
      [...value.value].length <= type["string-utf8"].length
    );
  }
  if ("list" in type) {
    return (
      value.type === "list" &&
      Array.isArray(value.value) &&
      value.value.length <= type.list.length &&
      value.value.every((item) => matchesType(item, type.list.type, traits))
    );
  }
  if ("tuple" in type) {
    return (
      value.type === "tuple" &&
      value.value !== null &&
      typeof value.value === "object" &&
      Object.keys(value.value).length === type.tuple.length &&
      type.tuple.every(
        (field) =>
          hasOwn(value.value, field.name) &&
          matchesType(value.value[field.name], field.type, traits),
      )
    );
  }
  if ("optional" in type) {
    return (
      value.type === "none" ||
      (value.type === "some" && matchesType(value.value, type.optional, traits))
    );
  }
  if ("response" in type) {
    return (
      (value.type === "ok" &&
        matchesType(value.value, type.response.ok, traits)) ||
      (value.type === "err" &&
        matchesType(value.value, type.response.error, traits))
    );
  }
  return (
    value.type === "contract" &&
    getContractIdsImplementingTrait(type.trait_reference, traits).includes(
      cvToString(value),
    )
  );
};

/**
 * Returns whether the options select any custom generator. Throws for
 * unknown option keys, which would otherwise fall back to the default
 * generators without notice.
 */
export const hasCustomGenerators = (options: StrategyOptions): boolean => {
  for (const key of Object.keys(options)) {
    if (!["arguments", "types", "validation"].includes(key)) {
      throw new GeneratorValidationError(`Unknown strategy option "${key}".`);
    }
  }
  return (
    Object.keys(options.arguments ?? {}).length > 0 ||
    Object.keys(options.types ?? {}).length > 0
  );
};

/**
 * Builds the argument arbitrary when custom generators are supplied. Each
 * selected generator is sampled once up front; every value it later produces,
 * including shrink candidates, is checked against the argument type.
 */
export const customStrategyFor = (
  fn: EnrichedContractInterfaceFunction,
  addresses: string[],
  traits: Record<string, ImplementedTraitType[]>,
  options: StrategyOptions,
): fc.Arbitrary<ClarityValue[]> => {
  const args = options.arguments ?? {};
  const types = options.types ?? {};
  for (const name of Object.keys(args)) {
    if (!fn.args.some((arg) => arg.name === name)) {
      throw new GeneratorValidationError(
        `Unknown argument "${name}" in ${fn.name}.`,
      );
    }
  }
  for (const type of Object.keys(types)) {
    if (!(generatorTypes as readonly string[]).includes(type)) {
      throw new GeneratorValidationError(`Unknown generator type "${type}".`);
    }
  }
  const params = { seed: 0, numRuns: 100, ...options.validation };
  if (
    !Number.isInteger(params.seed) ||
    params.seed < -2147483648 ||
    params.seed > 2147483647 ||
    !Number.isSafeInteger(params.numRuns) ||
    params.numRuns < 1 ||
    params.numRuns > 10000
  ) {
    throw new GeneratorValidationError(
      "Invalid validation seed or numRuns (1..10000).",
    );
  }
  const arbitraries = fn.args.map((arg) => {
    const type = arg.type as EnrichedParameterType;
    if (!hasOwn(args, arg.name) && !hasOwn(types, typeOf(type))) {
      return functionToArbitrary(
        { ...fn, args: [arg] },
        addresses,
        traits,
      )[0].map((value) => argToCV(value, type));
    }
    const generator = hasOwn(args, arg.name)
      ? args[arg.name]
      : types[typeOf(type)];
    const validate = (value: ClarityValue): ClarityValue => {
      try {
        if (!matchesType(value, type, traits)) {
          throw new Error("ABI type or bounds mismatch");
        }
        serializeCV(value);
        return value;
      } catch (cause) {
        throw new GeneratorValidationError(
          `Invalid custom value for ${fn.name}.${arg.name}.`,
          { cause },
        );
      }
    };
    try {
      if (
        !generator ||
        typeof generator.sampler !== "function" ||
        !isArbitrary(generator.arbitrary)
      ) {
        throw new Error("Provide an arbitrary and a corresponding sampler");
      }
      const samples = generator.sampler(generator.arbitrary, { ...params });
      if (!Array.isArray(samples) || samples.length !== params.numRuns) {
        throw new Error(`Sampler must return ${params.numRuns} values`);
      }
      for (const sample of samples) {
        validate(sample);
      }
    } catch (cause) {
      throw new GeneratorValidationError(
        `Custom generator preflight failed for ${fn.name}.${arg.name} ` +
          `(seed ${params.seed}, samples ${params.numRuns}).`,
        { cause },
      );
    }
    return generator.arbitrary.map(validate);
  });
  return arbitraries.length ? fc.tuple(...arbitraries) : fc.constant([]);
};
