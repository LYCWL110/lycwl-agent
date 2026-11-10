import { filterChildEnvironment, formatShellPreview, renderShellPreview, validateShellRequest, } from "../../domain/process/shell.js";
/** Raw hard cap for Shell stdout + stderr combined (V1_BASELINE section 7). */
export const SHELL_RAW_CAP_BYTES = 8 * 1024 * 1024;
/** Model-facing text cap in UTF-16 code units. */
export const SHELL_MODEL_CAP_UNITS = 20_000;
export const SHELL_DEFINITION = {
    name: "shell",
    version: "1",
    sideEffectClass: "process_execution",
    requiresApproval: true,
    concurrencySafe: false,
};
export function createShellTool(dependencies) {
    return {
        getDefinition(toolName) {
            return toolName === SHELL_DEFINITION.name ? SHELL_DEFINITION : null;
        },
        async preview(request) {
            const validated = validateShellRequest(request.arguments, {
                sessionMode: dependencies.sessionMode,
            });
            if (!validated.ok)
                return `shell: ${validated.code}`;
            const filter = filterChildEnvironment(dependencies.inheritedEnvironment, {}, {
                ...(dependencies.providerCredentialNames === undefined
                    ? {}
                    : { providerCredentialNames: dependencies.providerCredentialNames }),
                grantedNames: validated.value.environmentGrants,
            });
            return formatShellPreview(renderShellPreview(validated.value, filter));
        },
        async execute(request) {
            const validated = validateShellRequest(request.arguments, {
                sessionMode: dependencies.sessionMode,
            });
            if (!validated.ok) {
                return { status: "failed", safeCode: validated.code, text: null };
            }
            const shellRequest = validated.value;
            const filter = filterChildEnvironment(dependencies.inheritedEnvironment, {}, {
                ...(dependencies.providerCredentialNames === undefined
                    ? {}
                    : { providerCredentialNames: dependencies.providerCredentialNames }),
                grantedNames: shellRequest.environmentGrants,
            });
            if (filter.missingGrantNames.length > 0) {
                return { status: "failed", safeCode: "environment_grant_missing", text: null };
            }
            let outcome;
            try {
                if (request.signal?.aborted)
                    return { status: "failed", safeCode: "tool_cancelled", text: null };
                outcome = await dependencies.runShell(shellRequest, filter.environment, request.signal, request.toolCallId);
            }
            catch {
                return { status: "outcome_unknown", safeCode: "shell_outcome_unknown" };
            }
            if (outcome.kind === "unknown") {
                return {
                    status: "outcome_unknown",
                    safeCode: outcome.safeCode,
                    ...(outcome.evidence === undefined ? {} : { evidence: outcome.evidence }),
                    ...(outcome.deliveryBlocked == null ? {} : { deliveryBlocked: outcome.deliveryBlocked }),
                };
            }
            const evidence = outcome.evidence === undefined ? {} : { evidence: outcome.evidence };
            if (outcome.deliveryBlocked != null) {
                const succeeded = outcome.kind === "completed" && outcome.exitCode === 0;
                return succeeded
                    ? {
                        status: "succeeded",
                        text: null,
                        deliveryBlocked: outcome.deliveryBlocked,
                        ...evidence,
                    }
                    : {
                        status: "failed",
                        safeCode: outcome.kind === "timed_out" ? "shell_timeout" : "nonzero_exit",
                        text: null,
                        deliveryBlocked: outcome.deliveryBlocked,
                        ...evidence,
                    };
            }
            const combined = outcome.rawBytes ??
                Buffer.byteLength(outcome.stdout, "utf8") + Buffer.byteLength(outcome.stderr, "utf8");
            if (combined > SHELL_RAW_CAP_BYTES || outcome.captureComplete === false) {
                // Evidence is incomplete; never claim the full output was captured.
                return {
                    status: "failed",
                    safeCode: combined > SHELL_RAW_CAP_BYTES ? "output_limit_exceeded" : "capture_incomplete",
                    text: `${truncateForModel(outcome.stdout, outcome.stderr)}\n[capture incomplete; command effects are not rolled back]`,
                    ...evidence,
                };
            }
            const text = truncateForModel(outcome.stdout, outcome.stderr);
            if (outcome.kind === "timed_out") {
                return { status: "failed", safeCode: "shell_timeout", text, ...evidence };
            }
            if (outcome.exitCode !== 0) {
                return { status: "failed", safeCode: "nonzero_exit", text, ...evidence };
            }
            return { status: "succeeded", text, ...evidence };
        },
    };
}
function truncateForModel(stdout, stderr) {
    const body = [
        "stdout:",
        stdout.length === 0 ? "(empty)" : stdout,
        "stderr:",
        stderr.length === 0 ? "(empty)" : stderr,
    ].join("\n");
    if (body.length <= SHELL_MODEL_CAP_UNITS)
        return body;
    return `${body.slice(0, SHELL_MODEL_CAP_UNITS)}\n[truncated: model budget]`;
}
