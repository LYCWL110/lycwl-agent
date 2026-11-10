import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import { InMemoryEventLog } from "../../src/application/coordinator/event-log.ts";
import { RuntimeCoordinator } from "../../src/application/coordinator/runtime-coordinator.ts";
import { createWorkspaceTools } from "../../src/bootstrap/read-only-tools.ts";
import { availableTools } from "../../src/domain/tool-catalog/tool-catalog.ts";
import type { ModelProvider, ProviderCompletion } from "../../src/ports/model-provider.ts";
import { JsonDigest, SequenceIds } from "../fakes/deterministic-services.ts";

/**
 * Shell through the real coordinator.
 *
 * ADR-0058 records that shell was implemented and tested but disabled in the
 * composition root, so the agent could not run a command. These tests drive a real
 * command through the real supervisor and prove approval gates it.
 */

let root = "";

before(async () => {
  root = await mkdtemp(path.join(tmpdir(), "lycwl-shell-e2e-"));
});

after(async () => {
  if (root.length > 0) await rm(root, { recursive: true, force: true });
});

class CommandProvider implements ModelProvider {
  readonly #command: string;
  #round = 0;

  constructor(command: string) {
    this.#command = command;
  }

  async complete(): Promise<ProviderCompletion> {
    this.#round += 1;
    if (this.#round > 1) {
      return { kind: "completed", toolCalls: [], text: "finished" };
    }
    return {
      kind: "completed",
      toolCalls: [
        {
          providerToolCallId: "call-1",
          toolName: "shell",
          arguments: { command: this.#command, cwd: root },
        },
      ],
      text: null,
    };
  }
}

function coordinator(provider: ModelProvider, enableProcesses: boolean) {
  const ids = new SequenceIds("id");
  const tools = createWorkspaceTools({
    workspaceRoot: root,
    approvals: { decide: async () => "denied" },
    ids,
    // A read-only Session refuses Shell by design, so the write mode is required
    // for these cases.
    enableWrites: true,
    enableProcesses,
  });
  return {
    coordinator: new RuntimeCoordinator({
      provider,
      tools,
      approvals: { decide: async () => "denied" },
      eventLog: new InMemoryEventLog(ids, new JsonDigest()),
      ids,
      nowUtc: () => "2026-11-05T00:00:00.000Z",
      suspendOnApproval: true,
    }),
    tools,
  };
}

async function reply(underTest: RuntimeCoordinator, decision: "approved" | "denied") {
  const pending = underTest.pendingApprovalView();
  assert.ok(pending !== null, "the command must suspend for approval");
  if (pending === null) return null;
  await underTest.replyApproval({
    commandId: "c1",
    approvalId: pending.approvalId,
    toolCallId: pending.toolCallId,
    requestVersion: pending.requestVersion,
    decision,
  });
  return underTest.settle();
}

describe("shell execution behind approval", () => {
  it("runs the command only after approval and returns its output", async () => {
    const provider = new CommandProvider("echo SHELL_APPROVED_OUTPUT");
    const built = coordinator(provider, true);
    const run = built.coordinator.run("run the command");

    await new Promise((resolve) => setTimeout(resolve, 60));
    const settled = (await reply(built.coordinator, "approved")) ?? (await run);

    assert.equal(settled.status, "completed", settled.safeCode ?? "");
    const finished = settled.events.filter(
      (event) => event.payload.kind === "tool_execution_finished",
    );
    assert.equal(finished.length, 1);
    const payload = finished[0]?.payload;
    assert.ok(payload && payload.kind === "tool_execution_finished");
    if (!payload || payload.kind !== "tool_execution_finished") return;
    assert.equal(payload.status, "succeeded");
    assert.match(payload.text ?? "", /SHELL_APPROVED_OUTPUT/);
  });

  it("does not run the command when denied", async () => {
    const provider = new CommandProvider("echo MUST_NOT_RUN > shell-denied.txt");
    const built = coordinator(provider, true);
    const run = built.coordinator.run("run the command");

    await new Promise((resolve) => setTimeout(resolve, 60));
    const settled = (await reply(built.coordinator, "denied")) ?? (await run);

    assert.equal(settled.status, "completed");
    const denied = settled.events.filter((event) => event.payload.kind === "tool_execution_denied");
    assert.equal(denied.length, 1);

    // The command must not have produced its side effect.
    const { readFile } = await import("node:fs/promises");
    await assert.rejects(readFile(path.join(root, "shell-denied.txt"), "utf8"));
  });

  it("reports a non-zero exit as a failed tool result", async () => {
    const provider = new CommandProvider("exit 7");
    const built = coordinator(provider, true);
    const run = built.coordinator.run("run the command");

    await new Promise((resolve) => setTimeout(resolve, 60));
    const settled = (await reply(built.coordinator, "approved")) ?? (await run);

    const finished = settled.events.filter(
      (event) => event.payload.kind === "tool_execution_finished",
    );
    const payload = finished[0]?.payload;
    assert.ok(payload && payload.kind === "tool_execution_finished");
    if (!payload || payload.kind !== "tool_execution_finished") return;
    assert.equal(payload.status, "failed");
    assert.equal(payload.safeCode, "nonzero_exit");
  });
});

describe("shell availability follows the flag", () => {
  it("is not advertised when processes are disabled", () => {
    const built = coordinator(new CommandProvider("echo x"), false);
    const catalog = availableTools(
      (name) => name === "ask_user" || built.tools.getDefinition(name) !== null,
    );
    const names = catalog.map((entry) => entry.name);
    assert.equal(names.includes("shell"), false);
    assert.equal(names.includes("background_start"), false);
  });

  it("is advertised when processes are enabled", () => {
    const built = coordinator(new CommandProvider("echo x"), true);
    const catalog = availableTools(
      (name) => name === "ask_user" || built.tools.getDefinition(name) !== null,
    );
    const names = catalog.map((entry) => entry.name);
    assert.equal(names.includes("shell"), true);
    assert.equal(names.includes("background_start"), true);
    assert.equal(names.includes("background_stop"), true);
  });

  it("fails as unavailable when a disabled shell is called anyway", async () => {
    const built = coordinator(new CommandProvider("echo x"), false);
    const result = await built.tools.execute({
      toolCallId: "c1",
      toolName: "shell",
      arguments: { command: "echo x", cwd: root },
    });
    assert.deepEqual(result, {
      status: "failed",
      safeCode: "tool_unavailable_in_build",
      text: null,
    });
  });
});
