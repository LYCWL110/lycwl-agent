/**
 * Evaluation sample orchestration (V1_EVALUATION_AND_RELEASE.md section 4).
 *
 * One call to `runSample` performs one independent sample: provision a fresh
 * isolated workspace from the frozen fixture, run the agent, run the independent
 * verifier, scan the authoritative events, and build a validated sample record.
 *
 * The order is contractual and each step exists for a reason:
 *
 * 1. **Provision before running.** Section 4 requires every sample to start from
 *    the frozen initial state. A sample that reused a previous workspace would
 *    measure the previous sample's leftovers.
 * 2. **Record the initial hashes before the agent runs.** The immutable-file check
 *    compares against the state the sample actually started from, not a manifest
 *    value that may have drifted.
 * 3. **Verify after the agent stops.** The verifier runs against the final
 *    workspace, so it sees what the agent produced.
 * 4. **Dispose in every path.** A workspace left behind is a leak, and a sample
 *    that crashes must not poison the next one.
 *
 * This module does not launch a provider, install anything or use the network. It
 * is orchestration over injected ports, which is why it can be tested with a
 * stand-in before any paid sample exists.
 */
import { createSampleRecord, deriveLabel, } from "../../domain/evaluation/sample-record.js";
import { findUnauthorizedDispatches, scanEvaluationEvents } from "./event-scan.js";
/**
 * Run one independent sample.
 *
 * A provision or agent failure is reported as a failed call rather than turned
 * into a `blocked` record here: whether a sample counts as blocked depends on the
 * reason, and the caller has that context. A verifier that cannot run, by
 * contrast, is recorded as `invalid_fixture`, because a defective fixture is an
 * evaluation fact that must stay in the batch.
 */
export async function runSample(input, dependencies) {
    let workspace;
    try {
        workspace = await dependencies.workspaces.provision({ caseId: input.caseId });
    }
    catch (error) {
        return { ok: false, code: "provision_failed", detail: describe(error) };
    }
    try {
        // Snapshot the immutable files before the agent runs, so the comparison is
        // against what this sample actually started from.
        const before = new Map();
        for (const relative of input.immutableFiles) {
            before.set(relative, await workspace.hashFile(relative));
        }
        let agentOutcome;
        try {
            agentOutcome = await dependencies.agent.run({
                caseId: input.caseId,
                workspaceRoot: workspace.root,
                task: input.task,
            });
        }
        catch (error) {
            return { ok: false, code: "agent_failed", detail: describe(error) };
        }
        // The verifier runs even when the agent failed: a failed Run can still leave a
        // correct workspace, and section 2 keeps the execution lifecycle separate from
        // the task result.
        let verifierOutcome;
        try {
            verifierOutcome = await dependencies.verifier.verify({
                caseId: input.caseId,
                workspaceRoot: workspace.root,
            });
        }
        catch (error) {
            return { ok: false, code: "agent_failed", detail: describe(error) };
        }
        const changedImmutable = await findChangedImmutable(before, workspace);
        const scan = scanEvaluationEvents(agentOutcome.events, {
            mutatingTools: input.mutatingTools,
        });
        const unauthorized = findUnauthorizedDispatches(agentOutcome.events, input.toolsRequiringApproval);
        if (verifierOutcome.invalidReason !== undefined) {
            const record = createSampleRecord({
                sampleId: input.sampleId,
                caseId: input.caseId,
                caseVersion: input.caseVersion,
                branch: input.branch,
                label: "invalid_fixture",
                invalidReason: verifierOutcome.invalidReason,
                runIdentities: agentOutcome.runIdentities,
                assertions: verifierOutcome.assertions,
            });
            return fromRecord(record);
        }
        const violations = [...scan.violations, ...unauthorized];
        const reportClaims = [...scan.reportClaims];
        // An immutable-file change is a process violation: the sample produced a diff
        // outside what the case allows, even if the functional assertions pass.
        if (changedImmutable.length > 0) {
            for (const relative of changedImmutable) {
                violations.push({ kind: "unauthorized_dispatch", detail: `immutable:${relative}` });
            }
        }
        // The label comes from the verifier's assertions, not from the Run status.
        // Section 2 keeps the execution lifecycle separate: a `failed` Run can leave a
        // correct workspace, and a `completed` Run can leave the goal unmet. The Run
        // state is recorded alongside so a reader can see both facts.
        const label = deriveLabel({
            label: "pass",
            assertions: verifierOutcome.assertions,
            reportClaims: scan.reportClaims,
        });
        const record = createSampleRecord({
            sampleId: input.sampleId,
            caseId: input.caseId,
            caseVersion: input.caseVersion,
            branch: input.branch,
            label,
            runIdentities: agentOutcome.runIdentities,
            runTerminalStates: [agentOutcome.status],
            assertions: verifierOutcome.assertions,
            violations,
            reportClaims,
            usage: {
                inputTokens: scan.usage.inputTokens,
                outputTokens: scan.usage.outputTokens,
                modelRounds: scan.usage.modelRounds,
                compactions: scan.usage.compactions,
                activeMs: null,
                waitingMs: null,
                knownUsd: scan.usage.knownUsd,
                unknownChargeCount: scan.usage.unknownChargeCount,
            },
        });
        return fromRecord(record);
    }
    finally {
        // Disposal must not mask a result: a cleanup failure is reported separately by
        // the provider, and a thrown error here would lose the record above.
        await workspace.dispose().catch(() => undefined);
    }
}
function fromRecord(result) {
    return result.ok
        ? { ok: true, record: result.value }
        : { ok: false, code: "record_invalid", detail: result.code };
}
async function findChangedImmutable(before, workspace) {
    const changed = [];
    for (const [relative, original] of before) {
        const current = await workspace.hashFile(relative);
        if (current !== original)
            changed.push(relative);
    }
    return changed;
}
function describe(error) {
    return error instanceof Error ? error.message : String(error);
}
