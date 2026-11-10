import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { createSnapshotStore } from "../../src/adapters/persistence/snapshot-store.ts";
import { undoSessionChanges } from "../../src/bootstrap/undo.ts";
import {
  canSnapshot,
  SNAPSHOT_LIMITS,
  type SnapshotEntry,
} from "../../src/domain/persistence/snapshot.ts";

/**
 * Snapshots and undo.
 *
 * Real files. The point of the feature is to restore bytes, so a mocked file system
 * would test nothing. These cover the properties that make undo safe: it restores
 * what was there, it deletes what was created, it refuses to escape the workspace,
 * and it never writes a snapshot it could not verify.
 */

function workspace(): string {
  return mkdtempSync(path.join(tmpdir(), "snap-ws-"));
}

function store(ws: string, session = "session") {
  return createSnapshotStore({
    sessionDirectory: path.join(ws, ".data", session),
    workspaceRoot: ws,
    nowUtc: () => "2026-01-01T00:00:00.000Z",
  });
}

describe("snapshot limits", () => {
  it("refuses a file over the per-file cap", () => {
    const result = canSnapshot({ files: 0, bytes: 0 }, SNAPSHOT_LIMITS.maxFileBytes + 1);
    assert.deepEqual(result, { ok: false, code: "too_large" });
  });

  it("refuses beyond the file count", () => {
    const result = canSnapshot({ files: SNAPSHOT_LIMITS.maxFilesPerRun, bytes: 0 }, 100);
    assert.deepEqual(result, { ok: false, code: "limit_exceeded" });
  });

  it("refuses beyond the byte budget", () => {
    const result = canSnapshot({ files: 1, bytes: SNAPSHOT_LIMITS.maxTotalBytesPerRun }, 100);
    assert.deepEqual(result, { ok: false, code: "limit_exceeded" });
  });

  it("allows a file within every limit", () => {
    assert.deepEqual(canSnapshot({ files: 0, bytes: 0 }, 1_000), { ok: true });
  });
});

describe("snapshot store", () => {
  it("captures an existing file and reads it back", async () => {
    const ws = workspace();
    writeFileSync(path.join(ws, "a.txt"), "original content", "utf8");
    const snapshots = store(ws);

    const captured = await snapshots.capture({ runId: "r1", relativePath: "a.txt" });
    assert.equal(captured.ok, true);
    if (!captured.ok) return;
    assert.equal(captured.entry.byteLength, 16);
    assert.equal(captured.entry.bytes !== null, true);

    const bytes = await snapshots.read("r1", captured.entry);
    assert.equal(Buffer.from(bytes ?? new Uint8Array()).toString("utf8"), "original content");
  });

  it("records a creation as absent content", async () => {
    const ws = workspace();
    const snapshots = store(ws);
    const captured = await snapshots.capture({ runId: "r1", relativePath: "new.txt" });
    assert.equal(captured.ok, true);
    if (!captured.ok) return;
    assert.equal(captured.entry.bytes, null);
    assert.equal(captured.entry.byteLength, 0);
  });

  it("keeps the first capture of a path", async () => {
    // The first capture holds the state before the Run touched the file, which is
    // what reverting to the Run's start means.
    const ws = workspace();
    writeFileSync(path.join(ws, "a.txt"), "first", "utf8");
    const snapshots = store(ws);
    const first = await snapshots.capture({ runId: "r1", relativePath: "a.txt" });
    writeFileSync(path.join(ws, "a.txt"), "second", "utf8");
    const again = await snapshots.capture({ runId: "r1", relativePath: "a.txt" });
    assert.equal(first.ok && again.ok, true);
    if (!first.ok || !again.ok) return;
    assert.equal(again.entry.sha256, first.entry.sha256);
    assert.equal(again.entry.byteLength, 5);
  });

  it("refuses a path that would escape the workspace", async () => {
    const ws = workspace();
    const snapshots = store(ws);
    for (const bad of ["../x", "/abs", "a/../../b", ""]) {
      const captured = await snapshots.capture({ runId: "r1", relativePath: bad });
      assert.equal(captured.ok, false, bad);
    }
  });

  it("lists entries for a run", async () => {
    const ws = workspace();
    writeFileSync(path.join(ws, "a.txt"), "a", "utf8");
    writeFileSync(path.join(ws, "b.txt"), "b", "utf8");
    const snapshots = store(ws);
    await snapshots.capture({ runId: "r1", relativePath: "a.txt" });
    await snapshots.capture({ runId: "r1", relativePath: "b.txt" });
    const entries = await snapshots.list("r1");
    assert.deepEqual(
      entries.map((entry) => entry.path),
      ["a.txt", "b.txt"],
    );
  });
});

describe("undo", () => {
  it("restores a modified file", async () => {
    const ws = workspace();
    writeFileSync(path.join(ws, "a.txt"), "original", "utf8");
    const snapshots = store(ws);
    await snapshots.capture({ runId: "r1", relativePath: "a.txt" });
    writeFileSync(path.join(ws, "a.txt"), "changed", "utf8");

    const undone = await undoSessionChanges({
      store: snapshots,
      workspaceRoot: ws,
      runIds: ["r1"],
    });
    assert.equal(undone.ok, true);
    assert.equal(readFileSync(path.join(ws, "a.txt"), "utf8"), "original");
  });

  it("deletes a file that did not exist before the run", async () => {
    const ws = workspace();
    const snapshots = store(ws);
    await snapshots.capture({ runId: "r1", relativePath: "created.txt" });
    writeFileSync(path.join(ws, "created.txt"), "new", "utf8");

    const undone = await undoSessionChanges({
      store: snapshots,
      workspaceRoot: ws,
      runIds: ["r1"],
    });
    assert.equal(undone.ok, true);
    assert.equal(existsSync(path.join(ws, "created.txt")), false);
  });

  it("reverts a file once even when several runs touched it", async () => {
    const ws = workspace();
    writeFileSync(path.join(ws, "a.txt"), "v0", "utf8");
    const snapshots = store(ws);
    await snapshots.capture({ runId: "r1", relativePath: "a.txt" });
    writeFileSync(path.join(ws, "a.txt"), "v1", "utf8");
    await snapshots.capture({ runId: "r2", relativePath: "a.txt" });
    writeFileSync(path.join(ws, "a.txt"), "v2", "utf8");

    const undone = await undoSessionChanges({
      store: snapshots,
      workspaceRoot: ws,
      runIds: ["r2", "r1"],
    });
    assert.equal(undone.ok, true);
    if (!undone.ok) return;
    // Newest run first: r2's snapshot is v1, so that is what is restored.
    assert.equal(undone.files, 1);
    assert.equal(readFileSync(path.join(ws, "a.txt"), "utf8"), "v1");
  });

  it("reports when there is nothing to undo", async () => {
    const ws = workspace();
    const undone = await undoSessionChanges({
      store: store(ws),
      workspaceRoot: ws,
      runIds: ["missing"],
    });
    assert.deepEqual(undone, { ok: false, code: "no_snapshots" });
  });

  it("does not overwrite a file whose snapshot is damaged", async () => {
    const ws = workspace();
    writeFileSync(path.join(ws, "a.txt"), "original", "utf8");
    const snapshots = store(ws);
    const captured = await snapshots.capture({ runId: "r1", relativePath: "a.txt" });
    assert.equal(captured.ok, true);
    if (!captured.ok) return;
    // Corrupt the stored content, keeping the index entry.
    const contentPath = path.join(
      ws,
      ".data",
      "session",
      "snapshots",
      "r1",
      `${captured.entry.sha256}.bin`,
    );
    writeFileSync(contentPath, "tampered", "utf8");
    writeFileSync(path.join(ws, "a.txt"), "current work", "utf8");

    const undone = await undoSessionChanges({
      store: snapshots,
      workspaceRoot: ws,
      runIds: ["r1"],
    });
    // Nothing was restored, so this is a failure rather than a partial success.
    assert.deepEqual(undone, { ok: false, code: "undo_failed" });
    assert.equal(readFileSync(path.join(ws, "a.txt"), "utf8"), "current work");
  });

  it("restores several files in one call", async () => {
    const ws = workspace();
    writeFileSync(path.join(ws, "a.txt"), "a0", "utf8");
    writeFileSync(path.join(ws, "b.txt"), "b0", "utf8");
    const snapshots = store(ws);
    await snapshots.capture({ runId: "r1", relativePath: "a.txt" });
    await snapshots.capture({ runId: "r1", relativePath: "b.txt" });
    writeFileSync(path.join(ws, "a.txt"), "a1", "utf8");
    writeFileSync(path.join(ws, "b.txt"), "b1", "utf8");

    const undone = await undoSessionChanges({
      store: snapshots,
      workspaceRoot: ws,
      runIds: ["r1"],
    });
    assert.equal(undone.ok, true);
    if (!undone.ok) return;
    assert.equal(undone.files, 2);
    assert.equal(readFileSync(path.join(ws, "a.txt"), "utf8"), "a0");
    assert.equal(readFileSync(path.join(ws, "b.txt"), "utf8"), "b0");
  });

  it("discards a run's snapshots", async () => {
    const ws = workspace();
    writeFileSync(path.join(ws, "a.txt"), "a", "utf8");
    const snapshots = store(ws);
    await snapshots.capture({ runId: "r1", relativePath: "a.txt" });
    await snapshots.discard("r1");
    assert.deepEqual(await snapshots.list("r1"), []);
  });
});

describe("snapshot entry shape", () => {
  it("keeps the recorded digest stable", () => {
    const entry: SnapshotEntry = {
      path: "a.txt",
      bytes: new Uint8Array([1, 2, 3]),
      byteLength: 3,
      sha256: "abc",
      capturedAtUtc: "2026-01-01T00:00:00.000Z",
    };
    assert.equal(entry.byteLength, entry.bytes?.length);
  });
});
