import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  type MemoryEntry,
  parseMemoryFile,
  resolveMemoryId,
  searchMemory,
  serializeMemoryFile,
} from "../../src/domain/memory/memory.ts";

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

  it("searches by project, type, query and validity", () => {
    const matches = searchMemory(
      [
        entry({
          id: "global",
          type: "user",
          scope: "global",
          projectRoot: null,
          content: "Review briefly.",
        }),
        entry({ id: "local", projectRoot: "/workspace/project", content: "Review with evidence." }),
        entry({ id: "foreign", projectRoot: "/workspace/other", content: "Review elsewhere." }),
        entry({
          id: "expired",
          projectRoot: "/workspace/project",
          content: "Review expired.",
          expiresAtUtc: "2026-11-25T00:00:00.000Z",
        }),
      ],
      { query: "review", projectRoot: "/workspace/project", nowUtc: now, types: ["feedback"] },
    );
    assert.deepEqual(
      matches.map((match) => match.entry.id),
      ["local"],
    );
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
