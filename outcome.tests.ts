import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";

import { initSimnet } from "@stacks/clarinet-sdk";

import { checkInvariants } from "./invariant";
import * as persistence from "./persistence";
import { checkProperties } from "./property";
import { getFunctionsFromContractInterfaces } from "./shared";

const originalExitCode = process.exitCode;
afterEach(() => {
  process.exitCode = originalExitCode;
  vi.restoreAllMocks();
});

/**
 * Runs Rendezvous against a single contract in a temporary Clarinet project
 * without requirements and returns the logs, exit code and the number of
 * persisted failures.
 */
const run = async (source: string, type: "test" | "invariant" = "test") => {
  const directory = mkdtempSync(join(tmpdir(), "rendezvous-test-outcome-"));
  mkdirSync(join(directory, "settings"));
  writeFileSync(
    join(directory, "Clarinet.toml"),
    `[project]
name = 'outcome'
telemetry = false
[contracts.fixture]
path = 'fixture.clar'
clarity_version = 3
epoch = 3.0
`,
  );
  writeFileSync(join(directory, "fixture.clar"), source);
  writeFileSync(
    join(directory, "settings/Devnet.toml"),
    `[network]
name = "devnet"
[accounts.deployer]
mnemonic = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about"
balance = 100000000000000
`,
  );
  const logs: string[] = [];
  const radio = new EventEmitter();
  for (const event of ["logMessage", "logFailure", "logInfo"]) {
    radio.on(event, (message: string) => logs.push(message));
  }
  process.exitCode = 0;
  // Keep failing runs from writing regression files to the working directory.
  const persist = vi
    .spyOn(persistence, "persistFailure")
    .mockImplementation(() => {});
  const manifestPath = join(directory, "Clarinet.toml");
  try {
    const simnet = await initSimnet(manifestPath);
    const contractId = `${simnet.deployer}.fixture`;
    const functions = getFunctionsFromContractInterfaces(
      new Map([[contractId, simnet.getContractsInterfaces().get(contractId)!]]),
    );
    const accounts = new Map([["deployer", simnet.deployer]]);
    const resetSession = async () => {
      await initSimnet(manifestPath);
    };
    if (type === "test") {
      await checkProperties(
        simnet,
        resetSession,
        [contractId],
        functions,
        17,
        20,
        true,
        false,
        radio,
        accounts,
        [simnet.deployer],
      );
    } else {
      await checkInvariants(
        simnet,
        resetSession,
        [contractId],
        functions,
        17,
        20,
        undefined,
        true,
        false,
        radio,
        accounts,
        [simnet.deployer],
      );
    }
    return {
      logs: stripVTControlCharacters(logs.join("\n")),
      exitCode: process.exitCode,
      persisted: persist.mock.calls.length,
    };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
};

describe("Property testing outcomes", () => {
  it.each([
    ["in-place discards", "(define-private (test-discard) (ok false))"],
    [
      "a discard function",
      "(define-read-only (can-test-discard) false) (define-private (test-discard) (err u1))",
    ],
  ])(
    "does not report a test as passed when %s skip every case",
    async (_, source) => {
      const result = await run(source);
      expect(result.exitCode).toBe(0);
      expect(result.logs).toContain(
        "Warning: not checked after 20 runs: test-discard.",
      );
      expect(result.logs).not.toContain("properties passed");
      expect(result.persisted).toBe(0);
    },
  );

  it("does not let a passing test hide an unchecked test", async () => {
    const result = await run(
      "(define-private (test-pass) (ok true)) (define-private (test-discard) (ok false))",
    );
    expect(result.exitCode).toBe(0);
    expect(result.logs).toContain(
      "Warning: not checked after 20 runs: test-discard.",
    );
    expect(result.logs).not.toContain("properties passed");
  });

  it("reports passing tests as passed", async () => {
    const result = await run("(define-private (test-pass) (ok true))");
    expect(result.exitCode).toBe(0);
    expect(result.logs).toContain("OK, properties passed after 20 runs.");
    expect(result.logs).not.toContain("Warning: not checked");
  });

  it.each([
    ["an error result", "(define-private (test-fail) (err u1))"],
    [
      "a runtime error in the test",
      "(define-private (test-fail) (ok (/ u1 u0)))",
    ],
    [
      "a runtime error in the discard function",
      "(define-read-only (can-test-fail) (is-eq (/ u1 u0) u0)) (define-private (test-fail) (ok true))",
    ],
  ])("counts %s as a single failure when bailing", async (_, source) => {
    const result = await run(source);
    expect(result.exitCode).toBe(1);
    expect(result.logs).toMatch(/FAILED[\s│└─]*test-fail: x1/);
    expect(result.persisted).toBe(1);
  });
});

const context = `(define-map context (string-ascii 100) uint)
(define-private (update-context (name (string-ascii 100)) (calls uint)) (ok (map-set context name calls)))`;

describe("Invariant testing outcomes", () => {
  it.each([
    ["a false result", "(define-read-only (invariant-fail) false)"],
    [
      "a runtime error",
      "(define-read-only (invariant-fail) (is-eq (/ u1 u0) u0))",
    ],
  ])(
    "counts %s as a single invariant failure when bailing",
    async (_, invariant) => {
      const result = await run(
        `${context} (define-public (touch) (ok true)) ${invariant}`,
        "invariant",
      );
      expect(result.exitCode).toBe(1);
      expect(result.logs).toMatch(/FAILED[\s│└─]*invariant-fail: x1/);
    },
  );

  it("counts public function runtime errors as ignored calls", async () => {
    const result = await run(
      `${context} (define-public (touch) (ok (/ u1 u0))) (define-read-only (invariant-pass) true)`,
      "invariant",
    );
    expect(result.exitCode).toBe(0);
    expect(result.logs).toMatch(/IGNORED[\s│└─]*touch: x[1-9]/);
    expect(result.logs).toContain("OK, invariants passed after 20 runs.");
  });
});
