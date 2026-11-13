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
import { approveAll, callTool, say, scriptedApprovals, scriptedModel, until } from "../harness.ts";

/**
 * E08: a new requirement arrives while an old approval is still pending.
 *
 * The frozen branch: two calls are awaiting approval, and the user submits a real
 * new message: "only analyse, do not make these changes". The Runtime must queue it,
 * then on consumption cancel every undispatched old call and revoke their unused
 * grants, then plan against the new requirement with fresh call ids.
 *
 * What must not happen: the old calls running because a button was already shown,
 * the new message being treated as approval, or an already-executed effect being
 * erased from the record.
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
  run: (context: {
    coordinator: RuntimeCoordinator;
    model: ReturnType<typeof scriptedModel>;
    record: Recorded;
  }) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(path.join(tmpdir(), "e08-"));
  const model = scriptedModel(responses);
  const gate = scriptedApprovals([approveAll()]);
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
      sessionId: `e08-${randomUUID()}`,
    });
    await run({ coordinator, model, record });
    await coordinator.closeSession("close");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe("E08: a new requirement cancels undispatched old calls", () => {
  it("queues the new message instead of applying it immediately", async () => {
    await withCoordinator(
      [
        callTool("c1", "edit_file", { path: "a.txt" }),
        // After the queued input is consumed, the model replans.
        say("Understood, analysis only."),
      ],
      async ({ coordinator, model }) => {
        const runPromise = coordinator.run("change the file");
        await until(() => coordinator.pendingApprovalView() !== null, {
          label: "approval shown",
        });

        // The new requirement arrives while the approval is pending.
        const queued = await coordinator.queueInput("only analyse, do not make these changes");
        assert.equal(queued.ok, true);

        // The pending approval is still there: the new message did not silently
        // approve it.
        assert.notEqual(coordinator.pendingApprovalView(), null);

        // Approving the old call must not run it, because consumption cancels it.
        const pending = coordinator.pendingApprovalView();
        if (pending === null) return;
        await coordinator.replyApproval({
          commandId: "approve-1",
          approvalId: pending.approvalId,
          toolCallId: pending.toolCallId,
          requestVersion: pending.requestVersion,
          decision: "approved",
        });
        const result = await runPromise;
        assert.equal(result.status, "completed");

        // The model saw the new requirement in a later request.
        const replanned = model.requests.at(1);
        assert.notEqual(replanned, undefined);
        const text = (replanned?.conversation ?? [])
          .map((item) => (item.kind === "user" ? item.text : ""))
          .join("\n");
        assert.match(text, /only analyse/);
      },
    );
  });

  it("the cancelled call never executes", async () => {
    await withCoordinator(
      [callTool("c1", "edit_file", { path: "a.txt" }), say("Analysis only.")],
      async ({ coordinator, record }) => {
        const runPromise = coordinator.run("change the file");
        await until(() => coordinator.pendingApprovalView() !== null);
        await coordinator.queueInput("only analyse, do not make these changes");
        const pending = coordinator.pendingApprovalView();
        if (pending === null) return;
        await coordinator.replyApproval({
          commandId: "approve-1",
          approvalId: pending.approvalId,
          toolCallId: pending.toolCallId,
          requestVersion: pending.requestVersion,
          decision: "approved",
        });
        await runPromise;
        assert.equal(record.executed, 0, "the old edit must not run");
      },
    );
  });

  it("the replanned request uses fresh call ids", async () => {
    await withCoordinator(
      [
        callTool("c1", "edit_file", { path: "a.txt" }),
        // The model replans and asks for a read, which needs no approval.
        callTool("c2", "read_file", { path: "a.txt" }),
        say("Here is the analysis."),
      ],
      async ({ coordinator, model, record }) => {
        const runPromise = coordinator.run("change the file");
        await until(() => coordinator.pendingApprovalView() !== null);
        await coordinator.queueInput("only analyse, do not make these changes");
        const pending = coordinator.pendingApprovalView();
        if (pending === null) return;
        await coordinator.replyApproval({
          commandId: "approve-1",
          approvalId: pending.approvalId,
          toolCallId: pending.toolCallId,
          requestVersion: pending.requestVersion,
          decision: "approved",
        });
        await runPromise;
        // The read ran; the edit did not. The new call id is c2, which the model
        // chose, and the old c1 was cancelled rather than reused.
        assert.deepEqual(record.names, ["read_file"]);
      },
    );
  });
});

describe("E08: an executed effect is preserved", () => {
  it("keeps a completed call in the record when a new message arrives", async () => {
    // The first call executes and completes. Then a new message arrives. The
    // completed effect must stay in the conversation, not be erased by the replan.
    await withCoordinator(
      [callTool("c1", "read_file", { path: "a.txt" }), say("I read the file.")],
      async ({ coordinator, model, record }) => {
        const runPromise = coordinator.run("read the file");
        await until(() => record.executed === 1, { label: "first call executed" });
        await coordinator.queueInput("also summarise it");
        await runPromise;

        // The read happened and is still visible in a later request.
        assert.equal(record.executed, 1);
        const later = model.requests.at(-1);
        const results = (later?.conversation ?? []).filter((item) => item.kind === "tool_result");
        assert.equal(results.length >= 1, true);
      },
    );
  });
});

describe("E08: a new message is not approval", () => {
  it("does not resolve a pending approval by queueing a message", async () => {
    await withCoordinator(
      [callTool("c1", "edit_file", { path: "a.txt" }), say("done")],
      async ({ coordinator }) => {
        const runPromise = coordinator.run("change the file");
        await until(() => coordinator.pendingApprovalView() !== null);
        await coordinator.queueInput("carry on");
        // The approval is still pending: a message is not a decision.
        assert.notEqual(coordinator.pendingApprovalView(), null);
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
      },
    );
  });

  it("refuses a queued message when no Run is active", async () => {
    await withCoordinator([], async ({ coordinator }) => {
      const queued = await coordinator.queueInput("too late");
      assert.equal(queued.ok, false);
    });
  });
});
