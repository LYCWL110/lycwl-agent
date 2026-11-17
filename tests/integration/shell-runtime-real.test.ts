import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import { createWorkspaceTools } from "../../src/bootstrap/read-only-tools.ts";
import { shellCommands } from "../fakes/shell-commands.ts";

let root = "";

before(async () => {
  root = await mkdtemp(path.join(tmpdir(), "lycwl-sh-"));
});

after(async () => {
  if (root.length > 0) await rm(root, { recursive: true, force: true });
});

function tools(enableProcesses: boolean) {
  return createWorkspaceTools({
    workspaceRoot: root,
    approvals: { decide: async () => "approved" },
    ids: { create: () => "id" },
    enableWrites: true,
    enableProcesses,
  });
}

describe("shell through the composition root", () => {
  it("stays unavailable unless processes are explicitly enabled", async () => {
    const t = tools(false);
    const result = await t.execute({
      toolCallId: "c1",
      toolName: "shell",
      arguments: { command: "echo hi", cwd: root },
    });
    assert.deepEqual(result, {
      status: "failed",
      safeCode: "tool_unavailable_in_build",
      text: null,
    });
  });

  it("runs a real command when processes are enabled", async () => {
    const t = tools(true);
    const result = await t.execute({
      toolCallId: "c1",
      toolName: "shell",
      arguments: { command: "echo supervised", cwd: root },
    });

    assert.equal(result.status, "succeeded");
    assert.match(result.text ?? "", /supervised/);
  });

  it("reports a non-zero exit as a failure with output", async () => {
    const t = tools(true);
    const result = await t.execute({
      toolCallId: "c1",
      toolName: "shell",
      arguments: { command: shellCommands.echoAndExit("bad", 5), cwd: root },
    });

    assert.equal(result.status, "failed");
    if (result.status !== "failed") return;
    assert.equal(result.safeCode, "nonzero_exit");
    assert.match(result.text ?? "", /bad/);
  });

  it("terminates a long command on timeout", async () => {
    const t = tools(true);
    const result = await t.execute({
      toolCallId: "c1",
      toolName: "shell",
      arguments: { command: shellCommands.sleep(30), cwd: root, timeoutMs: 1_500 },
    });

    assert.equal(result.status, "failed");
    if (result.status !== "failed") return;
    assert.equal(result.safeCode, "shell_timeout");
  });

  it("declares shell as approval-required and process execution", () => {
    const t = tools(true);
    const definition = t.getDefinition("shell");
    assert.equal(definition?.requiresApproval, true);
    assert.equal(definition?.sideEffectClass, "process_execution");
  });
});
