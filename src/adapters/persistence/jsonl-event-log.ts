import { mkdir, open, readFile } from "node:fs/promises";
import path from "node:path";

import type { EventInput, EventLog } from "../../application/coordinator/event-log.ts";
import type { InternalEvent, InternalEventBody } from "../../application/coordinator/internal-events.ts";
import type { DigestService, IdentifierFactory } from "../../ports/identity.ts";

export type JsonlReadResult =
  | Readonly<{ ok: true; events: readonly InternalEvent[] }>
  | Readonly<{ ok: false; code: "middle_corruption" | "invalid_event" }>;

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
    const lines = bytes.toString("utf8").split("\n");
    if (endsWithNewline) lines.pop();
    const events: InternalEvent[] = [];

    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index] ?? "";
      try {
        const value: unknown = JSON.parse(line);
        if (!isInternalEvent(value)) return { ok: false, code: "invalid_event" };
        events.push(value);
      } catch {
        const isTail = index === lines.length - 1 && !endsWithNewline;
        return { ok: false, code: isTail ? "invalid_event" : "middle_corruption" };
      }
    }
    return { ok: true, events };
  }

  async #appendNow(input: EventInput): Promise<InternalEvent> {
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
    return path.join(this.#root, "sessions", sessionId, "events.jsonl");
  }
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}

function isInternalEvent(value: unknown): value is InternalEvent {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    candidate.schemaVersion === 1 &&
    typeof candidate.eventId === "string" &&
    typeof candidate.sessionId === "string" &&
    typeof candidate.runId === "string" &&
    typeof candidate.seq === "number" &&
    Number.isSafeInteger(candidate.seq) &&
    typeof candidate.timestampUtc === "string" &&
    typeof candidate.type === "string" &&
    typeof candidate.correlationId === "string" &&
    (typeof candidate.causationId === "string" || candidate.causationId === null) &&
    (typeof candidate.previousEventId === "string" || candidate.previousEventId === null) &&
    (typeof candidate.previousHash === "string" || candidate.previousHash === null) &&
    typeof candidate.payload === "object" &&
    candidate.payload !== null &&
    typeof candidate.hash === "string"
  );
}
