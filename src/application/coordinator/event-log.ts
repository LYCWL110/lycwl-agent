import type { DigestService, IdentifierFactory } from "../../ports/identity.ts";
import type {
  InternalEvent,
  InternalEventBody,
  InternalEventPayload,
} from "./internal-events.ts";

export type EventInput = Readonly<{
  sessionId: string;
  runId: string;
  type: InternalEventPayload["kind"];
  correlationId: string;
  causationId: string | null;
  timestampUtc: string;
  payload: InternalEventPayload;
}>;

export interface EventLog {
  append(input: EventInput): Promise<InternalEvent>;
  read(sessionId: string): Promise<readonly InternalEvent[]>;
}

export class InMemoryEventLog implements EventLog {
  readonly #eventsBySession = new Map<string, InternalEvent[]>();
  readonly #ids: IdentifierFactory;
  readonly #digests: DigestService;
  #writeTail: Promise<void> = Promise.resolve();

  constructor(ids: IdentifierFactory, digests: DigestService) {
    this.#ids = ids;
    this.#digests = digests;
  }

  append(input: EventInput): Promise<InternalEvent> {
    const operation = this.#writeTail.then(() => this.#appendNow(input));
    this.#writeTail = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  async read(sessionId: string): Promise<readonly InternalEvent[]> {
    await this.#writeTail;
    return [...(this.#eventsBySession.get(sessionId) ?? [])];
  }

  async #appendNow(input: EventInput): Promise<InternalEvent> {
    const events = this.#eventsBySession.get(input.sessionId) ?? [];
    const previous = events.at(-1) ?? null;
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
    events.push(event);
    this.#eventsBySession.set(input.sessionId, events);
    return event;
  }
}
