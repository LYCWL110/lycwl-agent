/**
 * Owned-key exit guard (C10 / ADR-0004 / ADR-0007).
 *
 * Harness-owned Provider keys must never reach model context, logs, tool output
 * or attachments. This guard checks registered exact values before a protected
 * exit and blocks the payload rather than rewriting it.
 *
 * Design points that matter:
 * - exact substring matching, so short keys get the same treatment as long ones;
 * - no whole-word or length exemption;
 * - streaming prefix buffering so a key split across chunks is still caught;
 * - fail closed: an unusable guard blocks rather than passing text through;
 * - retired keys stay protected, so rotation cannot unprotect in-flight data.
 *
 * This is not a general secret scanner and not OS isolation. Unregistered
 * transformations and same-user bypasses remain outside reliable matching.
 */

export type OwnedKeyState = "sending" | "retired";

export type OwnedKey = Readonly<{
  keyId: string;
  /** The exact secret value. Never included in any diagnostic output. */
  value: string;
  state: OwnedKeyState;
  revision: number;
}>;

export type OwnedKeyRegistry = Readonly<{
  keys: readonly OwnedKey[];
}>;

export type RegistryFailure =
  | "invalid_key_id"
  | "empty_key_value"
  | "duplicate_key_id"
  | "unknown_key";

export type RegistryResult =
  | Readonly<{ ok: true; registry: OwnedKeyRegistry }>
  | Readonly<{ ok: false; code: RegistryFailure }>;

export function emptyOwnedKeyRegistry(): OwnedKeyRegistry {
  return { keys: [] };
}

export function registerOwnedKey(
  registry: OwnedKeyRegistry,
  input: Readonly<{ keyId: string; value: string; revision?: number }>,
): RegistryResult {
  if (input.keyId.length === 0) return { ok: false, code: "invalid_key_id" };
  // ADR-0007: empty credentials are rejected; no universal minimum length.
  if (input.value.length === 0) return { ok: false, code: "empty_key_value" };
  if (registry.keys.some((key) => key.keyId === input.keyId)) {
    return { ok: false, code: "duplicate_key_id" };
  }
  return {
    ok: true,
    registry: {
      keys: [
        ...registry.keys,
        {
          keyId: input.keyId,
          value: input.value,
          state: "sending",
          revision: input.revision ?? 1,
        },
      ],
    },
  };
}

/**
 * Stop using a key for new sends while keeping its value protected. Deletion of
 * a Provider removes sending authority; it does not silently claim that
 * historical protective copies were erased.
 */
export function retireOwnedKey(registry: OwnedKeyRegistry, keyId: string): RegistryResult {
  if (!registry.keys.some((key) => key.keyId === keyId)) {
    return { ok: false, code: "unknown_key" };
  }
  return {
    ok: true,
    registry: {
      keys: registry.keys.map((key) =>
        key.keyId === keyId ? { ...key, state: "retired" as const } : key,
      ),
    },
  };
}

/** Keys that may still be used for a new send. */
export function sendingKeys(registry: OwnedKeyRegistry): readonly OwnedKey[] {
  return registry.keys.filter((key) => key.state === "sending");
}

export type GuardBlockReason = "owned_key_detected" | "guard_failure";

export type GuardChunkResult = Readonly<{
  /** Text that is safe to forward. Empty while blocked. */
  emitted: string;
  blocked: boolean;
  reason: GuardBlockReason | null;
}>;

export type StreamGuard = Readonly<{
  push: (chunk: string) => GuardChunkResult;
  flush: () => GuardChunkResult;
  isBlocked: () => boolean;
  /** Number of characters currently held back for cross-chunk matching. */
  bufferedLength: () => number;
}>;

const BLOCKED_DETECTED: GuardChunkResult = {
  emitted: "",
  blocked: true,
  reason: "owned_key_detected",
};
const BLOCKED_FAILURE: GuardChunkResult = {
  emitted: "",
  blocked: true,
  reason: "guard_failure",
};

/**
 * Create a streaming guard. Text is released as soon as it can no longer be the
 * prefix of any registered key; a trailing window of `maxKeyLength - 1`
 * characters is retained between calls so a split match is still detected.
 */
export function createStreamGuard(registry: OwnedKeyRegistry): StreamGuard {
  let blocked = false;
  let pending = "";

  const values = registry.keys.map((key) => key.value);
  const maxLength = values.reduce((longest, value) => Math.max(longest, value.length), 0);
  const retain = Math.max(0, maxLength - 1);

  function scan(text: string): boolean {
    return values.some((value) => text.includes(value));
  }

  return {
    push(chunk: string): GuardChunkResult {
      if (blocked) return BLOCKED_DETECTED;
      try {
        pending += chunk;
        if (scan(pending)) {
          blocked = true;
          pending = "";
          return BLOCKED_DETECTED;
        }
        if (pending.length <= retain) {
          return { emitted: "", blocked: false, reason: null };
        }
        const cut = pending.length - retain;
        const emitted = pending.slice(0, cut);
        pending = pending.slice(cut);
        return { emitted, blocked: false, reason: null };
      } catch {
        blocked = true;
        pending = "";
        return BLOCKED_FAILURE;
      }
    },

    flush(): GuardChunkResult {
      if (blocked) return BLOCKED_DETECTED;
      try {
        const text = pending;
        pending = "";
        if (scan(text)) {
          blocked = true;
          return BLOCKED_DETECTED;
        }
        return { emitted: text, blocked: false, reason: null };
      } catch {
        blocked = true;
        return BLOCKED_FAILURE;
      }
    },

    isBlocked: () => blocked,
    bufferedLength: () => pending.length,
  };
}

/**
 * One-shot check for a complete payload. Use the streaming guard for anything
 * that arrives in chunks or crosses a decoding boundary.
 */
export function containsOwnedKey(registry: OwnedKeyRegistry, text: string): boolean {
  return registry.keys.some((key) => text.includes(key.value));
}

export type ExitDecision =
  | Readonly<{ allowed: true }>
  | Readonly<{ allowed: false; reason: GuardBlockReason }>;

/**
 * Decide whether a complete protected payload may leave. A blocked payload keeps
 * the real execution facts: blocking is not evidence that nothing happened and
 * is not retry authority.
 */
export function checkProtectedExit(registry: OwnedKeyRegistry, text: string): ExitDecision {
  try {
    if (containsOwnedKey(registry, text)) {
      return { allowed: false, reason: "owned_key_detected" };
    }
    return { allowed: true };
  } catch {
    return { allowed: false, reason: "guard_failure" };
  }
}
