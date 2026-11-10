import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { describe, it } from "node:test";

import {
  captureConsistentSnapshot,
  type FileSnapshotFacts,
} from "../../src/services/files/consistent-snapshot.ts";

function facts(overrides: Partial<FileSnapshotFacts> = {}): FileSnapshotFacts {
  return {
    identity: "file-1",
    size: 5,
    lastWriteTimeNs: 1n,
    isFile: true,
    isSymbolicLink: false,
    ...overrides,
  };
}

describe("consistent file snapshots", () => {
  it("returns bytes only when before and after facts match", async () => {
    const result = await captureConsistentSnapshot({
      before: facts(),
      read: async () => Buffer.from("hello"),
      after: facts(),
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(Buffer.from(result.value.bytes).toString("utf8"), "hello");
    assert.equal(result.value.identity, "file-1");
    assert.equal(result.value.size, 5);
  });

  it("rejects a file changed during the read", async () => {
    const result = await captureConsistentSnapshot({
      before: facts(),
      read: async () => Buffer.from("hello"),
      after: facts({ lastWriteTimeNs: 2n }),
    });
    assert.deepEqual(result, { ok: false, code: "file_changed" });
  });

  it("rejects a byte count that disagrees with the facts", async () => {
    const result = await captureConsistentSnapshot({
      before: facts(),
      read: async () => Buffer.from("hi"),
      after: facts(),
    });
    assert.deepEqual(result, { ok: false, code: "file_changed" });
  });

  it("rejects oversized, non-file, and symlink targets before reading", async () => {
    let reads = 0;
    const read = async () => {
      reads += 1;
      return new Uint8Array();
    };
    assert.deepEqual(
      await captureConsistentSnapshot({
        before: facts({ size: 5 * 1024 * 1024 + 1 }),
        read,
        after: facts(),
      }),
      { ok: false, code: "file_too_large" },
    );
    assert.deepEqual(
      await captureConsistentSnapshot({
        before: facts({ isFile: false }),
        read,
        after: facts({ isFile: false }),
      }),
      { ok: false, code: "not_a_regular_file" },
    );
    assert.deepEqual(
      await captureConsistentSnapshot({
        before: facts({ isSymbolicLink: true }),
        read,
        after: facts({ isSymbolicLink: true }),
      }),
      { ok: false, code: "symbolic_link" },
    );
    assert.equal(reads, 0);
  });

  it("reports read failures without exposing exception text", async () => {
    const result = await captureConsistentSnapshot({
      before: facts(),
      read: async () => {
        throw new Error("secret path");
      },
      after: facts(),
    });
    assert.deepEqual(result, { ok: false, code: "read_failed" });
  });
});
