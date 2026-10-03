import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { stripVTControlCharacters } from "node:util";

import { red } from "ansicolor";

import { getManifestFileName, main } from "./app";
import { helpMessage } from "./cli";
import { getFailureFilePath } from "./persistence";
import { LOG_DIVIDER } from "./shared";
import { createIsolatedTestEnvironment } from "./test.utils";

const isolatedTestEnvPrefix = "rendezvous-test-app-";

describe("Command-line arguments handling", () => {
  const initialArgv = process.argv;

  const noManifestMessage = red(
    `\nNo path to Clarinet project provided. Supply it immediately or face the relentless scrutiny of your contract's vulnerabilities.`,
  );
  const noContractNameMessage = red(
    `\nNo target contract name provided. Please provide the contract name to be fuzzed.`,
  );
  const manifestDirPlaceholder = "isolated-example";

  it("returns cleanly when --help is specified", async () => {
    // Arrange
    process.argv = ["node", "app.js", "--help"];
    const consoleLogs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((message: string) => {
      consoleLogs.push(message);
    });

    // Act
    await main();

    // Assert
    expect(consoleLogs).toContain(helpMessage);

    // Teardown
    process.argv = initialArgv;
    vi.restoreAllMocks();
  });

  it.each([
    ["manifest path", ["node", "app.js"]],
    ["target contract name", ["node", "app.js", "./path/to/clarinet/project"]],
  ])(
    "exits with code 1 when %s is not provided",
    async (_testCase: string, argv: string[]) => {
      // Arrange
      process.argv = argv;
      const mockExit = vi.spyOn(process, "exit").mockImplementation(((
        _code?: number,
      ) => {
        throw new Error("process.exit");
      }) as () => never);

      // Act & Assert
      await expect(main()).rejects.toThrow("process.exit");
      expect(mockExit).toHaveBeenCalledWith(1);

      // Teardown
      process.argv = initialArgv;
      vi.restoreAllMocks();
    },
  );

  it.each([
    ["manifest path", ["node", "app.js"], noManifestMessage],
    [
      "target contract name",
      ["node", "app.js", "./path/to/clarinet/project"],
      noContractNameMessage,
    ],
  ])(
    "logs the error and help message when the %s is not provided",
    async (_testCase: string, argv: string[], expectedError: string) => {
      // Arrange
      process.argv = argv;
      const consoleLogs: string[] = [];
      const consoleErrors: string[] = [];
      vi.spyOn(console, "log").mockImplementation((message: string) => {
        consoleLogs.push(message);
      });
      vi.spyOn(console, "error").mockImplementation((message: string) => {
        consoleErrors.push(message);
      });
      vi.spyOn(process, "exit").mockImplementation(((_code?: number) => {
        throw new Error("process.exit");
      }) as () => never);

      // Act
      await expect(main()).rejects.toThrow("process.exit");

      // Assert
      expect(consoleErrors).toContain(expectedError);
      expect(consoleLogs).toContain(helpMessage);

      // Teardown
      process.argv = initialArgv;
      vi.restoreAllMocks();
    },
  );

  it.each([
    [
      ["no command-line arguments"],
      ["node", "app.js"],
      [noManifestMessage, helpMessage],
    ],
    [
      ["manifest path"],
      ["node", "app.js", manifestDirPlaceholder],
      [noContractNameMessage, helpMessage],
    ],
    [
      ["manifest path", "contract name"],
      ["node", "app.js", manifestDirPlaceholder, "counter"],
      [
        red(
          `\nInvalid type provided. Please provide the type of test to be executed. Possible values: test, invariant.`,
        ),
        helpMessage,
      ],
    ],
    [
      ["manifest path", "contract name", "seed", "bail"],
      ["node", "app.js", manifestDirPlaceholder, "counter", "--bail"],
      [
        red(
          `\nInvalid type provided. Please provide the type of test to be executed. Possible values: test, invariant.`,
        ),
        helpMessage,
      ],
    ],
    [
      ["manifest path", "contract name", "seed"],
      ["node", "app.js", manifestDirPlaceholder, "counter", "--seed=123"],
      [
        red(
          `\nInvalid type provided. Please provide the type of test to be executed. Possible values: test, invariant.`,
        ),
        helpMessage,
      ],
    ],
    [
      ["manifest path", "contract name", "runs"],
      ["node", "app.js", manifestDirPlaceholder, "counter", "--runs=10"],
      [
        red(
          `\nInvalid type provided. Please provide the type of test to be executed. Possible values: test, invariant.`,
        ),
        helpMessage,
      ],
    ],
    [
      ["manifest path", "contract name", "seed", "runs"],
      [
        "node",
        "app.js",
        manifestDirPlaceholder,
        "counter",
        "--seed=123",
        "--runs=10",
      ],
      [
        red(
          `\nInvalid type provided. Please provide the type of test to be executed. Possible values: test, invariant.`,
        ),
        helpMessage,
      ],
    ],
    [
      ["manifest path", "contract name", "type=invariant"],
      ["node", "app.js", manifestDirPlaceholder, "counter", "invariant"],
      [
        LOG_DIVIDER,
        `Using manifest path: ${manifestDirPlaceholder}/Clarinet.toml`,
        `Target contract: counter`,
        LOG_DIVIDER,
      ],
    ],

    [
      ["manifest path", "contract name", "type=InVaRiAnT (case-insensitive)"],
      ["node", "app.js", manifestDirPlaceholder, "counter", "InVaRiAnT"],
      [
        LOG_DIVIDER,
        `Using manifest path: ${manifestDirPlaceholder}/Clarinet.toml`,
        `Target contract: counter`,
        LOG_DIVIDER,
      ],
    ],
    [
      ["manifest path", "contract name", "type=invariant", "regr"],
      [
        "node",
        "app.js",
        manifestDirPlaceholder,
        "counter",
        "invariant",
        "--regr",
      ],
      [
        LOG_DIVIDER,
        `Using manifest path: ${manifestDirPlaceholder}/Clarinet.toml`,
        `Target contract: counter`,
        `Running regression tests.`,
        `Regressions loaded from: ${resolve(getFailureFilePath("ST1PQHQKV0RJXZFY1DGX8MNSNYVE3VGZJSRTPGZGM.counter"))}`,
        LOG_DIVIDER,
      ],
    ],
    [
      ["manifest path", "contract name", "type=invariant", "bail"],
      [
        "node",
        "app.js",
        manifestDirPlaceholder,
        "counter",
        "invariant",
        "--bail",
      ],
      [
        LOG_DIVIDER,
        `Using manifest path: ${manifestDirPlaceholder}/Clarinet.toml`,
        `Target contract: counter`,
        `Bailing on first failure.`,
        LOG_DIVIDER,
      ],
    ],
    [
      ["manifest path", "contract name", "type=invariant", "dialers file path"],
      [
        "node",
        "app.js",
        manifestDirPlaceholder,
        "counter",
        "invariant",
        "--dial=example/sip010.cjs",
      ],
      [
        LOG_DIVIDER,
        `Using manifest path: ${manifestDirPlaceholder}/Clarinet.toml`,
        `Target contract: counter`,
        `Using dial path: example/sip010.cjs`,
        LOG_DIVIDER,
      ],
    ],
    [
      ["manifest path", "contract name", "type=test"],
      ["node", "app.js", manifestDirPlaceholder, "counter", "test"],
      [
        LOG_DIVIDER,
        `Using manifest path: ${manifestDirPlaceholder}/Clarinet.toml`,
        `Target contract: counter`,
        LOG_DIVIDER,
      ],
    ],
    [
      ["manifest path", "contract name", "type=tESt (case-insensitive)"],
      ["node", "app.js", manifestDirPlaceholder, "counter", "tESt"],
      [
        LOG_DIVIDER,
        `Using manifest path: ${manifestDirPlaceholder}/Clarinet.toml`,
        `Target contract: counter`,
        LOG_DIVIDER,
      ],
    ],
    [
      ["manifest path", "contract name", "type=test", "regr"],
      ["node", "app.js", manifestDirPlaceholder, "counter", "test", "--regr"],
      [
        LOG_DIVIDER,
        `Using manifest path: ${manifestDirPlaceholder}/Clarinet.toml`,
        `Target contract: counter`,
        `Running regression tests.`,
        `Regressions loaded from: ${resolve(getFailureFilePath("ST1PQHQKV0RJXZFY1DGX8MNSNYVE3VGZJSRTPGZGM.counter"))}`,
        LOG_DIVIDER,
      ],
    ],
    [
      ["manifest path", "contract name", "type=test", "bail"],
      ["node", "app.js", manifestDirPlaceholder, "counter", "test", "--bail"],
      [
        LOG_DIVIDER,
        `Using manifest path: ${manifestDirPlaceholder}/Clarinet.toml`,
        `Target contract: counter`,
        `Bailing on first failure.`,
        LOG_DIVIDER,
      ],
    ],
    [
      ["manifest path", "contract name", "type=invariant", "seed"],
      [
        "node",
        "app.js",
        manifestDirPlaceholder,
        "counter",
        "invariant",
        "--seed=123",
      ],
      [
        LOG_DIVIDER,
        `Using manifest path: ${manifestDirPlaceholder}/Clarinet.toml`,
        `Target contract: counter`,
        `Using seed: 123`,
        LOG_DIVIDER,
      ],
    ],
    [
      [
        "manifest path",
        "contract name",
        "type=invARiaNT (case-insensitive)",
        "seed",
      ],
      [
        "node",
        "app.js",
        manifestDirPlaceholder,
        "counter",
        "invARiaNT",
        "--seed=123",
      ],
      [
        LOG_DIVIDER,
        `Using manifest path: ${manifestDirPlaceholder}/Clarinet.toml`,
        `Target contract: counter`,
        `Using seed: 123`,
        LOG_DIVIDER,
      ],
    ],
    [
      ["manifest path", "contract name", "type=test", "seed"],
      [
        "node",
        "app.js",
        manifestDirPlaceholder,
        "counter",
        "test",
        "--seed=123",
      ],
      [
        LOG_DIVIDER,
        `Using manifest path: ${manifestDirPlaceholder}/Clarinet.toml`,
        `Target contract: counter`,
        `Using seed: 123`,
        LOG_DIVIDER,
      ],
    ],
    [
      ["manifest path", "contract name = reverse", "type=test", "seed"],
      [
        "node",
        "app.js",
        manifestDirPlaceholder,
        "reverse",
        "test",
        "--seed=123",
      ],
      [
        LOG_DIVIDER,
        `Using manifest path: ${manifestDirPlaceholder}/Clarinet.toml`,
        `Target contract: reverse`,
        `Using seed: 123`,
        LOG_DIVIDER,
      ],
    ],
    [
      ["manifest path", "contract name = slice", "type=test", "seed"],
      ["node", "app.js", manifestDirPlaceholder, "slice", "test", "--seed=123"],
      [
        LOG_DIVIDER,
        `Using manifest path: ${manifestDirPlaceholder}/Clarinet.toml`,
        `Target contract: slice`,
        `Using seed: 123`,
        LOG_DIVIDER,
      ],
    ],
    [
      [
        "manifest path",
        "contract name",
        "type=teSt (case-insensitive)",
        "seed",
      ],
      [
        "node",
        "app.js",
        manifestDirPlaceholder,
        "counter",
        "teSt",
        "--seed=123",
      ],
      [
        LOG_DIVIDER,
        `Using manifest path: ${manifestDirPlaceholder}/Clarinet.toml`,
        `Target contract: counter`,
        `Using seed: 123`,
        LOG_DIVIDER,
      ],
    ],
    [
      ["manifest path", "contract name", "type=test", "seed", "runs", "bail"],
      [
        "node",
        "app.js",
        manifestDirPlaceholder,
        "counter",
        "test",
        "--seed=123",
        "--runs=10",
        "--bail",
      ],
      [
        LOG_DIVIDER,
        `Using manifest path: ${manifestDirPlaceholder}/Clarinet.toml`,
        `Target contract: counter`,
        `Using seed: 123`,
        `Using runs: 10`,
        `Bailing on first failure.`,
        LOG_DIVIDER,
      ],
    ],
    [
      [
        "manifest path",
        "contract name",
        "type=invariant",
        "seed",
        "runs",
        "bail",
      ],
      [
        "node",
        "app.js",
        manifestDirPlaceholder,
        "counter",
        "invariant",
        "--seed=123",
        "--runs=10",
        "--bail",
      ],
      [
        LOG_DIVIDER,
        `Using manifest path: ${manifestDirPlaceholder}/Clarinet.toml`,
        `Target contract: counter`,
        `Using seed: 123`,
        `Using runs: 10`,
        `Bailing on first failure.`,
        LOG_DIVIDER,
      ],
    ],
  ])(
    "prints the correct logs when arguments %p are provided",
    async (_testCase: string[], argv: string[], expectedLogs: string[]) => {
      // Setup
      const tempDir = createIsolatedTestEnvironment(
        resolve(__dirname, "example"),
        isolatedTestEnvPrefix,
      );

      // Update argv to use the isolated test environment.
      const updatedArgv = argv.map((arg) =>
        arg === manifestDirPlaceholder ? tempDir : arg,
      );
      process.argv = updatedArgv;

      const allLogs: string[] = [];
      vi.spyOn(console, "log").mockImplementation((message: string) => {
        allLogs.push(message);
      });
      vi.spyOn(console, "error").mockImplementation((message: string) => {
        allLogs.push(message);
      });
      vi.spyOn(process, "exit").mockImplementation(((_code?: number) => {
        throw new Error("process.exit");
      }) as () => never);

      // Exercise
      try {
        await main();
      } catch {
        // Do nothing.
      }

      // Verify
      expectedLogs.forEach((expectedLog) => {
        // Update expected log to use the isolated test environment path.
        const updatedExpectedLog = expectedLog.startsWith(
          "Using manifest path:",
        )
          ? expectedLog.replace(manifestDirPlaceholder, tempDir)
          : expectedLog;

        expect(allLogs).toContain(updatedExpectedLog);
      });

      // Teardown
      process.argv = initialArgv;
      vi.restoreAllMocks();
      rmSync(tempDir, { recursive: true, force: true });
    },
  );
});

describe("Contract selection", () => {
  const initialArgv = process.argv;

  it("logs an error when the contract is not found among project contracts", async () => {
    // Setup
    const tempDir = createIsolatedTestEnvironment(
      resolve(__dirname, "example"),
      isolatedTestEnvPrefix,
    );
    process.argv = ["node", "app.js", tempDir, "nonexistent", "test"];

    const consoleErrors: string[] = [];
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation((message: string) => {
      consoleErrors.push(message);
    });

    // Exercise
    await main();

    // Verify
    expect(consoleErrors).toContain(
      red(`\nContract "nonexistent" not found among project contracts.\n`),
    );

    // Teardown
    process.argv = initialArgv;
    vi.restoreAllMocks();
    rmSync(tempDir, { recursive: true, force: true });
  });
});

describe("Function name patterns", () => {
  const initialArgv = process.argv;
  const initialCwd = process.cwd();
  const initialExitCode = process.exitCode;
  let project = "";
  let logs: string[] = [];

  /** Runs the CLI in-process and returns the checked function names. */
  const run = async (args: string[]) => {
    logs = [];
    for (const method of ["log", "error"] as const) {
      vi.spyOn(console, method).mockImplementation((message: string) => {
        logs.push(stripVTControlCharacters(String(message)));
      });
    }
    process.argv = ["node", "app.js", project, ...args];
    await main();
    vi.restoreAllMocks();
    const checked = logs.flatMap(
      (log) => log.match(/\[(?:PASS|WARN|FAIL)\] \S+ (\S+)/)?.[1] ?? [],
    );
    return new Set(checked);
  };

  beforeEach(() => {
    project = mkdtempSync(join(tmpdir(), isolatedTestEnvPrefix));
    mkdirSync(join(project, "contracts"));
    cpSync(
      resolve(__dirname, "example", "settings"),
      join(project, "settings"),
      { recursive: true },
    );
    writeFileSync(
      join(project, "Clarinet.toml"),
      `[project]
name = "patterns"
telemetry = false

[contracts.patterns]
path = "contracts/patterns.clar"
clarity_version = 3
epoch = 3.0
`,
    );
    writeFileSync(
      join(project, "contracts", "patterns.clar"),
      `(define-data-var counter uint u0)

(define-map context (string-ascii 100) { called: uint })

(define-private (update-context (function-name (string-ascii 100))
    (called uint))
  (ok (map-set context function-name { called: called })))

(define-public (increment)
  (ok (var-set counter (+ (var-get counter) u1))))

(define-read-only (invariant-holds) true)

(define-read-only (invariant-breaks) false)

(define-private (test-passes) (ok true))

(define-private (test-fails) (err u1))
`,
    );
    // Keep saved regressions inside the temporary project.
    process.chdir(project);
    process.exitCode = undefined;
  });

  afterEach(() => {
    process.chdir(initialCwd);
    process.argv = initialArgv;
    process.exitCode = initialExitCode;
    vi.restoreAllMocks();
    rmSync(project, { recursive: true, force: true });
  });

  it.each([
    ["test", "test-p*", "test-passes"],
    ["invariant", "invariant-h?lds", "invariant-holds"],
  ])(
    "runs only the %s functions matching %s",
    async (type, pattern, expected) => {
      // Act
      const checked = await run(["patterns", type, pattern, "--runs=20"]);

      // Assert
      expect(checked).toEqual(new Set([expected]));
      expect(logs).toContain(`Using pattern: ${pattern}`);
      expect(process.exitCode).toBeUndefined();
    },
  );

  it("keeps all public functions as invariant actions", async () => {
    // Act
    await run(["patterns", "invariant", "invariant-holds", "--runs=20"]);

    // Assert
    expect(logs.some((log) => / patterns increment /.test(log))).toBe(true);
  });

  it.each([
    ["test", "test-nothing*"],
    ["invariant", "invariant-nothing*"],
  ])("fails when no %s function matches", async (type, pattern) => {
    // Act
    const checked = await run(["patterns", type, pattern]);

    // Assert
    expect(checked.size).toBe(0);
    expect(logs).toContain(
      `\nNo ${type} functions match "${pattern}" in the "patterns" contract.\n`,
    );
    expect(process.exitCode).toBe(1);
  });

  it.each([
    ["test", "test-f*", "test-fails"],
    ["invariant", "invariant-b*", "invariant-breaks"],
  ])(
    "replays %s regressions with their saved pattern",
    async (type, pattern, expected) => {
      // Arrange: find and save a failure with a pattern.
      expect(await run(["patterns", type, pattern, "--bail"])).toEqual(
        new Set([expected]),
      );
      expect(process.exitCode).toBe(1);
      process.exitCode = undefined;

      // Act
      const checked = await run(["patterns", type, "--regr"]);

      // Assert
      expect(logs.some((log) => log.includes(`- Pattern: ${pattern}`))).toBe(
        true,
      );
      expect(checked).toEqual(new Set([expected]));
      expect(process.exitCode).toBe(1);
    },
  );
});

describe("Custom manifest detection", () => {
  it("returns the default manifest file name for the example project", () => {
    // Arrange
    const manifestDir = "example";
    const targetContractName = "counter";

    // Act
    const actual = getManifestFileName(manifestDir, targetContractName);

    // Assert
    expect(actual).toBe("Clarinet.toml");
  });

  it("returns the custom manifest file name when it exists", () => {
    // Setup
    const manifestDir = mkdtempSync(join(tmpdir(), isolatedTestEnvPrefix));
    const targetContractName = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
    const expected = `Clarinet-${targetContractName}.toml`;
    writeFileSync(join(manifestDir, expected), "");

    // Exercise
    const actual = getManifestFileName(manifestDir, targetContractName);

    // Verify
    expect(actual).toBe(expected);

    // Teardown
    rmSync(manifestDir, { recursive: true, force: true });
  });
});
