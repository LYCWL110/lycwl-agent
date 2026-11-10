/**
 * Session-owned LSP lifecycle (C08). An instance is approved once per Session
 * and retained across normal Run completion, but a crash/restart requires fresh
 * approval. Server-initiated edits and execute-command requests are rejected.
 */
export const LSP_LIMITS = Object.freeze({
    maxMessageBytes: 1024 * 1024,
    maxModelUnits: 12_000,
    maxLocations: 200,
    maxDiagnostics: 500,
});
export function canUseInstance(instance) {
    if (instance === null)
        return { ok: false, code: "not_found" };
    if (instance.approvedInstanceId !== instance.instanceId) {
        return { ok: false, code: "instance_not_approved" };
    }
    if (instance.state !== "ready")
        return { ok: false, code: "instance_not_ready" };
    return { ok: true, value: instance };
}
/**
 * After a crash or restart an instance must be re-approved even if the recorded
 * state still says ready, because the old process identity is gone.
 */
export function requiresReapproval(instance, liveIdentity) {
    return instance.executionIdentity === null || instance.executionIdentity !== liveIdentity;
}
/**
 * SR04 lease lifecycle (V1_CONTRACT_CLOSURE.md section 5). A spawned process is
 * not a ready server: only a successful protocol initialization may move a lease
 * to `running`, a stop request is not a stop, and an unconfirmable cleanup must
 * not fabricate an exit time.
 */
export const LSP_LEASE_STATES = [
    "starting",
    "running",
    "stopping",
    "stopped",
    "outcome_unknown",
];
const TERMINAL_LEASE_STATES = new Set(["stopped", "outcome_unknown"]);
export function beginLspLease(leaseId, instanceId) {
    if (leaseId.length === 0 || instanceId.length === 0) {
        return { ok: false, code: "invalid_lease_identity" };
    }
    return {
        ok: true,
        value: {
            leaseId,
            instanceId,
            state: "starting",
            processExecutionId: null,
            configurationRevision: null,
            environmentFingerprint: null,
            protocolReady: false,
        },
    };
}
/**
 * `starting -> running` requires the protocol to have initialized. Launching a
 * process is explicitly insufficient.
 */
export function markLspProtocolReady(lease, binding) {
    if (TERMINAL_LEASE_STATES.has(lease.state)) {
        return { ok: false, code: "terminal_lease_immutable" };
    }
    if (lease.state !== "starting")
        return { ok: false, code: "invalid_transition" };
    if (binding.processExecutionId.length === 0 ||
        binding.environmentFingerprint.length === 0 ||
        !Number.isSafeInteger(binding.configurationRevision) ||
        binding.configurationRevision < 0) {
        return { ok: false, code: "snapshot_mismatch" };
    }
    return {
        ok: true,
        value: {
            ...lease,
            state: "running",
            processExecutionId: binding.processExecutionId,
            configurationRevision: binding.configurationRevision,
            environmentFingerprint: binding.environmentFingerprint,
            protocolReady: true,
        },
    };
}
/** A request is only permitted on a running, protocol-ready lease. */
export function canServeRequests(lease) {
    if (lease.state !== "running" || !lease.protocolReady) {
        return { ok: false, code: "protocol_not_ready" };
    }
    return { ok: true, value: lease };
}
/** A stop request is a command, never proof of termination. */
export function requestLspStop(lease) {
    if (TERMINAL_LEASE_STATES.has(lease.state)) {
        return { ok: false, code: "terminal_lease_immutable" };
    }
    if (lease.state === "stopping")
        return { ok: true, value: lease };
    return { ok: true, value: { ...lease, state: "stopping" } };
}
/** Only proven process-tree termination or proof it never started lands here. */
export function confirmLspStopped(lease) {
    if (TERMINAL_LEASE_STATES.has(lease.state)) {
        return { ok: false, code: "terminal_lease_immutable" };
    }
    if (lease.state !== "stopping" && lease.state !== "starting") {
        return { ok: false, code: "invalid_transition" };
    }
    return { ok: true, value: { ...lease, state: "stopped", protocolReady: false } };
}
/** Cleanup could not be confirmed. No exit time is invented. */
export function markLspCleanupUnknown(lease) {
    if (TERMINAL_LEASE_STATES.has(lease.state)) {
        return { ok: false, code: "terminal_lease_immutable" };
    }
    return { ok: true, value: { ...lease, state: "outcome_unknown", protocolReady: false } };
}
/**
 * A terminal lease is never reused. A new process needs a new lease identity and
 * a new approval.
 */
export function isLspLeaseTerminal(lease) {
    return TERMINAL_LEASE_STATES.has(lease.state);
}
export function validatePosition(value) {
    if (typeof value !== "object" || value === null) {
        return { ok: false, code: "invalid_arguments" };
    }
    const record = value;
    const line = record["line"];
    const character = record["character"];
    if (typeof line !== "number" ||
        !Number.isSafeInteger(line) ||
        line < 0 ||
        typeof character !== "number" ||
        !Number.isSafeInteger(character) ||
        character < 0) {
        return { ok: false, code: "invalid_position" };
    }
    return { ok: true, value: { line, character } };
}
const SEVERITIES = new Set(["error", "warning", "information", "hint"]);
/**
 * Validate one server response message. A message above the hard cap fails the
 * request instead of returning truncated structured data as if complete.
 */
export function validateLspMessageSize(bytes) {
    if (!Number.isSafeInteger(bytes) || bytes < 0) {
        return { ok: false, code: "invalid_arguments" };
    }
    if (bytes > LSP_LIMITS.maxMessageBytes)
        return { ok: false, code: "message_too_large" };
    return { ok: true, value: bytes };
}
export function normalizeDiagnostics(raw) {
    if (!Array.isArray(raw))
        return { ok: false, code: "invalid_arguments" };
    const diagnostics = [];
    for (const entry of raw.slice(0, LSP_LIMITS.maxDiagnostics)) {
        if (typeof entry !== "object" || entry === null) {
            return { ok: false, code: "invalid_arguments" };
        }
        const record = entry;
        const path = record["path"];
        const message = record["message"];
        const severity = record["severity"];
        const line = record["line"];
        const character = record["character"];
        if (typeof path !== "string" || typeof message !== "string") {
            return { ok: false, code: "invalid_arguments" };
        }
        if (typeof severity !== "string" || !SEVERITIES.has(severity)) {
            return { ok: false, code: "invalid_arguments" };
        }
        if (typeof line !== "number" ||
            !Number.isSafeInteger(line) ||
            typeof character !== "number" ||
            !Number.isSafeInteger(character)) {
            return { ok: false, code: "invalid_arguments" };
        }
        const source = record["source"];
        diagnostics.push({
            path,
            line,
            character,
            severity: severity,
            message,
            source: typeof source === "string" ? source : null,
        });
    }
    return { ok: true, value: diagnostics };
}
export function normalizeLocations(raw) {
    if (!Array.isArray(raw))
        return { ok: false, code: "invalid_arguments" };
    const locations = [];
    for (const entry of raw.slice(0, LSP_LIMITS.maxLocations)) {
        if (typeof entry !== "object" || entry === null) {
            return { ok: false, code: "invalid_arguments" };
        }
        const record = entry;
        const path = record["path"];
        const line = record["line"];
        const character = record["character"];
        if (typeof path !== "string")
            return { ok: false, code: "invalid_arguments" };
        if (typeof line !== "number" ||
            !Number.isSafeInteger(line) ||
            typeof character !== "number" ||
            !Number.isSafeInteger(character)) {
            return { ok: false, code: "invalid_arguments" };
        }
        locations.push({ path, line, character });
    }
    return { ok: true, value: locations };
}
/**
 * The Harness never lets an LSP server drive file edits or command execution.
 */
export function rejectServerInitiatedRequest(request) {
    if (request.kind === "edit" || request.kind === "execute_command") {
        return { ok: false, code: "server_initiated_request_rejected" };
    }
    return { ok: false, code: "server_initiated_request_rejected" };
}
export function formatDiagnostics(diagnostics) {
    if (diagnostics.length === 0)
        return "lsp_diagnostics: no diagnostics";
    return [
        `lsp_diagnostics: ${diagnostics.length} diagnostic(s)`,
        ...diagnostics.map((entry) => `${entry.path}:${entry.line}:${entry.character} ${entry.severity} ${entry.message}${entry.source === null ? "" : ` [${entry.source}]`}`),
    ].join("\n");
}
export function formatLocations(kind, locations) {
    if (locations.length === 0)
        return `${kind}: no locations`;
    return [
        `${kind}: ${locations.length} location(s)`,
        ...locations.map((entry) => `${entry.path}:${entry.line}:${entry.character}`),
    ].join("\n");
}
export function boundLspText(text) {
    if (text.length <= LSP_LIMITS.maxModelUnits)
        return text;
    return `${text.slice(0, LSP_LIMITS.maxModelUnits)}\n[truncated: model budget]`;
}
