import { TextDecoder } from "node:util";
import {
  createStreamGuard,
  type GuardBlockReason,
  type OwnedKeyRegistry,
  type StreamGuard,
} from "../../domain/security/owned-key-guard.ts";

export const MAX_CAPTURE_BYTES = 8 * 1024 * 1024;
export type ProcessStream = "stdout" | "stderr";
export type CaptureOutput = Readonly<{
  stdout: string;
  stderr: string;
  /** Observed wire bytes; at most cap + 1 (the excess-byte probe). */
  rawBytes: number;
  captureComplete: boolean;
  outputLimitExceeded: boolean;
  deliveryBlocked: GuardBlockReason | null;
  /** Available only after complete, guarded decoding and EOF finalization. */
  rawOutput?: Readonly<{ stdout: Uint8Array; stderr: Uint8Array }>;
}>;

type Channel = {
  decoder: TextDecoder;
  guard: StreamGuard;
  byteGuard: StreamGuard;
  raw: Buffer[];
  text: string;
  safe: string;
};

/** No capture files: undecided/unchecked bytes stay in bounded process memory. */
export function createBoundedProcessOutput(registry: OwnedKeyRegistry = { keys: [] }) {
  let rawBytes = 0;
  let exceeded = false;
  let incomplete = false;
  let ended = false;
  let blocked: GuardBlockReason | null = null;
  let values: readonly string[] = [];
  let byteValues: readonly string[] = [];
  let lastCurrent: readonly string[] = [];
  const channel = (): Channel => ({
    decoder: new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }),
    guard: createStreamGuard({ keys: [] }),
    byteGuard: createStreamGuard({ keys: [] }),
    raw: [],
    text: "",
    safe: "",
  });
  const streams = { stdout: channel(), stderr: channel() };

  function block(reason: GuardBlockReason) {
    blocked = reason;
    for (const stream of Object.values(streams)) {
      stream.text = "";
      stream.safe = "";
      stream.guard = createStreamGuard({ keys: [] });
      stream.byteGuard = createStreamGuard({ keys: [] });
      stream.raw = [];
      stream.decoder = new TextDecoder("utf-8", { fatal: true });
    }
  }
  function protect(stream: Channel, text: string): void {
    const result = stream.guard.push(text);
    if (result.blocked) block(result.reason ?? "guard_failure");
    else stream.safe += result.emitted;
  }
  function refresh(): void {
    if (blocked !== null) return;
    const keys = registry.keys;
    if (
      keys.some(
        (key) =>
          typeof key.value !== "string" ||
          key.value.length === 0 ||
          (key.byteEncoding === "latin1" && !isLatin1(key.value)),
      )
    )
      throw new Error("invalid_protection");
    const current = keys.map((key) => `${key.byteEncoding ?? "utf8"}:${key.value}`);
    if (
      current.length === lastCurrent.length &&
      current.every((value, i) => value === lastCurrent[i])
    )
      return;
    lastCurrent = current;
    // Do not forget a retired/removed value during this process's lifetime.
    values = [...new Set([...values, ...keys.map((key) => key.value)])];
    byteValues = [
      ...new Set([
        ...byteValues,
        ...keys.flatMap((key) => [
          Buffer.from(key.value, "utf8").toString("latin1"),
          ...(key.byteEncoding === "latin1" ? [key.value] : []),
        ]),
      ]),
    ];
    const snapshot = {
      keys: values.map((value, i) => ({
        keyId: `capture-${i}`,
        value,
        state: "retired" as const,
        revision: 1,
      })),
    };
    const byteSnapshot = {
      keys: byteValues.map((value, i) => ({
        keyId: `capture-byte-${i}`,
        value,
        state: "retired" as const,
        revision: 1,
      })),
    };
    for (const stream of Object.values(streams)) {
      stream.byteGuard = createStreamGuard(byteSnapshot);
      for (const bytes of stream.raw) {
        const checked = stream.byteGuard.push(bytes.toString("latin1"));
        if (checked.blocked) {
          block(checked.reason ?? "guard_failure");
          return;
        }
      }
      stream.guard = createStreamGuard(snapshot);
      stream.safe = "";
      protect(stream, stream.text);
      if (blocked !== null) return;
      if (ended) {
        const tail = stream.guard.flush();
        if (tail.blocked) block(tail.reason ?? "guard_failure");
        else stream.safe += tail.emitted;
      }
    }
  }
  function attempt(action: () => void): void {
    if (blocked !== null) return;
    try {
      refresh();
      if (blocked === null) action();
    } catch {
      block("guard_failure");
    }
  }
  return {
    remaining: () => Math.max(0, MAX_CAPTURE_BYTES - rawBytes),
    stopped: () => blocked !== null || exceeded || incomplete,
    fail() {
      block("guard_failure");
    },
    push(name: ProcessStream, bytes: Uint8Array) {
      attempt(() => {
        if (ended || exceeded || incomplete) return;
        const length = Math.min(bytes.length, MAX_CAPTURE_BYTES - rawBytes);
        rawBytes += Math.min(bytes.length, length + 1);
        exceeded = bytes.length > length;
        if (length === 0) return;
        const stream = streams[name];
        const raw = Buffer.from(bytes.subarray(0, length));
        const checked = stream.byteGuard.push(raw.toString("latin1"));
        if (checked.blocked) {
          block(checked.reason ?? "guard_failure");
          return;
        }
        const last = stream.raw.at(-1);
        if (last !== undefined && last.length + raw.length <= 64 * 1024)
          stream.raw[stream.raw.length - 1] = Buffer.concat([last, raw]);
        else stream.raw.push(raw);
        const text = stream.decoder.decode(raw, { stream: true });
        stream.text += text;
        protect(stream, text);
      });
    },
    finish(complete: boolean) {
      attempt(() => {
        incomplete ||= !complete;
        for (const stream of Object.values(streams)) {
          // A hard-limit suffix is undecided, so it stays withheld.
          if (!complete || exceeded) continue;
          const text = stream.decoder.decode();
          stream.text += text;
          protect(stream, text);
          if (blocked !== null) return;
          const tail = stream.guard.flush();
          if (tail.blocked) block(tail.reason ?? "guard_failure");
          else stream.safe += tail.emitted;
        }
        ended = complete && !exceeded;
      });
    },
    snapshot(): CaptureOutput {
      attempt(() => {});
      return {
        stdout: blocked === null ? streams.stdout.safe : "",
        stderr: blocked === null ? streams.stderr.safe : "",
        rawBytes,
        captureComplete: !incomplete && !exceeded && blocked === null,
        outputLimitExceeded: exceeded,
        deliveryBlocked: blocked,
        ...(ended && !incomplete && blocked === null
          ? {
              rawOutput: {
                stdout: Buffer.concat(streams.stdout.raw),
                stderr: Buffer.concat(streams.stderr.raw),
              },
            }
          : {}),
      };
    },
  };
}

function isLatin1(text: string): boolean {
  for (let index = 0; index < text.length; index++) if (text.charCodeAt(index) > 0xff) return false;
  return true;
}
