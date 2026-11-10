import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { JsonlCheckpointStore } from "../../src/adapters/persistence/jsonl-checkpoint-store.ts";
import { JsonlEventLog } from "../../src/adapters/persistence/jsonl-event-log.ts";
import { createSpillStore } from "../../src/adapters/persistence/spill-store.ts";
import { RuntimeCoordinator } from "../../src/application/coordinator/runtime-coordinator.ts";
import { SPILL_LIMITS } from "../../src/domain/evidence/tool-spill.ts";
import type { ProviderCompletion } from "../../src/ports/model-provider.ts";
import type { ToolDefinition, ToolExecutor } from "../../src/ports/tool-executor.ts";

/**
 * Spilling through a real Run.
 *
 * The unit tests cover preview construction. This covers the join: a large tool
 * result is written to the Session directory, the model receives the preview
 * instead, the event records the fact, and the stored file is readable.
 */

const digests = {
  async sha256Canonical(value: unknown): Promise<string> {
    return createHash("sha256").update(JSON.stringify(value)).digest("hex");
  },
};
const ids = { create: () => randomUUID() };

const BIG = Array.from(
  { length: 3_000 },
  (_unused, index) => `row ${index} ${"x".repeat(10)}`,
).join("\n");

function toolsWithResult(text: string): ToolExecutor {
  return {
    getDefinition(name: string): ToolDefinition | null {
      if (name !== "probe") return null;
      return {
        name: "probe",
        version: "1",
        sideEffectClass: "read_only",
        requiresApproval: false,
        concurrencySafe: true,
      };
    },
    discardApproval: () => undefined,
    async execute() {
      return { status: "succeeded" as const, text };
    },
  };
}

/** One tool call, then finish. */
function oneToolProvider(): { complete: () => Promise<ProviderCompletion> } {
  let calls = 0;
  return {
    async complete(): Promise<ProviderCompletion> {
      calls += 1;
      if (calls === 1) {
        return {
          kind: "completed",
          toolCalls: [{ providerToolCallId: "c1", toolName: "probe", arguments: { n: 1 } }],
          text: null,
        };
      }
      return { kind: "completed", toolCalls: [], text: "done" };
    },
  };
}

describe("tool output spilling", () => {
  it("stores the full text and gives the model a preview", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "spill-run-"));
    const workspace = path.join(root, "workspace");
    const sessionDirectory = path.join(root, "session");
    const sessionId = "ws-spill";
    try {
      const coordinator = new RuntimeCoordinator({
        provider: oneToolProvider(),
        tools: toolsWithResult(BIG),
        approvals: { decide: async () => "approved" },
        eventLog: new JsonlEventLog(root, ids, digests),
        checkpoints: new JsonlCheckpointStore(root, digests),
        ids,
        nowUtc: () => new Date().toISOString(),
        suspendOnApproval: false,
        sessionId,
        spillStore: createSpillStore({ sessionDirectory, workspaceRoot: workspace }),
      });

      const result = await coordinator.run("spill something big");
      assert.equal(result.status, "completed");

      // The event records the spill with the real sizes.
      const spillEvent = result.events.find(
        (event) => event.payload.kind === "tool_output_spilled",
      );
      assert.notEqual(spillEvent, undefined);
      if (spillEvent?.payload.kind !== "tool_output_spilled") return;
      assert.equal(spillEvent.payload.totalUnits, BIG.length);
      assert.equal(spillEvent.payload.toolName, "probe");
      assert.ok(spillEvent.payload.previewUnits < spillEvent.payload.totalUnits);

      // The stored file holds the complete text, byte for byte.
      const stored = await readFile(
        path.join(sessionDirectory, "spill", `${spillEvent.payload.toolCallId}.txt`),
        "utf8",
      );
      assert.equal(stored, BIG);

      await coordinator.closeSession("close");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("gives the model the preview, not the whole text", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "spill-preview-"));
    const sessionDirectory = path.join(root, "session");
    const sessionId = "ws-preview";
    // Capture what the provider is asked to continue from.
    let seenToolResult: string | null = null;
    let calls = 0;
    try {
      const coordinator = new RuntimeCoordinator({
        provider: {
          async complete(request): Promise<ProviderCompletion> {
            calls += 1;
            if (calls === 1) {
              return {
                kind: "completed",
                toolCalls: [{ providerToolCallId: "c1", toolName: "probe", arguments: { n: 1 } }],
                text: null,
              };
            }
            for (const item of request.conversation) {
              if (item.kind === "tool_result") seenToolResult = item.text;
            }
            return { kind: "completed", toolCalls: [], text: "done" };
          },
        },
        tools: toolsWithResult(BIG),
        approvals: { decide: async () => "approved" },
        eventLog: new JsonlEventLog(root, ids, digests),
        checkpoints: new JsonlCheckpointStore(root, digests),
        ids,
        nowUtc: () => new Date().toISOString(),
        suspendOnApproval: false,
        sessionId,
        spillStore: createSpillStore({ sessionDirectory, workspaceRoot: path.join(root, "ws") }),
      });

      await coordinator.run("spill");
      assert.notEqual(seenToolResult, null);
      const preview = seenToolResult ?? "";
      assert.match(preview, /output spilled/);
      assert.ok(preview.length < BIG.length, "the model must not receive the whole text");
      // The head is present so the model can recognize the content.
      assert.match(preview, /row 0 /);
      // The tail is present so a final error or total is not lost.
      assert.match(preview, /row 2999 /);

      await coordinator.closeSession("close");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps a small result inline and writes nothing", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "spill-small-"));
    const sessionDirectory = path.join(root, "session");
    const sessionId = "ws-small";
    const small = "just a little output";
    try {
      const coordinator = new RuntimeCoordinator({
        provider: oneToolProvider(),
        tools: toolsWithResult(small),
        approvals: { decide: async () => "approved" },
        eventLog: new JsonlEventLog(root, ids, digests),
        checkpoints: new JsonlCheckpointStore(root, digests),
        ids,
        nowUtc: () => new Date().toISOString(),
        suspendOnApproval: false,
        sessionId,
        spillStore: createSpillStore({
          sessionDirectory,
          workspaceRoot: path.join(root, "ws"),
        }),
      });

      const result = await coordinator.run("small");
      assert.equal(result.status, "completed");
      assert.equal(
        result.events.some((event) => event.payload.kind === "tool_output_spilled"),
        false,
      );
      assert.equal(existsSync(path.join(sessionDirectory, "spill")), false);

      await coordinator.closeSession("close");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps the text inline when no spill store is composed", async () => {
    // A build without a store must still work; the result is simply larger.
    const root = await mkdtemp(path.join(tmpdir(), "spill-nostore-"));
    const sessionId = "ws-nostore";
    try {
      const coordinator = new RuntimeCoordinator({
        provider: oneToolProvider(),
        tools: toolsWithResult(BIG),
        approvals: { decide: async () => "approved" },
        eventLog: new JsonlEventLog(root, ids, digests),
        checkpoints: new JsonlCheckpointStore(root, digests),
        ids,
        nowUtc: () => new Date().toISOString(),
        suspendOnApproval: false,
        sessionId,
      });
      const result = await coordinator.run("no store");
      assert.equal(result.status, "completed");
      assert.equal(
        result.events.some((event) => event.payload.kind === "tool_output_spilled"),
        false,
      );
      await coordinator.closeSession("close");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps the log readable after a spill event is recorded", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "spill-valid-"));
    const sessionId = "ws-valid";
    try {
      const coordinator = new RuntimeCoordinator({
        provider: oneToolProvider(),
        tools: toolsWithResult(BIG),
        approvals: { decide: async () => "approved" },
        eventLog: new JsonlEventLog(root, ids, digests),
        checkpoints: new JsonlCheckpointStore(root, digests),
        ids,
        nowUtc: () => new Date().toISOString(),
        suspendOnApproval: false,
        sessionId,
        spillStore: createSpillStore({
          sessionDirectory: path.join(root, "session"),
          workspaceRoot: path.join(root, "ws"),
        }),
      });
      await coordinator.run("validate spill event");
      const read = await new JsonlEventLog(root, ids, digests).readWithRecovery(sessionId);
      assert.equal(read.ok, true);
      await coordinator.closeSession("close");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("spill store", () => {
  it("reports a workspace-relative reference when the file is inside", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "spill-inside-"));
    try {
      const store = createSpillStore({ sessionDirectory: root, workspaceRoot: root });
      const stored = await store.spill({ toolCallId: "abc", toolName: "t", text: "x" });
      assert.equal(stored.readable, true);
      assert.equal(stored.reference, "spill/abc.txt");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reports an absolute reference and unreadable when outside the workspace", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "spill-outside-"));
    const elsewhere = await mkdtemp(path.join(tmpdir(), "spill-ws-"));
    try {
      const store = createSpillStore({ sessionDirectory: root, workspaceRoot: elsewhere });
      const stored = await store.spill({ toolCallId: "abc", toolName: "t", text: "x" });
      assert.equal(stored.readable, false);
      assert.equal(path.isAbsolute(stored.reference ?? ""), true);
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(elsewhere, { recursive: true, force: true });
    }
  });

  it("refuses a tool call id that could escape the directory", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "spill-escape-"));
    try {
      const store = createSpillStore({ sessionDirectory: root, workspaceRoot: root });
      for (const id of ["..", "../x", "a/b", "a\\b", ""]) {
        const stored = await store.spill({ toolCallId: id, toolName: "t", text: "x" });
        assert.equal(stored.reference, null, id);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not overwrite an existing spill file", async () => {
    // Two writes for one call id would mean a duplicate execution; the first result
    // must not be destroyed.
    const root = await mkdtemp(path.join(tmpdir(), "spill-immutable-"));
    try {
      const store = createSpillStore({ sessionDirectory: root, workspaceRoot: root });
      const first = await store.spill({ toolCallId: "abc", toolName: "t", text: "first" });
      assert.notEqual(first.reference, null);
      const second = await store.spill({ toolCallId: "abc", toolName: "t", text: "second" });
      assert.equal(second.reference, null);
      assert.equal(await readFile(path.join(root, "spill", "abc.txt"), "utf8"), "first");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
