/**
 * Batch orchestration for one quality configuration
 * (V1_EVALUATION_AND_RELEASE.md sections 4, 5.2 and 6.2).
 *
 * This runs the planned samples for a configuration and produces the artifacts a
 * reviewer reads: the sample records, the aggregation and, on request, the evidence
 * package. It deliberately does none of the deciding:
 *
 * - It does not pick a model, a budget or a branch. Those are inputs.
 * - It does not decide to release. `aggregateEvaluation` reports what the records
 *   support and names every blocker.
 * - It does not skip a sample that fails to provision or run. A sample that could
 *   not complete is recorded as `blocked` with a reason, because section 5.2 keeps
 *   it in the denominator.
 *
 * Samples run serially. A batch is not a throughput benchmark, and running them in
 * parallel would let two samples share machine state and contaminate each other.
 */

import {
  type AggregationResult,
  aggregateEvaluation,
  type EvaluationReport,
} from "../../domain/evaluation/aggregation.ts";
import { renderEvidencePackage } from "../../domain/evaluation/evidence-package.ts";
import { EVALUATION_THRESHOLDS, type EvaluationCaseId } from "../../domain/evaluation/labels.ts";
import { createSampleRecord, type SampleRecord } from "../../domain/evaluation/sample-record.ts";
import type { AgentRunner, CaseVerifier, CaseWorkspaceProvider } from "../../ports/evaluation.ts";
import { runSample, type SampleRunInput } from "./sample-runner.ts";

export type BatchCaseSpec = Readonly<{
  caseId: EvaluationCaseId;
  /** The frozen case version this batch runs. */
  caseVersion: number;
  /** The frozen sampling branch. */
  branch: string;
  /** The task text handed to the agent. */
  task: string;
  /** Files that must not change; a change is a process violation. */
  immutableFiles: readonly string[];
}>;

export type BatchInput = Readonly<{
  configuration: EvaluationReport["configuration"];
  /** Cases to run. Omitted cases stay missing and block the claim. */
  cases: readonly BatchCaseSpec[];
  /** Samples per case. Defaults to the confirmed three. */
  samplesPerCase?: number;
  /** Tools whose dispatch requires an approved decision. */
  toolsRequiringApproval: ReadonlySet<string>;
  /** Tools whose repeated success is a duplicated side effect. */
  mutatingTools: ReadonlySet<string>;
}>;

export type BatchDependencies = Readonly<{
  workspaces: CaseWorkspaceProvider;
  verifier: CaseVerifier;
  agent: AgentRunner;
}>;

export type EvidenceInput = Readonly<{
  candidate: Readonly<{ identity: string; buildSha256: string | null }>;
  gates: readonly Readonly<{ id: string; status: "open" | "passed" | "failed"; note: string }>[];
  knownDefects: readonly string[];
  notRunOrBlocked: readonly string[];
  supportScope: string;
  rollback: string;
}>;

export type BatchOutcome = Readonly<{
  records: readonly SampleRecord[];
  report: EvaluationReport;
  /** Samples that could not complete, with their safe code. */
  blockedSamples: readonly string[];
  /** Render the evidence package for these records. Pure; safe to call twice. */
  render: (input: EvidenceInput) => string;
}>;

type AggregationFailureCode = Extract<AggregationResult, { ok: false }>["code"];

export type BatchFailure = Readonly<{
  ok: false;
  code: AggregationFailureCode;
  detail?: string;
}>;

/**
 * Run every planned sample for one configuration.
 *
 * A sample that fails to provision or whose agent throws is recorded as `blocked`,
 * not dropped. That is the difference between "this sample did not finish" and
 * "this sample does not exist", and only the first is honest. When even a blocked
 * record cannot be built, the sample stays only in `blockedSamples`, which leaves
 * the batch short and is reported as insufficient samples.
 */
export async function runBatch(
  input: BatchInput,
  dependencies: BatchDependencies,
): Promise<BatchOutcome | BatchFailure> {
  const samplesPerCase = input.samplesPerCase ?? EVALUATION_THRESHOLDS.samplesPerCase;
  const records: SampleRecord[] = [];
  const blockedSamples: string[] = [];

  for (const spec of input.cases) {
    for (let index = 0; index < samplesPerCase; index += 1) {
      const sampleInput: SampleRunInput = {
        sampleId: `${spec.caseId}-${index}`,
        caseId: spec.caseId,
        caseVersion: spec.caseVersion,
        branch: spec.branch,
        task: spec.task,
        immutableFiles: spec.immutableFiles,
        toolsRequiringApproval: input.toolsRequiringApproval,
        mutatingTools: input.mutatingTools,
      };
      const outcome = await runSample(sampleInput, dependencies);
      if (outcome.ok) {
        records.push(outcome.record);
        continue;
      }
      blockedSamples.push(`${sampleInput.sampleId}: ${outcome.code}`);
      const blocked = createSampleRecord({
        sampleId: sampleInput.sampleId,
        caseId: sampleInput.caseId,
        caseVersion: sampleInput.caseVersion,
        branch: sampleInput.branch,
        label: "blocked",
        // The sample never produced a result, so the reason is a platform or
        // provider failure rather than a judgement about the code.
        blockedReason: "platform_failure",
        runIdentities: [`blocked-${sampleInput.sampleId}`],
        assertions: [],
      });
      if (blocked.ok) records.push(blocked.value);
    }
  }

  const aggregated = aggregateEvaluation({
    configuration: input.configuration,
    records,
    plannedPerCase: samplesPerCase,
  });
  if (!aggregated.ok) {
    return {
      ok: false,
      code: aggregated.code,
      ...(aggregated.detail === undefined ? {} : { detail: aggregated.detail }),
    };
  }

  const report = aggregated.value;
  return {
    records,
    report,
    blockedSamples,
    render: (renderInput) =>
      renderEvidencePackage({
        candidate: renderInput.candidate,
        report,
        records,
        gates: renderInput.gates,
        knownDefects: renderInput.knownDefects,
        notRunOrBlocked: [...renderInput.notRunOrBlocked, ...blockedSamples],
        supportScope: renderInput.supportScope,
        rollback: renderInput.rollback,
      }),
  };
}
