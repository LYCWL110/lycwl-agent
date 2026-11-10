import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";

import type { EvidenceRef } from "../../src/domain/evidence/evidence-ref.ts";
import {
  type Assertion,
  aggregateVerification,
  buildReportSnapshot,
  modelClaimAsAssertion,
  reassessApplicability,
  renderReport,
} from "../../src/domain/evidence/verification.ts";

const sha256 = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");
const HEX = sha256("x");

const GOOD_EVIDENCE: readonly EvidenceRef[] = [
  { kind: "event", sessionId: "s", eventId: "e1", seq: 1 },
];

function assertion(overrides: Partial<Assertion> = {}): Assertion {
  return {
    assertionId: "a1",
    kind: "required_goal",
    description: "the feature works",
    state: "passed",
    applicability: "current",
    evidence: GOOD_EVIDENCE,
    unavailableEvidence: [],
    required: true,
    ...overrides,
  };
}

describe("verification aggregation", () => {
  it("verifies when every required assertion passes with current evidence", () => {
    const result = aggregateVerification([assertion(), assertion({ assertionId: "a2" })]);
    assert.equal(result.status, "verified");
    assert.deepEqual(result.blockers, []);
  });

  it("does not verify when there are no required assertions", () => {
    const result = aggregateVerification([assertion({ required: false })]);
    assert.equal(result.status, "unverified");
  });

  it("does not verify on evidence-free passes", () => {
    const result = aggregateVerification([assertion({ evidence: [] })]);
    assert.notEqual(result.status, "verified");
  });

  it("does not accept a stale pass as current verification", () => {
    const result = aggregateVerification([assertion({ applicability: "stale" })]);
    assert.equal(result.status, "unverified");
  });

  it("accepts an explicitly unaffected pass", () => {
    const result = aggregateVerification([assertion({ applicability: "unaffected" })]);
    assert.equal(result.status, "verified");
  });

  it("reports partially_verified when one required goal passes and another is in progress", () => {
    const result = aggregateVerification([
      assertion(),
      assertion({ assertionId: "a2", state: "in_progress", evidence: [] }),
    ]);
    assert.equal(result.status, "partially_verified");
  });

  it("does not let a minor non-required check downgrade a verified required goal", () => {
    // `verified` is defined over the required assertions plus necessary blockers;
    // an optional supporting check still in progress is reported per-assertion
    // rather than blocking the goal.
    const result = aggregateVerification([
      assertion(),
      assertion({ assertionId: "a2", state: "in_progress", evidence: [], required: false }),
    ]);
    assert.equal(result.status, "verified");
    const optional = result.perAssertion.find((entry) => entry.assertionId === "a2");
    assert.equal(optional?.status, "unverified");
  });

  it("blocks when required evidence is unavailable", () => {
    const result = aggregateVerification([
      assertion({
        unavailableEvidence: [
          { ref: GOOD_EVIDENCE[0] as EvidenceRef, reason: "attachment_missing" },
        ],
      }),
    ]);
    assert.equal(result.status, "blocked");
    assert.ok(result.blockers.some((blocker) => blocker.reason === "evidence_missing"));
  });

  it("blocks when a required check was not run", () => {
    const result = aggregateVerification([assertion({ state: "not_run", evidence: [] })]);
    assert.equal(result.status, "blocked");
    assert.ok(result.blockers.some((blocker) => blocker.reason === "not_run_required"));
  });

  it("blocks when an external change makes scope indeterminate", () => {
    const result = aggregateVerification([assertion({ applicability: "indeterminate" })]);
    assert.equal(result.status, "blocked");
    assert.ok(result.blockers.some((blocker) => blocker.reason === "unknown_side_effect"));
  });

  it("reports failed for an applicable failure", () => {
    const result = aggregateVerification([assertion({ state: "failed" })]);
    assert.equal(result.status, "failed");
  });

  it("does not keep failing forever after a later pass at the current version", () => {
    // The earlier failure stays a historical fact in the event log; the assertion
    // itself now passes with current evidence.
    const result = aggregateVerification([assertion({ state: "passed" })]);
    assert.equal(result.status, "verified");
  });

  it("shows failed AND retains blockers rather than hiding them", () => {
    const result = aggregateVerification([
      assertion({ assertionId: "failing", state: "failed" }),
      assertion({
        assertionId: "blocked-one",
        unavailableEvidence: [
          { ref: GOOD_EVIDENCE[0] as EvidenceRef, reason: "capture_truncated" },
        ],
      }),
    ]);
    assert.equal(result.status, "failed");
    assert.ok(result.blockers.some((blocker) => blocker.assertionId === "blocked-one"));
  });

  it("keeps a per-assertion status so one total cannot hide detail", () => {
    const result = aggregateVerification([
      assertion({ assertionId: "ok" }),
      assertion({ assertionId: "stale", applicability: "stale" }),
    ]);
    const stale = result.perAssertion.find((entry) => entry.assertionId === "stale");
    assert.equal(stale?.status, "unverified");
  });

  it("never lets a stale failure count as a current failure", () => {
    const result = aggregateVerification([assertion({ state: "failed", applicability: "stale" })]);
    assert.equal(result.status, "unverified");
  });
});

describe("model claims are never evidence", () => {
  it("returns an unrequired claim assertion with no evidence", () => {
    const claim = modelClaimAsAssertion({
      assertionId: "c1",
      description: "the model says it works",
      modelSaysPassed: true,
    });
    assert.equal(claim.kind, "model_claim");
    assert.equal(claim.required, false);
    assert.deepEqual(claim.evidence, []);
    assert.equal(claim.applicability, "stale");
  });

  it("cannot verify a report on its own", () => {
    const result = aggregateVerification([
      modelClaimAsAssertion({ assertionId: "c1", description: "x", modelSaysPassed: true }),
    ]);
    assert.equal(result.status, "unverified");
  });
});

describe("version applicability after change", () => {
  it("marks a check stale after an unproven code change", () => {
    assert.equal(
      reassessApplicability("current", { scope: "code", provenUnrelated: false }),
      "stale",
    );
  });

  it("keeps applicability when the change is proven unrelated", () => {
    assert.equal(
      reassessApplicability("current", { scope: "code", provenUnrelated: true }),
      "unaffected",
    );
  });

  it("marks scope indeterminate for an unknown change", () => {
    assert.equal(
      reassessApplicability("current", { scope: "unknown", provenUnrelated: false }),
      "indeterminate",
    );
  });

  it("treats a test-file or dependency change conservatively", () => {
    assert.equal(
      reassessApplicability("current", { scope: "test_files", provenUnrelated: false }),
      "stale",
    );
    assert.equal(
      reassessApplicability("current", { scope: "dependencies", provenUnrelated: false }),
      "stale",
    );
  });
});

describe("report snapshots", () => {
  function report(overrides: Partial<Parameters<typeof buildReportSnapshot>[0]> = {}) {
    return buildReportSnapshot({
      sessionId: "s",
      runId: "r",
      sourceHighWaterSeq: 10,
      projectionVersion: "proj-1",
      generatorVersion: "report-1",
      view: "terminal",
      userGoal: "do the thing",
      assertions: [assertion()],
      changes: [],
      tests: [],
      unknownSideEffects: [],
      backgroundTasks: [],
      nextUserActions: [],
      usage: { knownUsd: 0, unknownChargeCount: 0 },
      ...overrides,
    });
  }

  it("builds a verified snapshot", () => {
    const result = report();
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.value.verification.status, "verified");
    assert.equal(result.value.view, "terminal");
    assert.equal(result.value.evidenceAvailable, true);
  });

  it("rejects an empty identity", () => {
    const result = report({ sessionId: "" });
    assert.deepEqual(result, { ok: false, code: "invalid_identity" });
  });

  it("rejects a high-water regression", () => {
    const result = report({ sourceHighWaterSeq: 5, previousHighWaterSeq: 10 });
    assert.deepEqual(result, { ok: false, code: "high_water_regression" });
  });

  it("rejects a missing projection or generator version", () => {
    assert.equal(report({ projectionVersion: "" }).ok, false);
    assert.equal(report({ generatorVersion: "" }).ok, false);
  });

  it("does not turn unknown items into successes on rebuild", () => {
    // Same high-water seq, same assertions: the aggregate must be identical.
    const first = report();
    const second = report();
    assert.equal(first.ok && second.ok, true);
    if (!first.ok || !second.ok) return;
    assert.deepEqual(first.value.verification, second.value.verification);

    const withUnknown = report({
      assertions: [assertion()],
      unknownSideEffects: ["external formatter may have run"],
    });
    assert.equal(withUnknown.ok, true);
    if (!withUnknown.ok) return;
    // The unknown side effect is retained, not absorbed into the status.
    assert.deepEqual(withUnknown.value.unknownSideEffects, ["external formatter may have run"]);
  });

  it("marks evidence unavailable when any assertion has an unavailable reference", () => {
    const result = report({
      assertions: [
        assertion({
          unavailableEvidence: [{ ref: GOOD_EVIDENCE[0] as EvidenceRef, reason: "hash_mismatch" }],
        }),
      ],
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.value.evidenceAvailable, false);
    assert.equal(result.value.verification.status, "blocked");
  });

  it("keeps unknown charges visible in the report", () => {
    const result = report({ usage: { knownUsd: 0.5, unknownChargeCount: 2 } });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    const rendered = renderReport(result.value);
    assert.match(rendered, /unknownCharges=2/);
  });

  it("shows the wait reason and its specific action, not a generic continue", () => {
    const result = report({
      view: "waiting",
      wait: { reason: "approval", waitToken: "w1", requiredAction: "reply_approval" },
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    const rendered = renderReport(result.value);
    assert.match(rendered, /waiting=approval action=reply_approval/);
  });

  it("renders blockers so a summary cannot omit them", () => {
    const result = report({
      assertions: [assertion({ state: "not_run", evidence: [] })],
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    const rendered = renderReport(result.value);
    assert.match(rendered, /blocker: a1 not_run_required/);
    assert.match(rendered, /verification=blocked/);
  });
});
