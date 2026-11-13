import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { JsonlCheckpointStore } from "../../../../src/adapters/persistence/jsonl-checkpoint-store.ts";
import { JsonlEventLog } from "../../../../src/adapters/persistence/jsonl-event-log.ts";
import { RuntimeCoordinator } from "../../../../src/application/coordinator/runtime-coordinator.ts";
import type { ToolDefinition, ToolExecutor } from "../../../../src/ports/tool-executor.ts";
import {
  approveAll,
  callTool,
  denyWhen,
  say,
  scriptedApprovals,
  scriptedModel,
  until,
} from "../harness.ts";

/**
 * E07: the user denies a change, and the report is honest about it.
 *
 * The frozen branch: the model proposes a mutation, the user denies it, and the
 * Runtime must (a) never dispatch the denied call, (b) stop unstarted siblings of a
 * mutating call, (c) not reach for another tool to do the same thing, and (d) report
 * that the change was not made.
 *
 * The denial is matched against the preview, not granted in advance. A gate that
 * approved everything would not exercise this path at all.
 */

const digests = {
  async sha256Canonical(value: unknown): Promise<string> {
    return createHash("sha256").update(JSON.stringify(value)).digest("hex");
  },
};
const ids = { create: () => randomUUID() };

type Recorded = { executed: number; names: string[] };

function recordingTools(): { tools: ToolExecutor; record: Recorded } {
  const record: Recorded = { executed: 0, names: [] };
  const definitions: Record<string, ToolDefinition> = {
    edit_file: {
      name: "edit_file",
      version: "1",
      sideEffectClass: "filesystem_mutation",
      requiresApproval: true,
      concurrencySafe: false,
    },
    read_file: {
      name: "read_file",
      version: "1",
      sideEffectClass: "read_only",
      requiresApproval: false,
      concurrencySafe: true,
    },
    shell: {
      name: "shell",
      version: "1",
      sideEffectClass: "process_execution",
      requiresApproval: true,
      concurrencySafe: false,
    },
  };
  return {
    record,
    tools: {
      getDefinition: (name) => definitions[name] ?? null,
      discardApproval: () => undefined,
      async preview(request) {
        const args = request.arguments as { path?: string } | null;
        return `${request.toolName} path=${args?.path ?? "?"}`;
      },
      async execute(request) {
        record.executed += 1;
        record.names.push(request.toolName);
        return { status: "succeeded" as const, text: "done" };
      },
    },
  };
}

async function withCoordinator(
  responses: Parameters<typeof scriptedModel>[0],
  approvals: Parameters<typeof scriptedApprovals>[0],
  run: (context: {
    coordinator: RuntimeCoordinator;
    model: ReturnType<typeof scriptedModel>;
    approvals: ReturnType<typeof scriptedApprovals>;
    record: Recorded;
  }) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(path.join(tmpdir(), "e07-"));
  const model = scriptedModel(responses);
  const gate = scriptedApprovals(approvals);
  const { tools, record } = recordingTools();
  try {
    const coordinator = new RuntimeCoordinator({
      provider: model.provider,
      tools,
      approvals: gate.gate,
      eventLog: new JsonlEventLog(root, ids, digests),
      checkpoints: new JsonlCheckpointStore(root, digests),
      ids,
      nowUtc: () => new Date().toISOString(),
      suspendOnApproval: true,
      sessionId: `e07-${randomUUID()}`,
    });
    await run({ coordinator, model, approvals: gate, record });
    await coordinator.closeSession("close");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe("E07: a denied change is never dispatched", () => {
  it("does not execute the denied call", async () => {
    await withCoordinator(
      [
        callTool("c1", "edit_file", { path: "a.txt" }),
        // After the denial the model is told, and it responds with a report.
        say("I did not make the change."),
      ],
      [denyWhen("edit_file")],
      async ({ coordinator, record }) => {
        const runPromise = coordinator.run("change the file");
        // Wait for the Runtime to reach the approval, then deny it.
        await until(() => coordinator.pendingApprovalView() !== null, {
          label: "approval shown",
        });
        const pending = coordinator.pendingApprovalView();
        assert.notEqual(pending, null);
        if (pending === null) return;
        await coordinator.replyApproval({
          commandId: "deny-1",
          approvalId: pending.approvalId,
          toolCallId: pending.toolCallId,
          requestVersion: pending.requestVersion,
          decision: "denied",
        });
        const result = await runPromise;

        // The denied call never reached the executor.
        assert.equal(record.executed, 0);
        assert.equal(result.status, "completed");
      },
    );
  });

  it("tells the model the call was denied rather than silently dropping it", async () => {
    await withCoordinator(
      [callTool("c1", "edit_file", { path: "a.txt" }), say("Understood.")],
      [denyWhen("edit_file")],
      async ({ coordinator, model }) => {
        const runPromise = coordinator.run("change the file");
        await until(() => coordinator.pendingApprovalView() !== null);
        const pending = coordinator.pendingApprovalView();
        if (pending === null) return;
        await coordinator.replyApproval({
          commandId: "deny-1",
          approvalId: pending.approvalId,
          toolCallId: pending.toolCallId,
          requestVersion: pending.requestVersion,
          decision: "denied",
        });
        await runPromise;

        // The second request must carry a tool_result for the denied call, so the
        // model knows what happened instead of assuming the edit landed.
        const second = model.requests.at(1);
        assert.notEqual(second, undefined);
        const denied = second?.conversation.find(
          (item) => item.kind === "tool_result" && item.providerToolCallId === "c1",
        );
        assert.notEqual(denied, undefined);
        assert.equal(denied?.kind === "tool_result" ? denied.status : null, "denied");
      },
    );
  });
});

describe("E07: no workaround after a denial", () => {
  it("does not reach for shell to do the same change", async () => {
    // The model tries the edit, is denied, then tries a shell command that would do
    // the same thing. The Runtime cannot stop the model from asking, but the shell
    // command must also require approval, so it is denied too and never runs.
    await withCoordinator(
      [
        callTool("c1", "edit_file", { path: "a.txt" }),
        callTool("c2", "shell", { command: "Set-Content a.txt x" }),
        say("I could not make the change."),
      ],
      [denyWhen("edit_file"), denyWhen("shell")],
      async ({ coordinator, record }) => {
        const runPromise = coordinator.run("change the file");
        // Deny both approvals as they appear.
        for (let step = 0; step < 2; step += 1) {
          await until(() => coordinator.pendingApprovalView() !== null, {
            label: `approval ${step + 1}`,
          });
          const pending = coordinator.pendingApprovalView();
          if (pending === null) break;
          await coordinator.replyApproval({
            commandId: `deny-${step}`,
            approvalId: pending.approvalId,
            toolCallId: pending.toolCallId,
            requestVersion: pending.requestVersion,
            decision: "denied",
          });
        }
        await runPromise;
        assert.equal(record.executed, 0, "neither the edit nor the shell ran");
      },
    );
  });

  it("a read is still allowed after a denial", async () => {
    // Denial applies to that invocation only; reading to explain the situation is
    // permitted and is not a workaround.
    await withCoordinator(
      [
        callTool("c1", "edit_file", { path: "a.txt" }),
        callTool("c2", "read_file", { path: "a.txt" }),
        say("Here is what the file contains."),
      ],
      [denyWhen("edit_file"), approveAll()],
      async ({ coordinator, record }) => {
        const runPromise = coordinator.run("change the file");
        await until(() => coordinator.pendingApprovalView() !== null);
        const pending = coordinator.pendingApprovalView();
        if (pending === null) return;
        await coordinator.replyApproval({
          commandId: "deny-1",
          approvalId: pending.approvalId,
          toolCallId: pending.toolCallId,
          requestVersion: pending.requestVersion,
          decision: "denied",
        });
        await runPromise;
        assert.deepEqual(record.names, ["read_file"]);
      },
    );
  });
});

describe("E07: a mutating call stops unstarted siblings", () => {
  it("does not run the second mutation in the same response", async () => {
    // Two mutations arrive in one response. The first is denied; the second must not
    // be dispatched, because the two came from the same plan.
    await withCoordinator(
      [
        {
          kind: "completed",
          text: null,
          toolCalls: [
            { providerToolCallId: "c1", toolName: "edit_file", arguments: { path: "a.txt" } },
            { providerToolCallId: "c2", toolName: "edit_file", arguments: { path: "b.txt" } },
          ],
        },
        say("Neither change was made."),
      ],
      [denyWhen("path=a.txt")],
      async ({ coordinator, record }) => {
        const runPromise = coordinator.run("change both files");
        await until(() => coordinator.pendingApprovalView() !== null);
        const pending = coordinator.pendingApprovalView();
        if (pending === null) return;
        await coordinator.replyApproval({
          commandId: "deny-1",
          approvalId: pending.approvalId,
          toolCallId: pending.toolCallId,
          requestVersion: pending.requestVersion,
          decision: "denied",
        });
        await runPromise;
        // The sibling on b.txt never ran, and never asked for approval.
        assert.deepEqual(record.names, []);
      },
    );
  });
});
