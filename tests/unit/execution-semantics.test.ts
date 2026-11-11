import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  defaultSemantics,
  mayRetryAutomatically,
  resolveUncertainty,
  type ToolExecutionSemantics,
} from "../../src/domain/tool-invocation/execution-semantics.ts";

/**
 * Tool execution semantics.
 *
 * The rules these tests protect:
 *
 * - A class whose operations are sometimes repeatable is treated as not repeatable.
 *   Assuming idempotence is the mistake that duplicates a side effect.
 * - An inconclusive verification is not a verdict. Reporting either answer from a
 *   check that settled nothing would be a fabricated fact.
 */

describe("defaultSemantics", () => {
  it("treats a read as idempotent and safely retryable", () => {
    assert.deepEqual(defaultSemantics("read_only"), { idempotent: true, retry: "safe" });
  });

  it("treats a filesystem mutation as idempotent in effect but not auto-retried", () => {
    // A second delete of an absent file fails, but the state is the same; the
    // decision to retry belongs to the caller that knows the invocation.
    assert.deepEqual(defaultSemantics("filesystem_mutation"), {
      idempotent: true,
      retry: "conditional",
    });
  });

  it("treats a process as non-idempotent and never auto-retried", () => {
    // A command can do anything, including things that must not happen twice.
    assert.deepEqual(defaultSemantics("process_execution"), {
      idempotent: false,
      retry: "never",
    });
  });

  it("treats an external request as non-idempotent and never auto-retried", () => {
    // A request may have been received even when the response was lost.
    assert.deepEqual(defaultSemantics("external_request"), {
      idempotent: false,
      retry: "never",
    });
  });
});

describe("mayRetryAutomatically", () => {
  it("permits a safe retry only when the operation is idempotent", () => {
    const idempotent: ToolExecutionSemantics = { idempotent: true, retry: "safe" };
    const notIdempotent: ToolExecutionSemantics = { idempotent: false, retry: "safe" };
    assert.equal(mayRetryAutomatically(idempotent), true);
    // A contradictory declaration resolves to the conservative answer.
    assert.equal(mayRetryAutomatically(notIdempotent), false);
  });

  it("never permits a never-retry operation", () => {
    assert.equal(mayRetryAutomatically({ idempotent: true, retry: "never" }), false);
    assert.equal(mayRetryAutomatically({ idempotent: false, retry: "never" }), false);
  });

  it("does not decide a conditional retry itself", () => {
    // The caller has the invocation in hand; this module does not guess.
    assert.equal(mayRetryAutomatically({ idempotent: true, retry: "conditional" }), false);
  });
});

describe("resolveUncertainty", () => {
  it("reports applied when the check confirms the effect", () => {
    assert.deepEqual(resolveUncertainty("applied", "check it"), { kind: "applied" });
  });

  it("reports not_applied when the check confirms the effect is absent", () => {
    assert.deepEqual(resolveUncertainty("not_applied", "check it"), { kind: "not_applied" });
  });

  it("stays unresolved when the check settled nothing", () => {
    // The important case: an inconclusive check must not become a verdict.
    const resolved = resolveUncertainty("inconclusive", "inspect the target");
    assert.equal(resolved.kind, "unresolved");
    assert.equal(resolved.kind === "unresolved" ? resolved.guidance : "", "inspect the target");
  });

  it("stays unresolved when no check exists", () => {
    const resolved = resolveUncertainty(null, "inspect the target");
    assert.equal(resolved.kind, "unresolved");
  });

  it("falls back to a generic instruction when the tool offers no guidance", () => {
    const resolved = resolveUncertainty(null, undefined);
    assert.equal(resolved.kind, "unresolved");
    assert.match(resolved.kind === "unresolved" ? resolved.guidance : "", /could not be verified/);
  });
});
