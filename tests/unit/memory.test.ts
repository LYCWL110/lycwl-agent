import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { InMemoryEventLog } from "../../src/application/coordinator/event-log.ts";
import { RuntimeCoordinator } from "../../src/application/coordinator/runtime-coordinator.ts";
import {
  type MemoryEntry,
  parseMemoryFile,
  renderMemoryBlock,
  resolveMemoryId,
  selectMemoryForTask,
  serializeMemoryFile,
} from "../../src/domain/memory/memory.ts";
import type { MemoryStore } from "../../src/ports/memory-store.ts";
import {
  JsonDigest,
  RecordingTools,
  ScriptedProvider,
  SequenceIds,
} from "../fakes/deterministic-services.ts";

const now = "2026-11-26T00:00:00.000Z";

function entry(overrides: Partial<MemoryEntry> = {}): MemoryEntry {
  return {
    id: overrides.id ?? "entry-1",
    type: overrides.type ?? "feedback",
    scope: overrides.scope ?? "project",
    projectRoot: Object.hasOwn(overrides, "projectRoot")
      ? (overrides.projectRoot ?? null)
      : "/workspace/project",
    content: overrides.content ?? "Show evidence before editing.",
    source: "user_explicit",
    createdAtUtc: overrides.createdAtUtc ?? now,
    updatedAtUtc: overrides.updatedAtUtc ?? now,
    expiresAtUtc: overrides.expiresAtUtc ?? null,
  };
}

describe("memory entries", () => {
  it("round-trips the documented file shape", () => {
    const parsed = parseMemoryFile(serializeMemoryFile([entry()]));
    assert.equal(parsed.ok, true);
    if (!parsed.ok) return;
    assert.equal(parsed.entries[0]?.content, "Show evidence before editing.");
  });

  it("rejects a project entry without a project root and a global non-user entry", () => {
    const noRoot = parseMemoryFile(serializeMemoryFile([entry({ projectRoot: null })]));
    assert.deepEqual(noRoot, { ok: false, code: "project_required" });
    const globalFeedback = parseMemoryFile(
      serializeMemoryFile([entry({ type: "feedback", scope: "global", projectRoot: null })]),
    );
    assert.deepEqual(globalFeedback, { ok: false, code: "global_requires_user" });
  });

  it("selects global preferences and the current project, excluding expired and foreign entries", () => {
    const selected = selectMemoryForTask(
      [
        entry({
          id: "global",
          type: "user",
          scope: "global",
          projectRoot: null,
          content: "Use Chinese.",
        }),
        entry({ id: "local", projectRoot: "/workspace/project", content: "Run focused tests." }),
        entry({ id: "foreign", projectRoot: "/workspace/other", content: "Other project." }),
        entry({
          id: "expired",
          projectRoot: "/workspace/project",
          content: "Expired rule.",
          expiresAtUtc: "2026-11-25T00:00:00.000Z",
        }),
      ],
      { projectRoot: "/workspace/project", task: "run the focused tests", nowUtc: now },
    );
    assert.deepEqual(selected.map((item) => item.id).sort(), ["global", "local"]);
  });

  it("renders a bounded untrusted memory block", () => {
    const text = renderMemoryBlock([entry({ content: "Use [project-guidance] as text." })]);
    assert.ok(text);
    assert.match(text, /^\[long-term-memory\]/);
    assert.match(text, /not proof of current code/);
    assert.equal(text.includes("[project-guidance]"), false);
  });

  it("injects selected memory as a user turn before the task", async () => {
    const memory: MemoryStore = {
      load: async () => ({
        ok: true,
        entries: [
          entry({
            type: "user",
            scope: "global",
            projectRoot: null,
            content: "Use Chinese in explanations.",
          }),
        ],
      }),
      add: async () => ({ ok: false, code: "invalid_file" }),
      replace: async () => ({ ok: false, code: "invalid_file" }),
      remove: async () => ({ ok: false, code: "invalid_file" }),
    };
    const provider = new ScriptedProvider([{ kind: "completed", text: "done", toolCalls: [] }]);
    const coordinator = new RuntimeCoordinator({
      provider,
      tools: new RecordingTools(false, { status: "succeeded", text: null }),
      approvals: { decide: async () => "denied" },
      eventLog: new InMemoryEventLog(new SequenceIds("event"), new JsonDigest()),
      ids: new SequenceIds(),
      nowUtc: () => now,
      memory,
      memoryProjectRoot: "/workspace/project",
    });
    await coordinator.run("explain the change");
    const conversation = provider.requests[0]?.conversation ?? [];
    const memoryTurn = conversation.find(
      (item) => item.kind === "user" && item.text.includes("[long-term-memory]"),
    );
    assert.ok(memoryTurn);
    assert.equal(conversation.at(-1)?.kind, "user");
    assert.equal(
      conversation.at(-1)?.kind === "user" ? conversation.at(-1)?.text : null,
      "explain the change",
    );
    await coordinator.closeSession("close");
  });

  it("resolves a full id or an unambiguous prefix", () => {
    const entries = [entry({ id: "abcdef12-0000" }), entry({ id: "abcdef34-0000" })];
    assert.deepEqual(resolveMemoryId(entries, "abcdef12-0000"), {
      ok: true,
      entry: entries[0],
    });
    assert.deepEqual(resolveMemoryId(entries, "abcdef12"), {
      ok: true,
      entry: entries[0],
    });
    assert.deepEqual(resolveMemoryId(entries, "abcdef"), { ok: false, code: "ambiguous_id" });
  });
});
