import { createRequire } from "node:module";
import { join, resolve } from "node:path";

import { initSimnet, type Simnet } from "@stacks/clarinet-sdk";
import {
  boolCV,
  bufferCV,
  ClarityType,
  intCV,
  listCV,
  noneCV,
  principalCV,
  responseErrorCV,
  responseOkCV,
  someCV,
  stringAsciiCV,
  stringUtf8CV,
  tupleCV,
  uintCV,
  type ClarityValue,
} from "@stacks/transactions";
import fc from "fast-check";

import {
  GeneratorValidationError,
  getContractFunction,
  sampleClarityGenerator,
  strategyFor,
  type ClarityGenerator,
  type EnrichedContractInterfaceFunction,
  type StrategyOptions,
} from "./lib";
import { argsToCV, functionToArbitrary } from "./shared";
import type { EnrichedParameterType } from "./shared.types";

// These unit tests pass explicit addresses and traits, so no simnet is used.
const stubSimnet = {} as Simnet;
const fn = (
  ...types: EnrichedParameterType[]
): EnrichedContractInterfaceFunction => ({
  name: "deposit",
  access: "public",
  outputs: { type: "bool" },
  args: types.map((type, i) => ({
    name: `arg${i}`,
    type,
  })) as EnrichedContractInterfaceFunction["args"],
});
const custom = (arbitrary: fc.Arbitrary<ClarityValue>): ClarityGenerator => ({
  arbitrary,
  sampler: sampleClarityGenerator,
});
const strategy = (
  f: EnrichedContractInterfaceFunction,
  opts?: StrategyOptions,
) => strategyFor(stubSimnet, f, [], {}, opts);
const samples = { seed: 6607, numRuns: 100 };

describe("custom argument generators", () => {
  it("accepts compatible arbitraries from another fast-check module copy", () => {
    // The package's CJS and ESM entrypoints have different constructors.
    const otherFc: typeof fc = createRequire(__filename)("fast-check");
    const arbitrary = otherFc.integer({ min: 2, max: 10 }).map(uintCV);
    expect(arbitrary instanceof fc.Arbitrary).toBe(false);
    const values = fc.sample(
      strategy(fn("uint128"), {
        arguments: { arg0: custom(arbitrary) },
      }),
      samples,
    );
    expect(values).toHaveLength(100);
    for (const [value] of values) {
      expect(value.type).toBe(ClarityType.UInt);
      const n = BigInt((value as ReturnType<typeof uintCV>).value);
      expect(n).toBeGreaterThanOrEqual(BigInt(2));
      expect(n).toBeLessThanOrEqual(BigInt(10));
    }
    const result = fc.check(
      fc.property(
        strategy(fn("uint128"), {
          arguments: { arg0: custom(arbitrary) },
        }),
        ([value]) =>
          BigInt((value as ReturnType<typeof uintCV>).value) < BigInt(5),
      ),
      { seed: 66, numRuns: 100 },
    );
    expect(result.failed).toBe(true);
    expect(result.counterexample).toEqual([[uintCV(5)]]);
    expect(result.numShrinks).toBeGreaterThan(0);
  });

  it("rejects malformed arbitrary objects before running the sampler", () => {
    for (const arbitrary of [null, {}, { map: () => fc.constant(uintCV(1)) }]) {
      const sampler = vi.fn(sampleClarityGenerator);
      expect(() =>
        strategy(fn("uint128"), {
          arguments: {
            arg0: {
              arbitrary: arbitrary as unknown as fc.Arbitrary<ClarityValue>,
              sampler,
            },
          },
        }),
      ).toThrow(GeneratorValidationError);
      expect(sampler).not.toHaveBeenCalled();
    }
  });

  it("does not sample unused type overrides", () => {
    const sampler = vi.fn(() => {
      throw new Error("must not run");
    });
    const values = fc.sample(
      strategy(fn("bool"), {
        types: { uint128: { arbitrary: fc.constant(uintCV(0)), sampler } },
      }),
      samples,
    );
    expect(values).toEqual(fc.sample(strategy(fn("bool")), samples));
    expect(sampler).not.toHaveBeenCalled();
  });

  it("rejects sparse samples before returning a strategy", () => {
    expect(() =>
      strategy(fn("uint128"), {
        arguments: {
          arg0: {
            arbitrary: fc.constant(uintCV(0)),
            sampler: (_, p) => new Array(p.numRuns),
          },
        },
      }),
    ).toThrow(GeneratorValidationError);
  });

  it("rejects invalid shrink candidates before the property receives them", () => {
    const arbitrary = strategy(fn("uint128"), {
      arguments: {
        arg0: {
          arbitrary: fc
            .integer({ min: 0, max: 10 })
            .map((n) => (n === 0 ? boolCV(true) : uintCV(n))),
          sampler: (_, p) => Array.from({ length: p.numRuns }, () => uintCV(1)),
        },
      },
    });
    const received: ClarityValue[] = [];
    const check = () =>
      fc.check(
        fc.property(arbitrary, (args) => {
          received.push(args[0]);
          return false;
        }),
        { seed: 66, numRuns: 1 },
      );
    expect(check).toThrow(GeneratorValidationError);
    expect(received.length).toBeGreaterThan(0);
    expect(received.every((v) => v.type === ClarityType.UInt)).toBe(true);
  });

  it("checks trait implementations, not just principal shape", () => {
    const trait = {
      name: "token",
      import: {
        Imported: {
          name: "token",
          contract_identifier: { issuer: [1], name: "traits" },
        },
      },
    };
    const f = fn({ trait_reference: trait });
    const contractId = "ST1PQHQKV0RJXZFY1DGX8MNSNYVE3VGZJSRTPGZGM.counter";
    const options = {
      arguments: { arg0: custom(fc.constant(principalCV(contractId))) },
    };
    expect(() => strategy(f, options)).toThrow(GeneratorValidationError);
    const arb = strategyFor(
      stubSimnet,
      f,
      [],
      {
        [contractId]: [
          {
            name: "token",
            contract_identifier: { issuer: [1], name: "traits" },
          },
        ],
      },
      options,
    );
    expect(fc.sample(arb, { seed: 66, numRuns: 1 })).toEqual([
      [principalCV(contractId)],
    ]);
  });

  it("accepts integer limits, buffers, response branches, and UTF-8", () => {
    const pairs: [EnrichedParameterType, ClarityValue][] = [
      ["uint128", uintCV((BigInt(1) << BigInt(128)) - BigInt(1))],
      ["int128", intCV(-(BigInt(1) << BigInt(127)))],
      [{ buffer: { length: 2 } }, bufferCV(new Uint8Array([0, 255]))],
      [{ response: { ok: "uint128", error: "bool" } }, responseOkCV(uintCV(0))],
      [
        { response: { ok: "uint128", error: "bool" } },
        responseErrorCV(boolCV(false)),
      ],
      [{ "string-utf8": { length: 1 } }, stringUtf8CV("😀")],
    ];
    for (const [type, value] of pairs) {
      expect(
        fc.sample(
          strategy(fn(type), {
            arguments: { arg0: custom(fc.constant(value)) },
          }),
          { seed: 66, numRuns: 1 },
        ),
      ).toEqual([[value]]);
    }
  });

  it("preserves the stock seeded stream without overrides", () => {
    const f = fn("uint128", "bool", { list: { type: "uint128", length: 3 } });
    const stock = fc
      .tuple(...functionToArbitrary(f, [], {}))
      .map((values) => argsToCV(f, values));
    expect(fc.sample(strategy(f), samples)).toEqual(fc.sample(stock, samples));
    expect(fc.sample(strategy(f, {}), samples)).toEqual(
      fc.sample(stock, samples),
    );
  });

  it("uses named ranges ahead of type overrides", () => {
    const values = fc.sample(
      strategy(fn("uint128", "uint128", "bool"), {
        types: {
          uint128: custom(
            fc.bigInt({ min: BigInt(20), max: BigInt(30) }).map(uintCV),
          ),
        },
        arguments: {
          arg0: custom(
            fc.bigInt({ min: BigInt(2), max: BigInt(10) }).map(uintCV),
          ),
        },
        validation: { seed: 66, numRuns: 20 },
      }),
      samples,
    );
    expect(new Set(values.map((args) => args[0].type))).toEqual(
      new Set([ClarityType.UInt]),
    );
    for (const args of values) {
      expect(
        BigInt((args[0] as ReturnType<typeof uintCV>).value),
      ).toBeGreaterThanOrEqual(BigInt(2));
      expect(
        BigInt((args[0] as ReturnType<typeof uintCV>).value),
      ).toBeLessThanOrEqual(BigInt(10));
      expect(
        BigInt((args[1] as ReturnType<typeof uintCV>).value),
      ).toBeGreaterThanOrEqual(BigInt(20));
    }
  });

  it("passes reproducible preflight parameters to the corresponding sampler", () => {
    const sampler = vi.fn(sampleClarityGenerator);
    const arbitrary = fc.constant(uintCV(5));
    strategy(fn("uint128"), {
      arguments: { arg0: { arbitrary, sampler } },
      validation: { seed: 66, numRuns: 7 },
    });
    expect(sampler).toHaveBeenCalledWith(arbitrary, { seed: 66, numRuns: 7 });
  });

  it("rejects unknown names, types and option keys", () => {
    expect(() =>
      strategy(fn("uint128"), {
        arguments: { typo: custom(fc.constant(uintCV(5))) },
      }),
    ).toThrow(/Unknown argument/);
    expect(() =>
      strategy(fn("uint128"), {
        types: {
          typo: custom(fc.constant(uintCV(5))),
        } as StrategyOptions["types"],
      }),
    ).toThrow(/Unknown generator type/);
    // A misspelled key must not silently select the default generators.
    expect(() =>
      strategy(fn("uint128"), {
        argument: { arg0: custom(fc.constant(uintCV(5))) },
      } as StrategyOptions),
    ).toThrow(/Unknown strategy option "argument"/);
  });

  it("requires an actual sampler and the requested sample count", () => {
    expect(() =>
      strategy(fn("uint128"), {
        arguments: {
          arg0: { arbitrary: fc.constant(uintCV(5)) } as ClarityGenerator,
        },
      }),
    ).toThrow(GeneratorValidationError);
    expect(() =>
      strategy(fn("uint128"), {
        arguments: {
          arg0: { arbitrary: fc.constant(uintCV(5)), sampler: () => [] },
        },
      }),
    ).toThrow(GeneratorValidationError);
  });

  it("classifies throwing generators and samplers as tool errors", () => {
    expect(() =>
      strategy(fn("uint128"), {
        arguments: {
          arg0: custom(
            fc.constant(0).map(() => {
              throw new Error("broken");
            }),
          ),
        },
      }),
    ).toThrow(/preflight failed/);
    expect(() =>
      strategy(fn("uint128"), {
        arguments: {
          arg0: {
            arbitrary: fc.constant(uintCV(5)),
            sampler: () => {
              throw new Error("broken sampler");
            },
          },
        },
      }),
    ).toThrow(/preflight failed/);
  });

  it("checks every runtime value even if a sampler misses a bad result", () => {
    const arb = strategy(fn("uint128"), {
      arguments: {
        arg0: {
          arbitrary: fc.constant(boolCV(true)),
          sampler: (_, p) => Array.from({ length: p.numRuns }, () => uintCV(5)),
        },
      },
    });
    expect(() => fc.sample(arb, samples)).toThrow(GeneratorValidationError);
  });

  it("rejects mismatched nested types, bounds, and tuple fields", () => {
    const invalid: [EnrichedParameterType, ClarityValue][] = [
      ["uint128", boolCV(true)],
      ["uint128", { type: ClarityType.UInt, value: BigInt(1) << BigInt(128) }],
      ["uint128", { type: ClarityType.UInt, value: -1 }],
      [
        { list: { type: "uint128", length: 1 } },
        listCV([uintCV(1), uintCV(2)]),
      ],
      [{ list: { type: "uint128", length: 1 } }, listCV([boolCV(true)])],
      [
        { tuple: [{ name: "amount", type: "uint128" }] },
        tupleCV({ wrong: uintCV(1) }),
      ],
      [{ optional: "uint128" }, someCV(boolCV(true))],
      [{ "string-ascii": { length: 1 } }, stringAsciiCV("ab")],
    ];
    for (const [type, value] of invalid) {
      expect(() =>
        strategy(fn(type), { arguments: { arg0: custom(fc.constant(value)) } }),
      ).toThrow(GeneratorValidationError);
    }
  });

  it("accepts whole composite overrides without double conversion", () => {
    const values = [
      listCV([uintCV(0)]),
      tupleCV({ amount: uintCV(0) }),
      someCV(uintCV(0)),
      noneCV(),
    ];
    const f = fn(
      { list: { type: "uint128", length: 1 } },
      { tuple: [{ name: "amount", type: "uint128" }] },
      { optional: "uint128" },
      { optional: "uint128" },
    );
    const argumentsMap = Object.fromEntries(
      values.map((value, i) => [`arg${i}`, custom(fc.constant(value))]),
    );
    expect(
      fc.sample(strategy(f, { arguments: argumentsMap }), {
        seed: 66,
        numRuns: 1,
      }),
    ).toEqual([values]);
  });

  it("rejects unbounded preflight requests", () => {
    for (const numRuns of [0, -1, 10001, NaN]) {
      expect(() =>
        strategy(fn("uint128"), {
          types: { uint128: custom(fc.constant(uintCV(1))) },
          validation: { numRuns },
        }),
      ).toThrow(/Invalid validation/);
    }
  });
});

describe("custom argument generators with simnet", () => {
  it("drives contract calls with a constrained named argument", async () => {
    const manifestPath = join(resolve(__dirname, "example"), "Clarinet.toml");
    const simnet = await initSimnet(manifestPath);
    const add = getContractFunction(simnet, "counter", "add");
    const argsArb = strategyFor(simnet, add, undefined, undefined, {
      arguments: {
        n: custom(fc.bigInt({ min: BigInt(2), max: BigInt(10) }).map(uintCV)),
      },
    });
    const getCounter = () =>
      BigInt(
        (
          simnet.callReadOnlyFn("counter", "get-counter", [], simnet.deployer)
            .result as ReturnType<typeof uintCV>
        ).value,
      );

    fc.assert(
      fc.property(argsArb, (args) => {
        const before = getCounter();
        const { result } = simnet.callPublicFn(
          "counter",
          "add",
          args,
          simnet.deployer,
        );
        const n = BigInt((args[0] as ReturnType<typeof uintCV>).value);
        // `add` rejects n <= 1, so every constrained call must succeed.
        return (
          result.type === ClarityType.ResponseOk && getCounter() === before + n
        );
      }),
      { seed: 6607, numRuns: 50 },
    );
  });
});
