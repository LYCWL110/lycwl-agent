/**
 * Incremental Server-Sent Events parser.
 *
 * The transport hands decoded text chunks in arrival order; this parser turns
 * them into complete SSE events. It supports LF, CRLF and a bare CR, including a
 * CRLF split across two chunks.
 *
 * The parser is deliberately strict about bounds. A provider that sends an
 * unbounded line or event is a broken endpoint, and buffering it would turn that
 * into a memory problem.
 */
export const SSE_LIMITS = Object.freeze({
    maxLineBytes: 256 * 1024,
    maxEventBytes: 1024 * 1024,
});
export class SseParseError extends Error {
    constructor(message) {
        super(message);
        this.name = "SseParseError";
    }
}
export class SseParser {
    #onEvent;
    #buffer = "";
    #event = null;
    #id = null;
    #data = [];
    #dataBytes = 0;
    constructor(onEvent) {
        this.#onEvent = onEvent;
    }
    /** Feed one decoded chunk. Throws `SseParseError` when a bound is exceeded. */
    push(chunk) {
        this.#buffer += chunk;
        let start = 0;
        for (let index = 0; index < this.#buffer.length; index += 1) {
            const character = this.#buffer[index];
            if (character === "\n") {
                this.#line(this.#buffer.slice(start, index));
                start = index + 1;
                continue;
            }
            if (character === "\r") {
                if (index + 1 >= this.#buffer.length)
                    break;
                this.#line(this.#buffer.slice(start, index));
                start = index + 1;
                if (this.#buffer[index + 1] === "\n") {
                    index += 1;
                    start += 1;
                }
            }
        }
        this.#buffer = this.#buffer.slice(start);
        if (Buffer.byteLength(this.#buffer, "utf8") > SSE_LIMITS.maxLineBytes) {
            throw new SseParseError("sse_line_too_large");
        }
    }
    /**
     * Finish the stream.
     *
     * A final line without a terminator is processed, then a pending event is
     * dispatched. A truly truncated event is left to the adapter's completion
     * check; the parser cannot know whether the provider meant to finish.
     */
    end() {
        if (this.#buffer.length > 0) {
            this.#line(this.#buffer);
            this.#buffer = "";
        }
        this.#dispatch();
    }
    #line(line) {
        if (line.length === 0) {
            this.#dispatch();
            return;
        }
        if (line.startsWith(":"))
            return;
        const separator = line.indexOf(":");
        const field = separator === -1 ? line : line.slice(0, separator);
        let value = separator === -1 ? "" : line.slice(separator + 1);
        if (value.startsWith(" "))
            value = value.slice(1);
        if (field === "data") {
            this.#data.push(value);
            this.#dataBytes += Buffer.byteLength(value, "utf8") + 1;
            if (this.#dataBytes > SSE_LIMITS.maxEventBytes) {
                throw new SseParseError("sse_event_too_large");
            }
            return;
        }
        if (field === "event") {
            this.#event = value;
            return;
        }
        if (field === "id") {
            this.#id = value;
            return;
        }
        // `retry` and unknown fields are intentionally ignored.
    }
    #dispatch() {
        if (this.#data.length === 0) {
            this.#event = null;
            this.#id = null;
            this.#dataBytes = 0;
            return;
        }
        const event = {
            event: this.#event,
            data: this.#data.join("\n"),
            id: this.#id,
        };
        this.#event = null;
        this.#id = null;
        this.#data = [];
        this.#dataBytes = 0;
        this.#onEvent(event);
    }
}
