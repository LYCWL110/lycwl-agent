import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, symlink, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import {
  createFileEvidenceStore,
  EVIDENCE_LIMITS,
} from "../../src/adapters/persistence/file-evidence-store.ts";
import type { OwnedKeyRegistry } from "../../src/domain/security/owned-key-guard.ts";

async function fixture(
  run: (input: {
    directory: string;
    store: ReturnType<typeof createFileEvidenceStore>;
  }) => Promise<void>,
  registry: OwnedKeyRegistry = { keys: [] },
  refresh = async () => {},
) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "lycwl-evidence-"));
  try {
    await run({
      directory,
      store: createFileEvidenceStore({
        sessionDirectory: directory,
        sessionId: "fixture-session",
        ownedKeys: registry,
        refreshOwnedKeys: refresh,
      }),
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

const output = () => ({
  toolCallId: "fixture-call",
  stdout: Buffer.from("\ufeff\u4e2d\u6587\ud83d\ude00\r\nstdout\n"),
  stderr: Buffer.from("stderr\r\n"),
});

describe("immutable guarded process evidence", () => {
  it("publishes exact source bytes and validates the separate manifest", async () => {
    await fixture(async ({ directory, store }) => {
      const input = output();
      const result = await store.publishProcessOutput(input);
      assert.equal(result.ok, true);
      if (!result.ok) return;
      const evidence = result.evidence;
      assert.equal(evidence.rawComplete, true);
      assert.equal(evidence.capturedBytes, input.stdout.length + input.stderr.length);
      assert.equal(evidence.attachments.length, 2);
      for (const attachment of evidence.attachments) {
        const bytes = await readFile(
          path.join(directory, "attachments", attachment.ref.attachmentId),
        );
        assert.deepEqual(bytes, input[attachment.stream]);
        assert.equal(attachment.ref.sha256, createHash("sha256").update(bytes).digest("hex"));
      }
      assert.deepEqual(await store.verify(evidence), { ok: true });
      const second = await store.publishProcessOutput(input);
      assert.ok(second.ok);
      assert.notEqual(second.evidence.captureId, evidence.captureId);
      assert.deepEqual(await store.verify(evidence), { ok: true });
    });
  });

  it("reports missing bytes without fabricating complete evidence", async () => {
    await fixture(async ({ directory, store }) => {
      const result = await store.publishProcessOutput(output());
      assert.ok(result.ok);
      const attachment = result.evidence.attachments[0];
      assert.ok(attachment);
      await unlink(path.join(directory, "attachments", attachment.ref.attachmentId));
      assert.deepEqual(await store.verify(result.evidence), {
        ok: false,
        code: "attachment_missing",
      });
    });
  });

  it("rejects changed bytes and a replaced manifest", async () => {
    await fixture(async ({ directory, store }) => {
      const result = await store.publishProcessOutput(output());
      assert.ok(result.ok);
      const attachment = result.evidence.attachments[0];
      assert.ok(attachment);
      await writeFile(path.join(directory, "attachments", attachment.ref.attachmentId), "changed");
      assert.equal((await store.verify(result.evidence)).ok, false);
      await writeFile(
        path.join(directory, "attachments", `${result.evidence.captureId}.json`),
        "{}",
      );
      assert.deepEqual(await store.verify(result.evidence), { ok: false, code: "hash_mismatch" });
    });
  });

  it("refuses over-cap data before creating any output file", async () => {
    await fixture(async ({ directory, store }) => {
      assert.deepEqual(
        await store.publishProcessOutput({
          toolCallId: "fixture",
          stdout: Buffer.alloc(EVIDENCE_LIMITS.processBytes),
          stderr: Buffer.from("x"),
        }),
        { ok: false, code: "evidence_limit_exceeded" },
      );
      assert.deepEqual(await readdir(directory), []);
    });
  });

  it("accepts exactly the combined cap", async () => {
    await fixture(async ({ store }) => {
      const result = await store.publishProcessOutput({
        toolCallId: "fixture",
        stdout: Buffer.alloc(EVIDENCE_LIMITS.processBytes / 2, 0x41),
        stderr: Buffer.alloc(EVIDENCE_LIMITS.processBytes / 2, 0x42),
      });
      assert.ok(result.ok);
      assert.deepEqual(await store.verify(result.evidence), { ok: true });
    });
  });

  for (const key of ["q", "synthetic-owned-key-\u4e2d"]) {
    it(`blocks registered values before any persistence (${key.length} units)`, async () => {
      await fixture(
        async ({ directory, store }) => {
          const result = await store.publishProcessOutput({
            ...output(),
            stdout: Buffer.from(`before ${key} after`),
          });
          assert.deepEqual(result, {
            ok: false,
            code: "protected_delivery_blocked",
            reason: "owned_key_detected",
          });
          assert.deepEqual(await readdir(directory), []);
        },
        { keys: [{ keyId: "fixture", value: key, state: "retired", revision: 1 }] },
      );
    });
  }

  it("checks lossless registered binary representations", async () => {
    const bytes = Buffer.from("\uadc2", "utf16le");
    await fixture(
      async ({ directory, store }) => {
        const result = await store.publishProcessOutput({ ...output(), stdout: bytes });
        assert.deepEqual(result, {
          ok: false,
          code: "protected_delivery_blocked",
          reason: "owned_key_detected",
        });
        assert.deepEqual(await readdir(directory), []);
      },
      {
        keys: [
          {
            keyId: "fixture",
            value: bytes.toString("latin1"),
            byteEncoding: "latin1",
            state: "retired",
            revision: 1,
          },
        ],
      },
    );
  });

  it("fails closed before writing if registry refresh fails", async () => {
    await fixture(
      async ({ directory, store }) => {
        const result = await store.publishProcessOutput(output());
        assert.equal(result.ok, false);
        assert.deepEqual(await readdir(directory), []);
      },
      { keys: [] },
      async () => {
        throw new Error("synthetic_failure");
      },
    );
  });

  it("rejects traversal in a caller-controlled reference", async () => {
    await fixture(async ({ store }) => {
      const result = await store.publishProcessOutput(output());
      assert.ok(result.ok);
      assert.deepEqual(await store.verify({ ...result.evidence, captureId: "../outside" }), {
        ok: false,
        code: "invalid_manifest",
      });
    });
  });

  it("rejects an attachments junction without writing through it", async () => {
    const outside = await mkdtemp(path.join(os.tmpdir(), "lycwl-evidence-outside-"));
    try {
      await fixture(async ({ directory, store }) => {
        await symlink(outside, path.join(directory, "attachments"), "junction");
        const result = await store.publishProcessOutput(output());
        assert.deepEqual(result, { ok: false, code: "evidence_storage_failed" });
        assert.deepEqual(await readdir(outside), []);
      });
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });
});
