import type { EventEmitter } from "node:events";
import { parseArgs } from "node:util";

import {
  loadConfig,
  type AccountsMode,
  type ConfigAccount,
  type RendezvousConfig,
} from "./config";
import { version } from "./package.json";
import { LOG_DIVIDER } from "./shared";

export const helpMessage = `
  rv v${version}

  Usage: rv <path> <contract> <type> [pattern] [OPTIONS]

  Arguments:
    <path>        Path to the Clarinet project
    <contract>    Contract name to fuzz
    <type>        Test type: test | invariant
    [pattern]     Only run matching tests or invariants (* and ?)

  Options:
    --config=<f>  Path to config file (JSON)
    --seed=<n>    Seed for replay functionality
    --runs=<n>    Number of test iterations [default: 100]
    --dial=<f>    Path to custom dialers file
    --regr        Run regression tests only
    --bail        Stop on first failure
    -h, --help    Show this message

  Learn more: https://stx-labs.github.io/rendezvous/
  `;

/**
 * The resolved run configuration, ready to use.
 */
export interface RunConfig {
  manifestDir: string;
  sutContractName: string;
  type: "test" | "invariant";
  pattern: string | undefined;
  seed: number | undefined;
  runs: number | undefined;
  bail: boolean;
  regr: boolean;
  dial: string | undefined;
  accounts: ConfigAccount[] | undefined;
  accountsMode: AccountsMode;
  configPath: string | undefined;
  warnings: string[];
}

/**
 * Parses CLI arguments into a `RunConfig`.
 *
 * If `--config` is provided, all run options come from the config file
 * exclusively. Otherwise, all run options come from CLI flags exclusively.
 * The two sources are never merged.
 *
 * Returns `undefined` for `--help` (clean exit).
 * Throws on invalid arguments or config errors.
 */
export const parseCli = (argv: string[]): RunConfig | undefined => {
  const { positionals: positionalArgs, values: options } = parseArgs({
    allowPositionals: true,
    args: argv,
    options: {
      config: { type: "string" },
      seed: { type: "string" },
      runs: { type: "string" },
      dial: { type: "string" },
      bail: { type: "boolean" },
      regr: { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });

  if (options.help) {
    return undefined;
  }

  // Load config file if provided.
  let fileConfig: RendezvousConfig = {};
  const configWarnings: string[] = [];
  if (options.config) {
    const result = loadConfig(options.config);
    fileConfig = result.config;

    if (result.unknownKeys.length > 0) {
      configWarnings.push(
        `Warning: unrecognized config keys: ${result.unknownKeys.join(", ")}.`,
      );
    }
  }

  const [manifestDir, sutContractName, type, pattern, ...extraArgs] =
    positionalArgs;

  if (!manifestDir) {
    throw new Error(
      "No path to Clarinet project provided. Supply it immediately or face the relentless scrutiny of your contract's vulnerabilities.",
    );
  }

  if (!sutContractName) {
    throw new Error(
      "No target contract name provided. Please provide the contract name to be fuzzed.",
    );
  }

  const normalizedType = type?.toLowerCase();
  if (!normalizedType || !["test", "invariant"].includes(normalizedType)) {
    throw new Error(
      "Invalid type provided. Please provide the type of test to be executed. Possible values: test, invariant.",
    );
  }

  if (extraArgs.length > 0) {
    throw new Error(
      `Unexpected argument: "${extraArgs[0]}". Only one pattern is supported. Quote the pattern so the shell does not expand it.`,
    );
  }

  // If a config file is provided, use its values exclusively.
  // Otherwise, use CLI options.
  if (options.config) {
    const ignoredFlags = [
      options.seed && "--seed",
      options.runs && "--runs",
      options.bail && "--bail",
      options.regr && "--regr",
      options.dial && "--dial",
    ].filter(Boolean) as string[];

    if (ignoredFlags.length > 0) {
      configWarnings.push(
        `Warning: ${ignoredFlags.join(", ")} ignored when --config is used.`,
      );
    }

    checkPatternWithRegr(pattern, fileConfig.regr);

    return {
      manifestDir,
      sutContractName,
      type: normalizedType as "test" | "invariant",
      pattern,
      seed: fileConfig.seed,
      runs: fileConfig.runs,
      bail: fileConfig.bail ?? false,
      regr: fileConfig.regr ?? false,
      dial: fileConfig.dial,
      accounts: fileConfig.accounts,
      accountsMode: fileConfig.accounts_mode ?? "overwrite",
      configPath: options.config,
      warnings: configWarnings,
    };
  }

  const seed = options.seed ? parseInt(options.seed, 10) : undefined;
  if (seed !== undefined && (!Number.isInteger(seed) || isNaN(seed))) {
    throw new Error(`"seed" must be an integer. Got: "${options.seed}".`);
  }

  const runs = options.runs ? parseInt(options.runs, 10) : undefined;
  if (runs !== undefined && (!Number.isInteger(runs) || runs < 1)) {
    throw new Error(
      `"runs" must be a positive integer. Got: "${options.runs}".`,
    );
  }

  checkPatternWithRegr(pattern, options.regr);

  return {
    manifestDir,
    sutContractName,
    type: normalizedType as "test" | "invariant",
    pattern,
    seed,
    runs,
    bail: options.bail ?? false,
    regr: options.regr ?? false,
    dial: options.dial,
    accounts: undefined,
    accountsMode: "overwrite",
    configPath: undefined,
    warnings: [],
  };
};

/**
 * Saved regressions are replayed with the pattern they were found with, so
 * a new pattern cannot be combined with them.
 */
const checkPatternWithRegr = (
  pattern: string | undefined,
  regr: boolean | undefined,
) => {
  if (pattern !== undefined && regr) {
    throw new Error(
      "A pattern cannot be used with regression tests. Saved regressions are replayed with the pattern they were found with.",
    );
  }
};

/**
 * Emits the run configuration summary to the radio.
 */
export const logRunConfig = (
  radio: EventEmitter,
  config: RunConfig,
  manifestPath: string,
) => {
  radio.emit("logMessage", LOG_DIVIDER);
  radio.emit("logMessage", `Using manifest path: ${manifestPath}`);
  radio.emit("logMessage", `Target contract: ${config.sutContractName}`);

  if (config.pattern !== undefined) {
    radio.emit("logMessage", `Using pattern: ${config.pattern}`);
  }
  if (config.seed !== undefined) {
    radio.emit("logMessage", `Using seed: ${config.seed}`);
  }
  if (config.runs !== undefined) {
    radio.emit("logMessage", `Using runs: ${config.runs}`);
  }
  if (config.bail) {
    radio.emit("logMessage", `Bailing on first failure.`);
  }
  if (config.regr) {
    radio.emit("logMessage", `Running regression tests.`);
  }
  if (config.dial !== undefined) {
    radio.emit("logMessage", `Using dial path: ${config.dial}`);
  }
  if (config.configPath) {
    radio.emit("logMessage", `Using config file: ${config.configPath}`);
  }
  if (config.accounts !== undefined && config.accounts.length > 0) {
    radio.emit(
      "logMessage",
      `Custom accounts: ${config.accounts.length} (mode: ${config.accountsMode})`,
    );
  }

  radio.emit("logMessage", LOG_DIVIDER + "\n");
};

export const logWarnings = (radio: EventEmitter, warnings: string[]) => {
  for (const warning of warnings) {
    radio.emit("logInfo", warning);
  }
};
