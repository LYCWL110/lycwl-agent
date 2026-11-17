import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import path from "node:path";

import {
  type CheckpointState,
  createCheckpoint,
  shouldCheckpoint,
  validateCheckpoint,
} from "../../domain/persistence/checkpoint.ts";
import type { InternalEvent } from "../../ports/event-log.ts";
import type { DigestService } from "../../ports/identity.ts";

export type CheckpointReadResult =
  | Readonly<{ ok: true; value: CheckpointState }>
  | Readonly<{
      ok: false;
      code:
        | "missing"
        | "invalid_document"
        | "hash_mismatch"
        | "newer_than_log"
        | "unknown_schema_version"
        | "not_a_checkpoint";
    }>;

/**
 * Checkpoint storage (V1_BASELINE section 7): write to a temporary file, flush,
 * then replace atomically. A damaged or stale checkpoint is discarded, never
 * repaired by editing history.
 */
export class JsonlCheckpointStore {
  readonly #root: string;
  readonly #digests: DigestService;
  readonly #eventsSince = new Map<string, number>();

  constructor(root: string, digests: DigestService) {
    this.#root = root;
    this.#digests = digests;
  }

  /** Count one appended event and report whether a checkpoint is now due. */
  noteEvent(sessionId: string, event: InternalEvent): boolean {
    const count = (this.#eventsSince.get(sessionId) ?? 0) + 1;
    this.#eventsSince.set(sessionId, count);
    return shouldCheckpoint(count, event.type);
  }

  resetCounter(sessionId: string): void {
    this.#eventsSince.set(sessionId, 0);
  }

  async write(
    sessionId: string,
    events: readonly InternalEvent[],
  ): Promise<CheckpointState | null> {
    const count = this.#eventsSince.get(sessionId) ?? 0;
    const checkpoint = createCheckpoint(sessionId, events, count);
    if (checkpoint === null) return null;

    const hash = await this.#digests.sha256Canonical(checkpoint);
    const document = { checkpoint, hash };
    const filePath = this.#checkpointPath(sessionId);
    const tempPath = `${filePath}.tmp`;
    await mkdir(path.dirname(filePath), {
      recursive: true,
      ...(process.platform === "linux" ? { mode: 0o700 } : {}),
    });

    const handle = await open(tempPath, "w");
    try {
      await handle.writeFile(`${JSON.stringify(document)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(tempPath, filePath);
    this.#eventsSince.set(sessionId, 0);
    return checkpoint;
  }

  async read(sessionId: string, events: readonly InternalEvent[]): Promise<CheckpointReadResult> {
    const filePath = this.#checkpointPath(sessionId);
    let raw: string;
    try {
      raw = await readFile(filePath, "utf8");
    } catch {
      return { ok: false, code: "missing" };
    }

    let document: unknown;
    try {
      document = JSON.parse(raw);
    } catch {
      return { ok: false, code: "invalid_document" };
    }

    if (typeof document !== "object" || document === null) {
      return { ok: false, code: "invalid_document" };
    }
    const record = document as Record<string, unknown>;
    const storedHash = record["hash"];
    const checkpoint = record["checkpoint"];
    if (typeof storedHash !== "string" || checkpoint === undefined) {
      return { ok: false, code: "invalid_document" };
    }
    const recomputed = await this.#digests.sha256Canonical(checkpoint);
    if (recomputed !== storedHash) return { ok: false, code: "hash_mismatch" };

    const validated = validateCheckpoint(document, events);
    if (!validated.ok) return validated;
    return { ok: true, value: validated.value };
  }

  /** Remove a checkpoint that cannot be trusted. Original events stay intact. */
  async discard(sessionId: string): Promise<void> {
    try {
      await unlink(this.#checkpointPath(sessionId));
    } catch {
      // Already absent; nothing to discard.
    }
  }

  #checkpointPath(sessionId: string): string {
    return path.join(this.#root, "sessions", sessionId, "checkpoint.json");
  }
}
