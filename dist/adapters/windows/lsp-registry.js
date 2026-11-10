import { beginLspLease, canServeRequests, confirmLspStopped, isLspLeaseTerminal, markLspCleanupUnknown, markLspProtocolReady, requestLspStop, } from "../../domain/language/lsp.js";
import { createLspConnection } from "./lsp-connection.js";
export function createLspRegistry(options) {
    let lease = null;
    let instance = null;
    let connection = null;
    let counter = 0;
    function nextId(prefix) {
        counter += 1;
        return `${prefix}-${counter}`;
    }
    async function start(config, approval) {
        if (lease !== null && isLspLeaseTerminal(lease)) {
            // A terminal lease is never reused; a new process needs a new identity.
            lease = null;
            instance = null;
            connection = null;
        }
        if (lease !== null)
            return { ok: false, code: "lease_already_active" };
        const instanceId = nextId("lsp-instance");
        const begun = beginLspLease(nextId("lsp-lease"), instanceId);
        if (!begun.ok)
            return { ok: false, code: begun.code };
        lease = begun.value;
        const created = createLspConnection({
            executable: config.executable,
            argv: config.argv,
            cwd: config.cwd,
            inheritedEnvironment: options.inheritedEnvironment,
            ...(config.providerCredentialNames === undefined
                ? {}
                : { providerCredentialNames: config.providerCredentialNames }),
            ...(config.environmentGrants === undefined
                ? {}
                : { environmentGrants: config.environmentGrants }),
            ...(config.requestTimeoutMs === undefined
                ? {}
                : { requestTimeoutMs: config.requestTimeoutMs }),
        });
        if ("error" in created) {
            lease = null;
            return { ok: false, code: created.error };
        }
        connection = created;
        // Process start is not protocol readiness: only a successful initialize may
        // move the lease to `running`.
        const initialized = await created.request("initialize", {
            processId: process.pid,
            capabilities: {},
        });
        if (initialized.error !== undefined || initialized.result === undefined) {
            await created.close();
            connection = null;
            lease = null;
            return { ok: false, code: "protocol_initialize_failed" };
        }
        const running = markLspProtocolReady(lease, {
            processExecutionId: `pid-${created.processId ?? 0}`,
            configurationRevision: config.configurationRevision,
            environmentFingerprint: config.environmentFingerprint,
        });
        if (!running.ok) {
            await created.close();
            connection = null;
            lease = null;
            return { ok: false, code: running.code };
        }
        lease = running.value;
        instance = {
            instanceId,
            sessionId: "session",
            serverId: config.serverId,
            state: "ready",
            approvedInstanceId: approval.approvedInstanceId,
            executionIdentity: `pid-${created.processId ?? 0}`,
        };
        return { ok: true, lease: running.value };
    }
    /** Fail a request when the lease is not running and protocol-ready. */
    function requireReady() {
        if (lease === null)
            return "not_found";
        const usable = canServeRequests(lease);
        if (!usable.ok)
            return usable.code;
        return usable.value;
    }
    const dependencies = {
        getInstance: () => instance,
        getLiveIdentity: () => (connection === null ? null : `pid-${connection.processId ?? 0}`),
        async diagnostics(_instanceArg, filePath) {
            const ready = requireReady();
            if (typeof ready === "string")
                return { kind: "unknown", safeCode: ready };
            const current = connection;
            if (current === null)
                return { kind: "unknown", safeCode: "server_exited" };
            const response = await current.request("textDocument/diagnostic", {
                textDocument: { uri: `file:///${filePath.replace(/\\/g, "/")}` },
            });
            if (response.error !== undefined) {
                return { kind: "unknown", safeCode: response.error.message };
            }
            const items = response.result?.items ?? [];
            return {
                kind: "result",
                payload: items,
                messageBytes: Buffer.byteLength(JSON.stringify(response), "utf8"),
            };
        },
        async definition(_instanceArg, filePath, position) {
            return locationRequest(connection, "textDocument/definition", filePath, position);
        },
        async references(_instanceArg, filePath, position) {
            return locationRequest(connection, "textDocument/references", filePath, position);
        },
    };
    async function locationRequest(current, method, filePath, position) {
        const ready = requireReady();
        if (typeof ready === "string")
            return { kind: "unknown", safeCode: ready };
        if (current === null)
            return { kind: "unknown", safeCode: "server_exited" };
        const response = await current.request(method, {
            textDocument: { uri: `file:///${filePath.replace(/\\/g, "/")}` },
            position,
        });
        if (response.error !== undefined) {
            return { kind: "unknown", safeCode: response.error.message };
        }
        return {
            kind: "result",
            payload: response.result ?? [],
            messageBytes: Buffer.byteLength(JSON.stringify(response), "utf8"),
        };
    }
    async function close() {
        if (lease === null)
            return;
        const stopping = requestLspStop(lease);
        if (!stopping.ok)
            return;
        lease = stopping.value;
        if (connection !== null) {
            await connection.close();
            const alive = connection.processId !== null && connection.isAlive();
            lease = alive
                ? markLspCleanupUnknown(lease).value
                : confirmLspStopped(lease).value;
            connection = null;
        }
        else {
            lease = confirmLspStopped(lease).value;
        }
        instance = null;
    }
    return {
        dependencies,
        start,
        lease: () => lease,
        close,
    };
}
