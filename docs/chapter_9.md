# Library API

Rendezvous can be used as a library for building custom property-based testing strategies in TypeScript. Instead of relying solely on the `rv` CLI, you can import its argument generation capabilities directly and compose your own [fast-check](https://github.com/dubzzz/fast-check) properties.

This is useful when you need full control over the testing loop: custom assertions, stateful setups, multi-contract interactions, or integration with existing test frameworks like Vitest or Jest.

## Installation

```bash
npm install @stacks/rendezvous
```

Rendezvous ships with TypeScript declarations. You also need `fast-check` and `@stacks/clarinet-sdk` (both are already dependencies).

## API

### `getContractFunction(simnet, contractName, functionName, deployer?)`

Retrieves a function interface from a deployed contract. The returned interface is enriched with trait reference data when applicable.

**Parameters:**

| Parameter      | Type     | Description                                                |
| -------------- | -------- | ---------------------------------------------------------- |
| `simnet`       | `Simnet` | The simnet instance from `initSimnet`.                     |
| `contractName` | `string` | The contract name (e.g., `"counter"`).                     |
| `functionName` | `string` | The function name (e.g., `"increment"`).                   |
| `deployer`     | `string` | Optional. Deployer address. Defaults to `simnet.deployer`. |

**Returns:** `EnrichedContractInterfaceFunction`

**Throws** if the contract or function is not found.

### `strategyFor(simnet, fn, allAddresses?, projectTraitImplementations?, options?)`

Returns a fast-check arbitrary that produces `ClarityValue[]` arrays — ready for use with `simnet.callPublicFn`, `simnet.callReadOnlyFn`, or `callPrivateFn`.

Handles all Clarity types automatically: `uint`, `int`, `bool`, `principal`, `buff`, `string-ascii`, `string-utf8`, `list`, `tuple`, `optional`, `response`, and `trait_reference` (including recursive/nested structures like list of tuples or optional of response).

**Parameters:**

| Parameter                     | Type                                     | Description                                                                                                              |
| ----------------------------- | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `simnet`                      | `Simnet`                                 | The simnet instance.                                                                                                     |
| `fn`                          | `EnrichedContractInterfaceFunction`      | Function interface from `getContractFunction`.                                                                           |
| `allAddresses`                | `string[]`                               | Optional. Addresses used for principal-typed argument generation. Defaults to every account in the simnet.               |
| `projectTraitImplementations` | `Record<string, ImplementedTraitType[]>` | Optional. Project/requirement contracts keyed by the traits they implement. Defaults to extracting them from the simnet. |
| `options`                     | `StrategyOptions`                        | Optional. Custom generators for named arguments or argument types. See [Custom Generators](#custom-generators).          |

**Returns:** `fc.Arbitrary<ClarityValue[]>`

When neither override is supplied, principal addresses and trait implementations are resolved from the simnet automatically. Pass `allAddresses` to restrict the principal pool (for example, to a user-filtered account set), and `projectTraitImplementations` to reuse a precomputed map when calling `strategyFor` repeatedly.

## Example

```ts
import { initSimnet } from "@stacks/clarinet-sdk";
import { getContractFunction, strategyFor } from "@stacks/rendezvous";
import fc from "fast-check";

const simnet = await initSimnet("./Clarinet.toml");
const add = getContractFunction(simnet, "counter", "add");
const arb = strategyFor(simnet, add);

fc.assert(
  fc.property(arb, (args) => {
    const { result } = simnet.callPublicFn(
      `${simnet.deployer}.counter`,
      "add",
      args,
      simnet.deployer,
    );
    return result.type !== "err";
  }),
);
```

## Custom Deployer

If the contract is deployed by an address other than the default deployer, pass it explicitly:

```ts
const fn = getContractFunction(simnet, "my-contract", "my-fn", "ST1OTHER...");
```

## Functions With No Arguments

For functions that take no parameters, `strategyFor` returns an arbitrary producing empty arrays:

```ts
const increment = getContractFunction(simnet, "counter", "increment");
const arb = strategyFor(simnet, increment);
// arb always produces [].
```

## Restricting the Principal Pool

When a function takes a `principal` argument, `strategyFor` draws from every account in the simnet by default. Pass `allAddresses` to restrict that pool:

```ts
const mint = getContractFunction(simnet, "rendezvous-token", "mint");
const [wallet1] = [...simnet.getAccounts().values()];

const arb = strategyFor(simnet, mint, [wallet1]);
// Every generated `recipient` is wallet1.
```

`projectTraitImplementations` can be overridden the same way, which is useful when you already have the trait map computed and want to avoid re-extracting it on each call.

## Custom Generators

The default generators know only each argument's Clarity type. When a function accepts a narrower domain (for example, an amount between 2 and 10), calls with values outside it only exercise the rejection path. Pass `options` to `strategyFor` to replace the generator for a named argument, or for every argument of a given type:

```ts
import {
  getContractFunction,
  sampleClarityGenerator,
  strategyFor,
} from "@stacks/rendezvous";
import { uintCV } from "@stacks/transactions";
import fc from "fast-check";

const add = getContractFunction(simnet, "counter", "add");
const arb = strategyFor(simnet, add, undefined, undefined, {
  arguments: {
    n: {
      arbitrary: fc.bigInt({ min: 2n, max: 10n }).map(uintCV),
      sampler: sampleClarityGenerator,
    },
  },
});
```

`StrategyOptions` has three optional fields:

| Field        | Type                                               | Description                                                                                        |
| ------------ | -------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `arguments`  | `Record<string, ClarityGenerator>`                 | Generators keyed by argument name. They take precedence over `types`.                              |
| `types`      | `Partial<Record<GeneratorType, ClarityGenerator>>` | Generators keyed by top-level argument type.                                                       |
| `validation` | `{ seed?: number; numRuns?: number }`              | Preflight sampling parameters. Defaults to seed `0` and `100` samples; `numRuns` must be 1–10,000. |

A `ClarityGenerator` is `{ arbitrary, sampler }`:

- `arbitrary` is a fast-check arbitrary that produces `ClarityValue`s (for example, built with `Cl.*` or `uintCV`). Values are passed to the contract as they are, without further conversion.
- `sampler` receives that arbitrary and `{ seed, numRuns }`, and must return exactly `numRuns` values drawn from it. `sampleClarityGenerator` does this with `fc.sample`; a custom sampler can add domain-specific checks.

The `types` keys use the contract interface names: `int128`, `uint128`, `bool`, `principal`, `buffer`, `string-ascii`, `string-utf8`, `list`, `tuple`, `optional`, `response` and `trait_reference`. A type generator replaces whole top-level arguments of that type, regardless of their declared length; it does not replace fields nested inside a tuple, list, optional or response. To constrain a nested field, supply a generator for the whole argument.

Generators are checked before they are used:

- Unknown option keys, argument names and type names throw a `GeneratorValidationError`.
- When `strategyFor` is called, each selected generator's sampler is run once with the `validation` parameters. A sampler that throws or returns the wrong number of values, or a value that does not match the argument's type and bounds, throws a `GeneratorValidationError`. Generators that the function does not use are not sampled. Preflight uses its own seed and does not call the simnet.
- Every value produced later, including shrink candidates, is checked against the argument's type and bounds before your property receives it. An invalid value throws a `GeneratorValidationError` out of `fc.assert`.

Treat a `GeneratorValidationError` as an error in the test setup, not as a contract failure. The checks cover the Clarity type, integer range, length limits, tuple fields and, for trait references, that the contract implements the trait. They do not check business rules, and a finite preflight cannot prove that a generator never throws. Keep generators and samplers deterministic so that seeds stay reproducible.

Arbitraries created by a different copy of fast-check, such as its ESM build while Rendezvous loads the CommonJS one, are accepted.

Without custom generators (no `options`, or no `arguments` and no `types` entries), `strategyFor` uses the default generators and produces the same values for a given seed as before. The `rv` CLI does not use custom generators.

## Supported Clarity Types

| Clarity Type      | Generated As                                     |
| ----------------- | ------------------------------------------------ |
| `uint`            | Natural numbers                                  |
| `int`             | Integers                                         |
| `bool`            | Booleans                                         |
| `principal`       | Random address from simnet accounts              |
| `buff`            | Hex-encoded buffers (respects max length)        |
| `string-ascii`    | ASCII strings (respects max length)              |
| `string-utf8`     | UTF-8 strings (respects max length)              |
| `list`            | Arrays of the element type (recursive)           |
| `tuple`           | Records with named fields (recursive)            |
| `optional`        | `none` or `some` of the wrapped type (recursive) |
| `response`        | `ok` or `error` branch (recursive)               |
| `trait_reference` | Random contract implementing the trait           |
