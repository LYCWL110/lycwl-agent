import { createStreamGuard, type OwnedKeyRegistry } from "../../domain/security/owned-key-guard.ts";

export class ProtectedDeliveryError extends Error {
  readonly reason: "owned_key_detected" | "guard_failure";
  constructor(reason: "owned_key_detected" | "guard_failure") {
    super("protected_delivery_blocked");
    this.reason = reason;
  }
}

/** Check decoded string fields as well as their serialized representation. */
export function assertProtectedValue(registry: OwnedKeyRegistry, value: unknown): void {
  try {
    const serialized = JSON.stringify(value, (key, entry: unknown) => {
      for (const text of [key, ...(typeof entry === "string" ? [entry] : [])]) {
        const guarded = guardText(registry, text);
        if (guarded.kind === "blocked") throw new ProtectedDeliveryError(guarded.reason);
      }
      return entry;
    });
    if (serialized !== undefined) {
      const guarded = guardText(registry, serialized);
      if (guarded.kind === "blocked") throw new ProtectedDeliveryError(guarded.reason);
    }
  } catch (error) {
    if (error instanceof ProtectedDeliveryError) throw error;
    throw new ProtectedDeliveryError("guard_failure");
  }
}

/**
 * Owned-key guard applied to a protected text exit (C10).
 *
 * A blocked payload is not delivered at all: no partial text, no truncation
 * marker claiming completeness, and no attachment reference. Blocking preserves
 * the real execution facts; it never rewrites ordinary tool output.
 */
export type GuardedText =
  | Readonly<{ kind: "delivered"; text: string }>
  | Readonly<{
      kind: "blocked";
      reason: "owned_key_detected" | "guard_failure";
    }>;

export function guardText(registry: OwnedKeyRegistry, text: string): GuardedText {
  if (registry.keys.length === 0) return { kind: "delivered", text };

  // Chunk the input so the same streaming path is exercised for every exit.
  const guard = createStreamGuard(registry);
  let delivered = "";
  for (const chunk of splitIntoChunks(text)) {
    const result = guard.push(chunk);
    if (result.blocked) {
      return { kind: "blocked", reason: result.reason ?? "owned_key_detected" };
    }
    delivered += result.emitted;
  }
  const flushed = guard.flush();
  if (flushed.blocked) {
    return { kind: "blocked", reason: flushed.reason ?? "owned_key_detected" };
  }
  return { kind: "delivered", text: delivered + flushed.emitted };
}

function splitIntoChunks(text: string): readonly string[] {
  if (text.length === 0) return [];
  const chunks: string[] = [];
  const size = 512;
  for (let index = 0; index < text.length; index += size) {
    chunks.push(text.slice(index, index + size));
  }
  return chunks;
}

/**
 * Guard a tool result before it reaches the model. A blocked result keeps its
 * actual status but loses its text, and the caller must record that delivery was
 * blocked rather than treating the call as not executed.
 */
export type ToolResultDelivery =
  | Readonly<{ status: string; text: string | null; deliveryBlocked: false }>
  | Readonly<{ status: string; text: null; deliveryBlocked: true; reason: string }>;

export function guardToolResultText(
  registry: OwnedKeyRegistry,
  status: string,
  text: string | null,
): ToolResultDelivery {
  if (text === null) return { status, text: null, deliveryBlocked: false };
  const guarded = guardText(registry, text);
  if (guarded.kind === "blocked") {
    return { status, text: null, deliveryBlocked: true, reason: guarded.reason };
  }
  return { status, text: guarded.text, deliveryBlocked: false };
}
