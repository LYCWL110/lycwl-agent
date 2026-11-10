export class InMemoryEventLog {
    #eventsBySession = new Map();
    #ids;
    #digests;
    #writeTail = Promise.resolve();
    constructor(ids, digests) {
        this.#ids = ids;
        this.#digests = digests;
    }
    append(input) {
        const operation = this.#writeTail.then(() => this.#appendNow(input));
        this.#writeTail = operation.then(() => undefined, () => undefined);
        return operation;
    }
    async read(sessionId) {
        await this.#writeTail;
        return [...(this.#eventsBySession.get(sessionId) ?? [])];
    }
    async #appendNow(input) {
        const events = this.#eventsBySession.get(input.sessionId) ?? [];
        const previous = events.at(-1) ?? null;
        const body = {
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
        const event = {
            ...body,
            hash: await this.#digests.sha256Canonical(body),
        };
        events.push(event);
        this.#eventsBySession.set(input.sessionId, events);
        return event;
    }
}
