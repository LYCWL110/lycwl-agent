import {
  beginLspLease,
  canServeRequests,
  confirmLspStopped,
  isLspLeaseTerminal,
  type LspInstance,
  type LspLease,
  markLspCleanupUnknown,
  markLspProtocolReady,
  requestLspStop,
} from "../../domain/language/lsp.ts";
import type { LspToolDependencies } from "../tools/lsp-tools.ts";
import { createLspConnection, type LspConnection } from "./lsp-connection.ts";

/**
 * Session-owned LSP instance registry implementing the confirmed SR04 lease.
 *
 * A spawned process is not a ready server: the lease stays `starting` until
 * `initialize` succeeds. A stop request is not a stop. An unconfirmable cleanup
 * becomes `outcome_unknown` with no invented exit time, and a terminal lease is
 * never reused.
 */
export type LspServerConfig = Readonly<{
  /** Stable, user-configured identifier; never a downloaded package. */
  serverId: string;
  executable: string;
  argv: readonly string[];
  cwd: string;
  configurationRevision: number;
  environmentFingerprint: string;
  providerCredentialNames?: readonly string[];
  environmentGrants?: readonly string[];
  requestTimeoutMs?: number;
}>;

export type LspRegistry = Readonly<{
  dependencies: LspToolDependencies;
  /** Launch and initialize a server; requires prior approval of this instance. */
  start: (
    config: LspServerConfig,
    approval: Readonly<{ approvedInstanceId: string }>,
  ) => Promise<Readonly<{ ok: true; lease: LspLease }> | Readonly<{ ok: false; code: string }>>;
  /** Current lease, if any. */
  lease: () => LspLease | null;
  /** Stop the Session-owned server with bounded shutdown. */
  close: () => Promise<void>;
}>;

export function createLspRegistry(
  options: Readonly<{ inheritedEnvironment: Readonly<Record<string, string>> }>,
): LspRegistry {
  let lease: LspLease | null = null;
  let instance: LspInstance | null = null;
  let connection: LspConnection | null = null;
  let counter = 0;

  function nextId(prefix: string): string {
    counter += 1;
    return `${prefix}-${counter}`;
  }

  async function start(
    config: LspServerConfig,
    approval: Readonly<{ approvedInstanceId: string }>,
  ): Promise<Readonly<{ ok: true; lease: LspLease }> | Readonly<{ ok: false; code: string }>> {
    if (lease !== null && isLspLeaseTerminal(lease)) {
      // A terminal lease is never reused; a new process needs a new identity.
      lease = null;
      instance = null;
      connection = null;
    }
    if (lease !== null) return { ok: false, code: "lease_already_active" };

    const instanceId = nextId("lsp-instance");
    const begun = beginLspLease(nextId("lsp-lease"), instanceId);
    if (!begun.ok) return { ok: false, code: begun.code };
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
  function requireReady(): LspLease | string {
    if (lease === null) return "not_found";
    const usable = canServeRequests(lease);
    if (!usable.ok) return usable.code;
    return usable.value;
  }

  const dependencies: LspToolDependencies = {
    getInstance: () => instance,
    getLiveIdentity: () => (connection === null ? null : `pid-${connection.processId ?? 0}`),

    async diagnostics(_instanceArg, filePath) {
      const ready = requireReady();
      if (typeof ready === "string") return { kind: "unknown", safeCode: ready };
      const current = connection;
      if (current === null) return { kind: "unknown", safeCode: "server_exited" };

      const response = await current.request("textDocument/diagnostic", {
        textDocument: { uri: `file:///${filePath.replace(/\\/g, "/")}` },
      });
      if (response.error !== undefined) {
        return { kind: "unknown", safeCode: response.error.message };
      }
      const items = (response.result as { items?: unknown } | undefined)?.items ?? [];
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

  async function locationRequest(
    current: LspConnection | null,
    method: string,
    filePath: string,
    position: Readonly<{ line: number; character: number }>,
  ) {
    const ready = requireReady();
    if (typeof ready === "string") return { kind: "unknown" as const, safeCode: ready };
    if (current === null) return { kind: "unknown" as const, safeCode: "server_exited" };

    const response = await current.request(method, {
      textDocument: { uri: `file:///${filePath.replace(/\\/g, "/")}` },
      position,
    });
    if (response.error !== undefined) {
      return { kind: "unknown" as const, safeCode: response.error.message };
    }
    return {
      kind: "result" as const,
      payload: response.result ?? [],
      messageBytes: Buffer.byteLength(JSON.stringify(response), "utf8"),
    };
  }

  async function close(): Promise<void> {
    if (lease === null) return;
    const stopping = requestLspStop(lease);
    if (!stopping.ok) return;
    lease = stopping.value;

    if (connection !== null) {
      await connection.close();
      const alive = connection.processId !== null && connection.isAlive();
      lease = alive
        ? (markLspCleanupUnknown(lease) as { ok: true; value: LspLease }).value
        : (confirmLspStopped(lease) as { ok: true; value: LspLease }).value;
      connection = null;
    } else {
      lease = (confirmLspStopped(lease) as { ok: true; value: LspLease }).value;
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
