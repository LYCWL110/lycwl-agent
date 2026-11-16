import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { type BatchCaseSpec, runBatch } from "../../src/application/evaluation/batch.ts";
import type { EvaluationCaseId } from "../../src/domain/evaluation/labels.ts";
import type {
  AgentRunner,
  AgentRunOutcome,
  CaseVerifier,
  CaseWorkspaceProvider,
  ProvisionedWorkspace,
  VerifierOutcome,
} from "../../src/ports/evaluation.ts";
import type { InternalEvent } from "../../src/ports/event-log.ts";

/**
 * Batch orchestration turns planned samples into the artifacts a reviewer reads.
 *
 * The behaviour under test is what happens when a sample does not finish: it must
 * stay in the denominator and be reported, never disappear.
 */

const CONFIG = {
  providerId: "fixture-provider",
  modelId: "fixture-model",
  protocolId: "openai_chat",
  notes: "synthetic batch",
};

function workspace(): ProvisionedWorkspace {
  return {
    root: "D:\\eval\\workspace",
    async hashFile() {
      return "sha256:frozen";
    },
    async dispose() {},
  };
}

function provider(options: { failFor?: EvaluationCaseId } = {}): CaseWorkspaceProvider {
  return {
    async provision({ caseId }) {
      if (options.failFor === caseId) throw new Error("disk full");
      return workspace();
    },
  };
}

function verifier(): CaseVerifier {
  return {
    async verify(): Promise<VerifierOutcome> {
      return {
        assertions: [
          { assertionId: "goal", required: true, outcome: "passed", evidenceBacked: true },
        ],
      };
    },
  };
}

function agent(): AgentRunner {
  return {
    async run(): Promise<AgentRunOutcome> {
      return {
        runIdentities: ["session-1/run-1"],
        status: "completed",
        safeCode: null,
        // A minimal but well-formed event: the scanner reads `payload`, and a fake
        // without it would fail for a reason unrelated to the behaviour under test.
        events: [
          {
            eventId: "event-1",
            sessionId: "session-1",
            runId: "run-1",
            seq: 1,
            correlationId: "correlation-1",
            causationId: null,
            timestampUtc: "2026-11-13T00:00:00.000Z",
            type: "run_completed",
            payload: { kind: "run_completed", text: "done" },
            previousEventId: null,
            previousHash: null,
            hash: "hash",
          } as unknown as InternalEvent,
        ],
      };
    },
  };
}

function spec(caseId: EvaluationCaseId): BatchCaseSpec {
  return {
    caseId,
    caseVersion: 1,
    branch: "frozen branch",
    task: "do the task",
    immutableFiles: [],
  };
}

const TOOLS = new Set(["shell"]);
const MUTATING = new Set(["shell"]);

describe("a batch that completes", () => {
  it("records every planned sample and meets a complete plan", async () => {
    const cases: EvaluationCaseId[] = ["E01", "E02"];
    const result = await runBatch(
      {
        configuration: CONFIG,
        cases: cases.map(spec),
        // Two cases at three samples each: the plan is smaller than the confirmed
        // one, so the threshold is scaled by stating the plan explicitly.
        samplesPerCase: 3,
        toolsRequiringApproval: TOOLS,
        mutatingTools: MUTATING,
      },
      { workspaces: provider(), verifier: verifier(), agent: agent() },
    );
    assert.ok(!("ok" in result));
    if ("ok" in result) return;
    assert.equal(result.records.length, 6);
    assert.equal(result.blockedSamples.length, 0);
    // Only two cases ran, so the batch is short of the twelve-case plan.
    assert.ok(result.report.blockers.includes("insufficient_samples"));
    assert.equal(result.report.conclusion, "not_established");
  });
});

describe("a sample that does not finish", () => {
  it("records it as blocked and keeps it in the denominator", async () => {
    const result = await runBatch(
      {
        configuration: CONFIG,
        cases: [spec("E01"), spec("E02")],
        samplesPerCase: 3,
        toolsRequiringApproval: TOOLS,
        mutatingTools: MUTATING,
      },
      { workspaces: provider({ failFor: "E02" }), verifier: verifier(), agent: agent() },
    );
    assert.ok(!("ok" in result));
    if ("ok" in result) return;

    // E01's three samples pass; E02's three could not be provisioned.
    assert.equal(result.records.length, 6);
    assert.equal(result.blockedSamples.length, 3);
    const e02 = result.records.filter((record) => record.caseId === "E02");
    assert.equal(
      e02.every((record) => record.label === "blocked"),
      true,
    );
    assert.equal(result.report.blockers.includes("blocked_sample"), true);
    assert.equal(result.report.conclusion, "not_established");
  });

  it("renders the blocked samples into the evidence package", async () => {
    const result = await runBatch(
      {
        configuration: CONFIG,
        cases: [spec("E01"), spec("E02")],
        samplesPerCase: 1,
        toolsRequiringApproval: TOOLS,
        mutatingTools: MUTATING,
      },
      { workspaces: provider({ failFor: "E02" }), verifier: verifier(), agent: agent() },
    );
    assert.ok(!("ok" in result));
    if ("ok" in result) return;
    const text = result.render({
      candidate: { identity: "commit-abc", buildSha256: null },
      gates: [{ id: "G05", status: "open", note: "not measured" }],
      knownDefects: [],
      notRunOrBlocked: [],
      supportScope: "scope",
      rollback: "rollback",
    });
    // The blocked sample is named in the artifact, not silently dropped.
    assert.match(text, /E02-0: provision_failed/u);
    assert.match(text, /conclusion=not_established/u);
  });
});

describe("a batch that is structurally invalid", () => {
  it("refuses an empty configuration identity", async () => {
    const result = await runBatch(
      {
        configuration: { ...CONFIG, modelId: "" },
        cases: [spec("E01")],
        samplesPerCase: 1,
        toolsRequiringApproval: TOOLS,
        mutatingTools: MUTATING,
      },
      { workspaces: provider(), verifier: verifier(), agent: agent() },
    );
    assert.deepEqual(result, { ok: false, code: "invalid_configuration" });
  });
});
