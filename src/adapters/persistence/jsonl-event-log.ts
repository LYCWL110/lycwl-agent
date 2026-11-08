import { mkdir, open, readFile } from "node:fs/promises";
import path from "node:path";
import { parseJsonc } from "../../domain/config/jsonc.ts";
import { isSessionId } from "../../domain/identity/session-id.ts";

import type {
  EventInput,
  EventLog,
  InternalEvent,
  InternalEventBody,
} from "../../ports/event-log.ts";
import type { DigestService, IdentifierFactory } from "../../ports/identity.ts";
import {
  acquireExclusiveFileLease,
  type ExclusiveFileLease,
} from "../windows/exclusive-file-lease.ts";
import { hasValidInternalEventRelations } from "./internal-event-relations.ts";
import { isInternalEvent } from "./internal-event-validation.ts";

export type JsonlReadResult =
  | Readonly<{ ok: true; events: readonly InternalEvent[] }>
  | Readonly<{ ok: false; code: "middle_corruption" | "invalid_event" | "integrity_failure" }>;

export class JsonlEventLog implements EventLog {
  readonly #root: string;
  readonly #ids: IdentifierFactory;
  readonly #digests: DigestService;
  readonly #writeTails = new Map<string, Promise<void>>();

  constructor(root: string, ids: IdentifierFactory, digests: DigestService) {
    this.#root = root;
    this.#ids = ids;
    this.#digests = digests;
  }

  append(input: EventInput): Promise<InternalEvent> {
    const previousTail = this.#writeTails.get(input.sessionId) ?? Promise.resolve();
    const operation = previousTail.then(() => this.#appendNow(input));
    this.#writeTails.set(
      input.sessionId,
      operation.then(
        () => undefined,
        () => undefined,
      ),
    );
    return operation;
  }

  async read(sessionId: string): Promise<readonly InternalEvent[]> {
    await (this.#writeTails.get(sessionId) ?? Promise.resolve());
    const result = await this.readWithRecovery(sessionId);
    if (!result.ok) throw new Error(result.code);
    return result.events;
  }

  async readWithRecovery(sessionId: string): Promise<JsonlReadResult> {
    const filePath = this.#eventPath(sessionId);
    let bytes: Buffer;
    try {
      bytes = await readFile(filePath);
    } catch (error) {
      if (isNotFound(error)) return { ok: true, events: [] };
      throw error;
    }
    if (bytes.length === 0) return { ok: true, events: [] };

    const endsWithNewline = bytes.at(-1) === 0x0a;
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      return { ok: false, code: "invalid_event" };
    }
    const lines = text.split("\n");
    if (endsWithNewline) lines.pop();
    const events: InternalEvent[] = [];
    const eventIds = new Set<string>();

    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index] ?? "";
      try {
        const value: unknown = JSON.parse(line);
        // JSON.parse alone silently accepts duplicate keys.
        if (!parseJsonc(line).ok) return { ok: false, code: "invalid_event" };
        if (!isInternalEvent(value)) return { ok: false, code: "invalid_event" };
        const previous = events.at(-1);
        if (
          value.sessionId !== sessionId ||
          value.seq !== (previous?.seq ?? 0) + 1 ||
          value.previousEventId !== (previous?.eventId ?? null) ||
          value.previousHash !== (previous?.hash ?? null) ||
          eventIds.has(value.eventId)
        )
          return { ok: false, code: "integrity_failure" };
        const { hash, ...body } = value;
        if ((await this.#digests.sha256Canonical(body)) !== hash)
          return { ok: false, code: "integrity_failure" };
        events.push(value);
        eventIds.add(value.eventId);
      } catch {
        const isTail = index === lines.length - 1 && !endsWithNewline;
        return { ok: false, code: isTail ? "invalid_event" : "middle_corruption" };
      }
    }
    if (!endsWithNewline) return { ok: false, code: "invalid_event" };
    if (!hasValidInternalEventRelations(events)) return { ok: false, code: "invalid_event" };
    return { ok: true, events };
  }

  async acquireSessionOwnership(sessionId: string): Promise<ExclusiveFileLease> {
    return acquireExclusiveFileLease(
      path.join(path.dirname(this.#eventPath(sessionId)), "session.lock"),
      {
        timeoutMs: 0,
      },
    );
  }

  async #appendNow(input: EventInput): Promise<InternalEvent> {
    const lock = await acquireExclusiveFileLease(
      path.join(path.dirname(this.#eventPath(input.sessionId)), "writer.lock"),
    );
    try {
      return await this.#appendLocked(input);
    } finally {
      lock.release();
    }
  }

  async #appendLocked(input: EventInput): Promise<InternalEvent> {
    const existing = await this.readWithRecovery(input.sessionId);
    if (!existing.ok) {
      throw new Error(existing.code);
    }
    const previous = existing.events.at(-1) ?? null;
    const body: InternalEventBody = {
      schemaVersion: 1,
      eventId: this.#ids.create(),
      sessionId: input.sessionId,
      runId: input.runId,
      seq: (previous?.seq ?? 0) + 1,
      timestampUtc: input.timestampUtc,
      type: input.type,
      correlationId: input.correlationId,
      causationId: input.causationId,
      previousEventId: previous?.eventId ?? null,
      previousHash: previous?.hash ?? null,
      payload: input.payload,
    };
    const event: InternalEvent = {
      ...body,
      hash: await this.#digests.sha256Canonical(body),
    };
    if (!isInternalEvent(event)) throw new Error("invalid_event");
    if (!hasValidInternalEventRelations([...existing.events, event]))
      throw new Error("invalid_event");
    const filePath = this.#eventPath(input.sessionId);
    await mkdir(path.dirname(filePath), { recursive: true });
    const handle = await open(filePath, "a");
    try {
      await handle.writeFile(`${JSON.stringify(event)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    return event;
  }

  #eventPath(sessionId: string): string {
    if (!isSessionId(sessionId)) throw new Error("invalid_session_id");
    return path.join(this.#root, "sessions", sessionId, "events.jsonl");
  }
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
