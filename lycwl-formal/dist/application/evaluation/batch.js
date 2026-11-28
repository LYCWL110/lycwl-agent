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
import { aggregateEvaluation, } from "../../domain/evaluation/aggregation.js";
import { renderEvidencePackage } from "../../domain/evaluation/evidence-package.js";
import { EVALUATION_THRESHOLDS } from "../../domain/evaluation/labels.js";
import { createSampleRecord } from "../../domain/evaluation/sample-record.js";
import { runSample } from "./sample-runner.js";
/**
 * Run every planned sample for one configuration.
 *
 * A sample that fails to provision or whose agent throws is recorded as `blocked`,
 * not dropped. That is the difference between "this sample did not finish" and
 * "this sample does not exist", and only the first is honest. When even a blocked
 * record cannot be built, the sample stays only in `blockedSamples`, which leaves
 * the batch short and is reported as insufficient samples.
 */
export async function runBatch(input, dependencies) {
    const samplesPerCase = input.samplesPerCase ?? EVALUATION_THRESHOLDS.samplesPerCase;
    const records = [];
    const blockedSamples = [];
    for (const spec of input.cases) {
        for (let index = 0; index < samplesPerCase; index += 1) {
            const sampleInput = {
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
            if (blocked.ok)
                records.push(blocked.value);
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
        render: (renderInput) => renderEvidencePackage({
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
