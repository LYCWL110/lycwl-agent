import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createProcessSupervisor } from "../../src/adapters/platform-process.ts";
import { buildEnvironmentBlock } from "../../src/adapters/windows/koffi-bindings.ts";
import { FIXED_FILTERED_NAMES, filterChildEnvironment } from "../../src/domain/process/shell.ts";
import { shellCommands } from "../fakes/shell-commands.ts";

/**
 * C09 environment filter: the child must not inherit the parent environment.
 *
 * These tests exist because the filter was previously computed and then
 * discarded: `CreateProcessW` was called with `lpEnvironment = null`, which
 * means "inherit everything". The supervisor now requires an explicit
 * environment, so the failure is a type error rather than a silent leak.
 */

const CWD = process.cwd();
const BASE_ENV: Readonly<Record<string, string>> = {
  PATH: process.env["PATH"] ?? "",
  SYSTEMROOT: process.env["SYSTEMROOT"] ?? "",
  COMSPEC: process.env["COMSPEC"] ?? "",
};

const supervisor = createProcessSupervisor();

describe("environment block encoding", () => {
  it("terminates with a double NUL and encodes as UTF-16LE", () => {
    const block = buildEnvironmentBlock({ B: "2", A: "1" });
    const text = block.toString("utf16le");
    // Sorted, NUL-separated, then one extra NUL.
    assert.equal(text, "A=1\u0000B=2\u0000\u0000");
    assert.equal(block.length, text.length * 2);
  });

  it("still terminates an empty environment", () => {
    const block = buildEnvironmentBlock({});
    assert.equal(block.toString("utf16le"), "\u0000\u0000");
  });

  it("sorts case-insensitively as Windows expects", () => {
    const block = buildEnvironmentBlock({ beta: "1", Alpha: "2", gamma: "3" });
    const names = block
      .toString("utf16le")
      .split("\u0000")
      .filter((entry) => entry.length > 0)
      .map((entry) => entry.split("=")[0]);
    assert.deepEqual(names, ["Alpha", "beta", "gamma"]);
  });
});

describe("child processes cannot inherit parent credentials", () => {
  it("removes a fixed filtered name from the child environment", async () => {
    const inherited = {
      ...BASE_ENV,
      // One real name from the fixed baseline.
      ANTHROPIC_API_KEY: "sk-ant-should-not-reach-the-child",
      KEEPME: "visible",
    };
    const filter = filterChildEnvironment(inherited);

    assert.equal(filter.environment["ANTHROPIC_API_KEY"], undefined);
    assert.ok(filter.removedNames.includes("ANTHROPIC_API_KEY"));

    const result = await supervisor.runToCompletion({
      // `set` with no match must not print a "not defined" message to stdout.
      command: shellCommands.readEnvironmentVariable("ANTHROPIC_API_KEY"),
      cwd: CWD,
      timeoutMs: 15_000,
      environment: filter.environment,
    });

    assert.equal(result.kind, "completed");
    if (result.kind !== "completed") return;
    // Non-zero exit: `set NAME` returns 1 when the variable is undefined.
    assert.equal(result.stdout.includes("sk-ant-should-not-reach-the-child"), false);
    assert.equal(result.stdout.includes("ANTHROPIC_API_KEY="), false);
  });

  it("keeps a non-filtered variable intact", async () => {
    const filter = filterChildEnvironment({ ...BASE_ENV, KEEPME: "visible-value" });
    const result = await supervisor.runToCompletion({
      command: shellCommands.readEnvironmentVariable("KEEPME"),
      cwd: CWD,
      timeoutMs: 15_000,
      environment: filter.environment,
    });

    assert.equal(result.kind, "completed");
    if (result.kind !== "completed") return;
    assert.match(result.stdout, /visible-value/);
  });

  it("does not inherit a credential that was never passed in", async () => {
    // The parent test process may or may not have this variable; force it here so
    // the assertion is meaningful in both cases.
    const marker = "lycwl-inherit-canary-value";
    const inherited = { ...BASE_ENV, LYCWL_CANARY_SECRET: marker };
    const filter = filterChildEnvironment(
      inherited,
      {},
      {
        // Model a catalog-derived name being filtered without changing the fixed list.
        providerCredentialNames: ["LYCWL_CANARY_SECRET"],
      },
    );
    assert.equal(filter.environment["LYCWL_CANARY_SECRET"], undefined);

    const result = await supervisor.runToCompletion({
      command: shellCommands.readEnvironmentVariable("LYCWL_CANARY_SECRET"),
      cwd: CWD,
      timeoutMs: 15_000,
      environment: filter.environment,
    });

    assert.equal(result.kind, "completed");
    if (result.kind !== "completed") return;
    // An omitted variable produces no credential value.
    assert.equal(result.stdout.includes(marker), false);
  });

  it("honours an explicit one-shot grant for a filtered name", async () => {
    const filter = filterChildEnvironment(
      { ...BASE_ENV, ANTHROPIC_API_KEY: "granted-value" },
      {},
      { grantedNames: ["ANTHROPIC_API_KEY"] },
    );
    const result = await supervisor.runToCompletion({
      command: shellCommands.readEnvironmentVariable("ANTHROPIC_API_KEY"),
      cwd: CWD,
      timeoutMs: 15_000,
      environment: filter.environment,
    });

    assert.equal(result.kind, "completed");
    if (result.kind !== "completed") return;
    assert.match(result.stdout, /granted-value/);
  });

  it("filters the INPUT_ counterpart of a fixed name", async () => {
    const filter = filterChildEnvironment({
      ...BASE_ENV,
      INPUT_ANTHROPIC_API_KEY: "should-be-removed",
    });
    assert.equal(filter.environment["INPUT_ANTHROPIC_API_KEY"], undefined);
  });

  it("covers every fixed name when the parent has all of them set", () => {
    const inherited: Record<string, string> = { ...BASE_ENV };
    for (const name of FIXED_FILTERED_NAMES) inherited[name] = "x";
    const filter = filterChildEnvironment(inherited);
    for (const name of FIXED_FILTERED_NAMES) {
      assert.equal(filter.environment[name], undefined, `${name} must not survive the filter`);
    }
  });
});
