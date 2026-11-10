import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  createShellTool,
  SHELL_DEFINITION,
  SHELL_MODEL_CAP_UNITS,
  type ShellRunOutcome,
  type ShellToolDependencies,
} from "../../src/adapters/tools/shell-tool.ts";
import type { ShellRequest } from "../../src/domain/process/shell.ts";

type Fixture = {
  tool: ReturnType<typeof createShellTool>;
  calls: { request: ShellRequest; environment: Readonly<Record<string, string>> }[];
};

function fixture(
  outcome: ShellRunOutcome = { kind: "completed", exitCode: 0, stdout: "ok\n", stderr: "" },
  overrides: Partial<ShellToolDependencies> = {},
): Fixture {
  const calls: Fixture["calls"] = [];
  const dependencies: ShellToolDependencies = {
    sessionMode: "workspace_write",
    inheritedEnvironment: {
      PATH: "C:\\Windows",
      ANTHROPIC_API_KEY: "sk-secret",
      GITHUB_TOKEN: "gh-secret",
    },
    runShell: async (request, environment) => {
      calls.push({ request, environment });
      return outcome;
    },
    ...overrides,
  };
  return { tool: createShellTool(dependencies), calls };
}

describe("shell tool definition", () => {
  it("is an approval-required process execution", () => {
    const { tool } = fixture();
    assert.deepEqual(tool.getDefinition("shell"), SHELL_DEFINITION);
    assert.equal(SHELL_DEFINITION.requiresApproval, true);
    assert.equal(SHELL_DEFINITION.sideEffectClass, "process_execution");
  });
});

describe("shell execution", () => {
  it("runs with a filtered environment", async () => {
    const f = fixture();
    const result = await f.tool.execute({
      toolCallId: "call-1",
      toolName: "shell",
      arguments: { command: "npm test", cwd: "D:\\repo" },
    });

    assert.equal(result.status, "succeeded");
    assert.equal(f.calls.length, 1);
    assert.deepEqual(f.calls[0]?.environment, { PATH: "C:\\Windows" });
    assert.match(result.text ?? "", /stdout:/);
    assert.match(result.text ?? "", /ok/);
  });

  it("keeps only an explicitly granted credential name", async () => {
    const f = fixture(undefined, {});
    await f.tool.execute({
      toolCallId: "call-1",
      toolName: "shell",
      arguments: {
        command: "npm test",
        cwd: "D:\\repo",
        environmentGrants: ["ANTHROPIC_API_KEY"],
      },
    });

    assert.deepEqual(f.calls[0]?.environment, {
      PATH: "C:\\Windows",
      ANTHROPIC_API_KEY: "sk-secret",
    });
  });

  it("refuses Shell entirely in a read-only Session", async () => {
    const f = fixture(undefined, { sessionMode: "read_only" });
    const result = await f.tool.execute({
      toolCallId: "call-1",
      toolName: "shell",
      arguments: { command: "npm test", cwd: "D:\\repo" },
    });

    assert.deepEqual(result, { status: "failed", safeCode: "read_only_session", text: null });
    assert.equal(f.calls.length, 0);
  });

  it("reports a nonzero exit as a failure without hiding the output", async () => {
    const f = fixture({ kind: "completed", exitCode: 1, stdout: "out", stderr: "bad" });
    const result = await f.tool.execute({
      toolCallId: "call-1",
      toolName: "shell",
      arguments: { command: "false", cwd: "D:\\repo" },
    });

    assert.equal(result.status, "failed");
    if (result.status !== "failed") return;
    assert.equal(result.safeCode, "nonzero_exit");
    assert.match(result.text ?? "", /bad/);
  });

  it("reports a timeout as a failure with partial output", async () => {
    const f = fixture({ kind: "timed_out", stdout: "partial", stderr: "" });
    const result = await f.tool.execute({
      toolCallId: "call-1",
      toolName: "shell",
      arguments: { command: "sleep 999", cwd: "D:\\repo" },
    });

    assert.equal(result.status, "failed");
    if (result.status !== "failed") return;
    assert.equal(result.safeCode, "shell_timeout");
    assert.match(result.text ?? "", /partial/);
  });

  it("reports outcome_unknown when the runner throws", async () => {
    const f = fixture(undefined, {
      runShell: async () => {
        throw new Error("job object failure");
      },
    });
    const result = await f.tool.execute({
      toolCallId: "call-1",
      toolName: "shell",
      arguments: { command: "x", cwd: "D:\\repo" },
    });

    assert.deepEqual(result, {
      status: "outcome_unknown",
      safeCode: "shell_outcome_unknown",
    });
  });

  it("propagates an unknown runner outcome", async () => {
    const f = fixture({ kind: "unknown", safeCode: "process_tree_lost" });
    const result = await f.tool.execute({
      toolCallId: "call-1",
      toolName: "shell",
      arguments: { command: "x", cwd: "D:\\repo" },
    });

    assert.deepEqual(result, { status: "outcome_unknown", safeCode: "process_tree_lost" });
  });

  it("marks evidence incomplete instead of claiming full capture", async () => {
    const huge = "x".repeat(9 * 1024 * 1024);
    const f = fixture({ kind: "completed", exitCode: 0, stdout: huge, stderr: "" });
    const result = await f.tool.execute({
      toolCallId: "call-1",
      toolName: "shell",
      arguments: { command: "big", cwd: "D:\\repo" },
    });

    assert.equal(result.status, "failed");
    if (result.status !== "failed") return;
    assert.equal(result.safeCode, "output_limit_exceeded");
  });

  it("bounds the model-facing text", async () => {
    const long = "y".repeat(SHELL_MODEL_CAP_UNITS + 5_000);
    const f = fixture({ kind: "completed", exitCode: 0, stdout: long, stderr: "" });
    const result = await f.tool.execute({
      toolCallId: "call-1",
      toolName: "shell",
      arguments: { command: "chatty", cwd: "D:\\repo" },
    });

    assert.equal(result.status, "succeeded");
    if (result.status !== "succeeded") return;
    assert.match(result.text ?? "", /\[truncated: model budget\]/);
    assert.equal((result.text ?? "").length < long.length, true);
  });

  it("fails when a requested environment grant does not exist", async () => {
    const f = fixture();
    const result = await f.tool.execute({
      toolCallId: "call-1",
      toolName: "shell",
      arguments: {
        command: "x",
        cwd: "D:\\repo",
        environmentGrants: ["NOT_PRESENT"],
      },
    });

    assert.deepEqual(result, {
      status: "failed",
      safeCode: "environment_grant_missing",
      text: null,
    });
    assert.equal(f.calls.length, 0);
  });

  it("rejects invalid arguments before running anything", async () => {
    const f = fixture();
    for (const args of [
      null,
      {},
      { command: "", cwd: "x" },
      { command: "x", cwd: "x", timeoutMs: 10 },
    ]) {
      const result = await f.tool.execute({
        toolCallId: "call-1",
        toolName: "shell",
        arguments: args,
      });
      assert.equal(result.status, "failed");
    }
    assert.equal(f.calls.length, 0);
  });
});

describe("shell preview", () => {
  it("shows command, cwd, normalized timeout and redacted grant names", async () => {
    const f = fixture();
    const preview = await f.tool.preview?.({
      toolCallId: "call-1",
      toolName: "shell",
      arguments: {
        command: "npm test",
        cwd: "D:\\repo",
        timeoutMs: 30000,
        environmentGrants: ["GITHUB_TOKEN"],
      },
    });

    assert.match(preview ?? "", /command=npm test/);
    assert.match(preview ?? "", /cwd=D:\\repo/);
    assert.match(preview ?? "", /timeoutMs=30000/);
    assert.match(preview ?? "", /envGrants=GITHUB_TOKEN/);
    assert.match(preview ?? "", /filteredEnv=1 name\(s\) removed/);
    assert.match(preview ?? "", /sandbox=none/);
    assert.equal((preview ?? "").includes("sk-secret"), false);
    assert.equal((preview ?? "").includes("gh-secret"), false);
    assert.equal(f.calls.length, 0);
  });

  it("shows the validation failure instead of a preview", async () => {
    const f = fixture(undefined, { sessionMode: "read_only" });
    const preview = await f.tool.preview?.({
      toolCallId: "call-1",
      toolName: "shell",
      arguments: { command: "x", cwd: "D:\\repo" },
    });
    assert.equal(preview, "shell: read_only_session");
  });
});
