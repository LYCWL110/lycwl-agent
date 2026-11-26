import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import { createMemoryStore, MEMORY_FILENAME } from "../../src/adapters/persistence/memory-store.ts";

let directory = "";

before(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "lycwl-memory-"));
});

after(async () => {
  if (directory.length > 0) await rm(directory, { recursive: true, force: true });
});

function store(nowUtc = "2026-11-26T00:00:00.000Z") {
  return createMemoryStore({ directory, nowUtc: () => nowUtc });
}

describe("memory store", () => {
  it("adds, lists, replaces and removes explicit entries", async () => {
    const memory = store();
    const added = await memory.add({
      type: "feedback",
      scope: "project",
      projectRoot: "/workspace/project",
      content: "When diagnosis fails, show the evidence before editing.",
    });
    assert.equal(added.ok, true);
    if (!added.ok) return;
    assert.equal(added.entry.id.length > 8, true);
    assert.equal(added.entry.source, "user_explicit");

    const loaded = await memory.load();
    assert.equal(loaded.ok, true);
    if (!loaded.ok) return;
    assert.equal(loaded.entries.length, 1);

    const replaced = await memory.replace(added.entry.id.slice(0, 8), {
      content: "Show the failing evidence before editing.",
    });
    assert.equal(replaced.ok, true);
    if (!replaced.ok) return;
    assert.equal(replaced.entry.type, "feedback");
    assert.equal(replaced.entry.scope, "project");
    assert.match(replaced.entry.content, /failing evidence/);

    const removed = await memory.remove(added.entry.id.slice(0, 8));
    assert.equal(removed.ok, true);
    const empty = await memory.load();
    assert.ok(empty.ok);
    if (empty.ok) assert.deepEqual(empty.entries, []);
  });

  it("does not add the same content twice", async () => {
    const memory = store();
    const input = {
      type: "feedback" as const,
      scope: "project" as const,
      projectRoot: "/workspace/project",
      content: "Same rule.",
    };
    const first = await memory.add(input);
    const second = await memory.add(input);
    assert.equal(first.ok && second.ok, true);
    if (first.ok && second.ok) assert.equal(first.entry.id, second.entry.id);
    const loaded = await memory.load();
    assert.ok(loaded.ok);
    if (loaded.ok)
      assert.equal(loaded.entries.filter((entry) => entry.content === "Same rule.").length, 1);
  });

  it("allows global user preferences but not global feedback", async () => {
    const memory = store();
    const user = await memory.add({
      type: "user",
      scope: "global",
      projectRoot: null,
      content: "Use Chinese in explanations.",
    });
    assert.equal(user.ok, true);
    const feedback = await memory.add({
      type: "feedback",
      scope: "global",
      projectRoot: null,
      content: "Always do this everywhere.",
    });
    assert.deepEqual(feedback, { ok: false, code: "global_requires_user" });
  });

  it("purges expired entries on the next write", async () => {
    let now = "2026-11-26T00:00:00.000Z";
    const memory = createMemoryStore({ directory, nowUtc: () => now });
    const expired = await memory.add({
      type: "project",
      scope: "project",
      projectRoot: "/workspace/project",
      content: "Temporary deployment detail.",
      expiresAtUtc: "2026-11-26T01:00:00.000Z",
    });
    assert.equal(expired.ok, true);
    now = "2026-11-26T02:00:00.000Z";
    const added = await memory.add({
      type: "feedback",
      scope: "project",
      projectRoot: "/workspace/project",
      content: "A new rule.",
    });
    assert.equal(added.ok, true);
    const loaded = await memory.load();
    assert.ok(loaded.ok);
    if (!loaded.ok) return;
    assert.equal(
      loaded.entries.some((entry) => entry.content.includes("Temporary")),
      false,
    );
  });

  it("reports a corrupt file instead of treating it as empty", async () => {
    const corrupt = await mkdtemp(path.join(tmpdir(), "lycwl-memory-corrupt-"));
    try {
      await writeFile(path.join(corrupt, MEMORY_FILENAME), "{not json", "utf8");
      const memory = createMemoryStore({ directory: corrupt });
      assert.deepEqual(await memory.load(), { ok: false, code: "invalid_file" });
    } finally {
      await rm(corrupt, { recursive: true, force: true });
    }
  });

  it("writes the documented file shape", async () => {
    const raw = await readFile(path.join(directory, MEMORY_FILENAME), "utf8");
    const parsed = JSON.parse(raw) as { schemaVersion?: number; entries?: unknown[] };
    assert.equal(parsed.schemaVersion, 1);
    assert.equal(Array.isArray(parsed.entries), true);
  });
});
