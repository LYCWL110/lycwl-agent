import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  createMemorySearchTool,
  MEMORY_SEARCH_DEFINITION,
} from "../../src/adapters/tools/memory-tool.ts";
import type { MemoryEntry } from "../../src/domain/memory/memory.ts";
import type { MemoryStore } from "../../src/ports/memory-store.ts";

const now = "2026-11-26T00:00:00.000Z";

function entry(overrides: Partial<MemoryEntry> = {}): MemoryEntry {
  return {
    id: overrides.id ?? "abcdef12-0000",
    type: overrides.type ?? "feedback",
    scope: overrides.scope ?? "project",
    projectRoot: overrides.projectRoot ?? "/workspace/project",
    content: overrides.content ?? "Review with evidence before editing.",
    source: "user_explicit",
    createdAtUtc: overrides.createdAtUtc ?? now,
    updatedAtUtc: overrides.updatedAtUtc ?? now,
    expiresAtUtc: overrides.expiresAtUtc ?? null,
  };
}

function store(entries: readonly MemoryEntry[], ok = true): MemoryStore {
  return {
    load: async () => (ok ? { ok: true, entries } : { ok: false, code: "invalid_file" }),
    add: async () => ({ ok: false, code: "invalid_file" }),
    replace: async () => ({ ok: false, code: "invalid_file" }),
    remove: async () => ({ ok: false, code: "invalid_file" }),
  };
}

function tool(entries: readonly MemoryEntry[], ok = true) {
  return createMemorySearchTool({
    store: store(entries, ok),
    projectRoot: "/workspace/project",
    nowUtc: () => now,
  });
}

describe("memory_search", () => {
  it("is read-only and approval-free", () => {
    assert.equal(MEMORY_SEARCH_DEFINITION.sideEffectClass, "read_only");
    assert.equal(MEMORY_SEARCH_DEFINITION.requiresApproval, false);
  });

  it("returns matching entries with their identity and date", async () => {
    const result = await tool([entry({ content: "Review with evidence before editing." })]).execute(
      {
        toolCallId: "m1",
        toolName: "memory_search",
        arguments: { query: "review evidence" },
      },
    );
    assert.equal(result.status, "succeeded");
    assert.match(result.text ?? "", /memory_search: 1 match/);
    assert.match(result.text ?? "", /id=abcdef12-0000/);
    assert.match(result.text ?? "", /Review with evidence/);
  });

  it("says no match instead of returning a nearby entry", async () => {
    const result = await tool([entry()]).execute({
      toolCallId: "m1",
      toolName: "memory_search",
      arguments: { query: "unrelated deployment" },
    });
    assert.equal(result.status, "succeeded");
    assert.match(result.text ?? "", /No matching memory/);
  });

  it("filters by type and project", async () => {
    const result = await tool([
      entry({ id: "project-entry", content: "Project review rule." }),
      entry({
        id: "other-project",
        projectRoot: "/workspace/other",
        content: "Other review rule.",
      }),
      entry({
        id: "user-entry",
        type: "user",
        scope: "global",
        projectRoot: null,
        content: "Review briefly.",
      }),
    ]).execute({
      toolCallId: "m1",
      toolName: "memory_search",
      arguments: { query: "review", types: ["user"] },
    });
    const text = result.text ?? "";
    assert.match(text, /user-entry/);
    assert.equal(text.includes("project-entry"), false);
    assert.equal(text.includes("other-project"), false);
  });

  it("fails closed when the store is unreadable", async () => {
    const result = await tool([], false).execute({
      toolCallId: "m1",
      toolName: "memory_search",
      arguments: { query: "anything" },
    });
    assert.deepEqual(result, { status: "failed", safeCode: "memory_unavailable", text: null });
  });
});
