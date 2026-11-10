import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  checkProtectedExit,
  containsOwnedKey,
  createStreamGuard,
  emptyOwnedKeyRegistry,
  type OwnedKeyRegistry,
  registerOwnedKey,
  retireOwnedKey,
  sendingKeys,
} from "../../src/domain/security/owned-key-guard.ts";

const KEY = "sk-test-0123456789abcdef";

function registryWith(...values: readonly string[]): OwnedKeyRegistry {
  let registry = emptyOwnedKeyRegistry();
  values.forEach((value, index) => {
    const result = registerOwnedKey(registry, { keyId: `key-${index}`, value });
    assert.equal(result.ok, true);
    if (result.ok) registry = result.registry;
  });
  return registry;
}

describe("owned key registration", () => {
  it("accepts a key and starts it in the sending state", () => {
    const result = registerOwnedKey(emptyOwnedKeyRegistry(), {
      keyId: "key-1",
      value: KEY,
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.registry.keys[0]?.state, "sending");
    assert.equal(result.registry.keys[0]?.revision, 1);
  });

  it("rejects an empty value without imposing a minimum length", () => {
    assert.deepEqual(registerOwnedKey(emptyOwnedKeyRegistry(), { keyId: "k", value: "" }), {
      ok: false,
      code: "empty_key_value",
    });
    const short = registerOwnedKey(emptyOwnedKeyRegistry(), { keyId: "k", value: "a" });
    assert.equal(short.ok, true);
  });

  it("rejects an empty or duplicate key id", () => {
    assert.deepEqual(registerOwnedKey(emptyOwnedKeyRegistry(), { keyId: "", value: "v" }), {
      ok: false,
      code: "invalid_key_id",
    });
    const first = registerOwnedKey(emptyOwnedKeyRegistry(), { keyId: "k", value: "v" });
    assert.equal(first.ok, true);
    if (!first.ok) return;
    assert.deepEqual(registerOwnedKey(first.registry, { keyId: "k", value: "other" }), {
      ok: false,
      code: "duplicate_key_id",
    });
  });

  it("retires a key without dropping its protection", () => {
    const registry = registryWith(KEY);
    const retired = retireOwnedKey(registry, "key-0");
    assert.equal(retired.ok, true);
    if (!retired.ok) return;
    assert.equal(retired.registry.keys[0]?.state, "retired");
    assert.deepEqual(sendingKeys(retired.registry), []);
    // The retired value is still blocked.
    assert.equal(containsOwnedKey(retired.registry, `x${KEY}y`), true);
  });

  it("rejects retiring an unknown key", () => {
    assert.deepEqual(retireOwnedKey(registryWith(KEY), "missing"), {
      ok: false,
      code: "unknown_key",
    });
  });
});

describe("one-shot exit checks", () => {
  it("blocks a payload containing an exact key", () => {
    const registry = registryWith(KEY);
    assert.deepEqual(checkProtectedExit(registry, `before ${KEY} after`), {
      allowed: false,
      reason: "owned_key_detected",
    });
  });

  it("allows a payload without any key", () => {
    assert.deepEqual(checkProtectedExit(registryWith(KEY), "ordinary tool output"), {
      allowed: true,
    });
  });

  it("matches a short key with no length exemption", () => {
    const registry = registryWith("ab");
    assert.deepEqual(checkProtectedExit(registry, "xxabyy"), {
      allowed: false,
      reason: "owned_key_detected",
    });
  });

  it("matches inside a longer token without whole-word rules", () => {
    const registry = registryWith(KEY);
    assert.equal(containsOwnedKey(registry, `prefix_${KEY}_suffix`), true);
  });

  it("allows everything when no keys are registered", () => {
    assert.deepEqual(checkProtectedExit(emptyOwnedKeyRegistry(), `anything ${KEY}`), {
      allowed: true,
    });
  });
});

describe("streaming guard", () => {
  it("emits text once it can no longer be a key prefix", () => {
    const guard = createStreamGuard(registryWith(KEY));
    const first = guard.push("ordinary output without secrets");
    assert.equal(first.blocked, false);
    // A trailing window shorter than the key is retained.
    assert.equal(first.emitted.length, "ordinary output without secrets".length - (KEY.length - 1));
    const rest = guard.flush();
    assert.equal(rest.blocked, false);
    assert.equal(first.emitted + rest.emitted, "ordinary output without secrets");
  });

  it("detects a key split across two chunks", () => {
    const guard = createStreamGuard(registryWith(KEY));
    const head = KEY.slice(0, 8);
    const tail = KEY.slice(8);

    const first = guard.push(`leak: ${head}`);
    assert.equal(first.blocked, false);
    const second = guard.push(tail);
    assert.deepEqual(second, {
      emitted: "",
      blocked: true,
      reason: "owned_key_detected",
    });
    assert.equal(guard.isBlocked(), true);
  });

  it("stays blocked for every later chunk", () => {
    const guard = createStreamGuard(registryWith(KEY));
    guard.push(KEY);
    assert.equal(guard.isBlocked(), true);
    assert.deepEqual(guard.push("more text"), {
      emitted: "",
      blocked: true,
      reason: "owned_key_detected",
    });
    assert.deepEqual(guard.flush(), {
      emitted: "",
      blocked: true,
      reason: "owned_key_detected",
    });
  });

  it("detects a key that is only complete once the whole chunk arrives", () => {
    const guard = createStreamGuard(registryWith(KEY));
    const first = guard.push(`tail ${KEY}`);
    // The key is complete in this chunk, so it is blocked immediately and
    // nothing is emitted.
    assert.deepEqual(first, {
      emitted: "",
      blocked: true,
      reason: "owned_key_detected",
    });
    assert.deepEqual(guard.flush(), {
      emitted: "",
      blocked: true,
      reason: "owned_key_detected",
    });
  });

  it("never emits the key in any allowed chunk", () => {
    const guard = createStreamGuard(registryWith(KEY));
    const chunks = [`a${KEY.slice(0, 4)}`, KEY.slice(4, 12), KEY.slice(12), "tail"];
    let emitted = "";
    for (const chunk of chunks) {
      const result = guard.push(chunk);
      emitted += result.emitted;
      if (result.blocked) break;
    }
    const final = guard.flush();
    emitted += final.emitted;
    assert.equal(emitted.includes(KEY), false);
  });

  it("retains at most one less than the longest key", () => {
    const guard = createStreamGuard(registryWith(KEY));
    guard.push("x".repeat(100));
    assert.equal(guard.bufferedLength() <= KEY.length - 1, true);
  });

  it("passes everything through when no keys are registered", () => {
    const guard = createStreamGuard(emptyOwnedKeyRegistry());
    assert.equal(guard.push(KEY).emitted, KEY);
    assert.equal(guard.flush().blocked, false);
  });
});
