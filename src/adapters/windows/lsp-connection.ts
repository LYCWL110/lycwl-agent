import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { spawn } from "node:child_process";

import { LSP_LIMITS } from "../../domain/language/lsp.ts";
import { filterChildEnvironment } from "../../domain/process/shell.ts";

/**
 * Framed JSON-RPC over a supervised language-server child process.
 *
 * The G02 Job Object path is used for the shell and background tools, where a
 * command is captured to files and awaited. LSP needs a long-lived bidirectional
 * pipe instead, so this module uses Node's child process with piped stdio and
 * applies the same protections it can enforce directly: a filtered environment,
 * no shell interpretation, bounded frames, per-request timeouts, and complete
 * rejection of every server-initiated request.
 *
 * Lifetime is tied to the pipes rather than to a Job Object: when the Harness exits,
 * the child's stdin and stdout handles close, and a language server reading stdin sees
 * EOF. Measurement of the same mechanism for MCP is recorded in ADR-0073. A Job Object
 * would still cover a server that detaches and redirects its own stdio, which has not
 * been observed.
 */

export type LspConnectionFailure =
  | "spawn_failed"
  | "frame_too_large"
  | "invalid_frame"
  | "request_timeout"
  | "server_exited"
  | "request_rejected";

export type LspMessage = Readonly<{
  jsonrpc: "2.0";
  id?: number | string;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: Readonly<{ code: number; message: string }>;
}>;

export type LspConnectionOptions = Readonly<{
  executable: string;
  argv: readonly string[];
  cwd: string;
  inheritedEnvironment: Readonly<Record<string, string>>;
  providerCredentialNames?: readonly string[];
  environmentGrants?: readonly string[];
  requestTimeoutMs?: number;
  /** Called for every server-initiated request; must never apply an edit. */
  onServerRequest?: (message: LspMessage) => void;
}>;

export type LspConnection = Readonly<{
  /** Send a request and resolve with its matching response. */
  request: (method: string, params: unknown) => Promise<LspMessage>;
  /** Send a notification with no response. */
  notify: (method: string, params: unknown) => void;
  /** Bounded shutdown: request exit, then force termination. */
  close: () => Promise<void>;
  isAlive: () => boolean;
  processId: number | null;
}>;

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

export function createLspConnection(
  options: LspConnectionOptions,
): LspConnection | { error: LspConnectionFailure } {
  const requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;

  const filter = filterChildEnvironment(
    options.inheritedEnvironment,
    {},
    {
      platform: process.platform === "linux" ? "linux" : "win32",
      ...(options.providerCredentialNames === undefined
        ? {}
        : { providerCredentialNames: options.providerCredentialNames }),
      grantedNames: options.environmentGrants ?? [],
    },
  );

  let child: ChildProcessWithoutNullStreams;
  try {
    child = spawn(options.executable, [...options.argv], {
      cwd: options.cwd,
      env: filter.environment,
      // No shell interpretation: the model cannot inject interpreters.
      shell: false,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch {
    return { error: "spawn_failed" };
  }

  let closed = false;
  let nextId = 1;
  let buffer = Buffer.alloc(0);
  const pending = new Map<number | string, (message: LspMessage) => void>();

  child.on("error", () => {
    closed = true;
    for (const resolve of pending.values()) {
      resolve({ jsonrpc: "2.0", error: { code: -32000, message: "server_exited" } });
    }
    pending.clear();
  });

  child.on("exit", () => {
    closed = true;
    for (const resolve of pending.values()) {
      resolve({ jsonrpc: "2.0", error: { code: -32000, message: "server_exited" } });
    }
    pending.clear();
  });

  child.stdout.on("data", (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk]);
    drain();
  });
  // Stderr is drained so a chatty server cannot block on a full pipe.
  child.stderr.on("data", () => undefined);

  function drain(): void {
    for (;;) {
      const headerEnd = buffer.indexOf("\r\n\r\n");
      if (headerEnd === -1) {
        if (buffer.length > LSP_LIMITS.maxMessageBytes) buffer = Buffer.alloc(0);
        return;
      }
      const header = buffer.subarray(0, headerEnd).toString("ascii");
      const match = /Content-Length:\s*(\d+)/i.exec(header);
      if (match === null) {
        // A malformed header cannot be trusted; drop the connection buffer.
        buffer = buffer.subarray(headerEnd + 4);
        continue;
      }
      const length = Number(match[1]);
      if (length > LSP_LIMITS.maxMessageBytes) {
        buffer = Buffer.alloc(0);
        return;
      }
      const bodyStart = headerEnd + 4;
      if (buffer.length < bodyStart + length) return;
      const body = buffer.subarray(bodyStart, bodyStart + length).toString("utf8");
      buffer = buffer.subarray(bodyStart + length);

      let message: LspMessage;
      try {
        message = JSON.parse(body) as LspMessage;
      } catch {
        continue;
      }
      dispatch(message);
    }
  }

  function dispatch(message: LspMessage): void {
    if (message.id !== undefined && message.method !== undefined) {
      // Server-initiated request. It is reported but never applied, and every
      // such request is refused with an error response.
      options.onServerRequest?.(message);
      write({
        jsonrpc: "2.0",
        id: message.id,
        error: { code: -32601, message: "server-initiated requests are rejected" },
      });
      return;
    }
    if (message.id === undefined) {
      // Notification from the server; ignored for the read-only tools.
      return;
    }
    const resolve = pending.get(message.id);
    if (resolve !== undefined) {
      pending.delete(message.id);
      resolve(message);
    }
  }

  function write(message: LspMessage): void {
    if (closed) return;
    const body = Buffer.from(JSON.stringify(message), "utf8");
    const header = Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, "ascii");
    try {
      child.stdin.write(Buffer.concat([header, body]));
    } catch {
      closed = true;
    }
  }

  async function request(method: string, params: unknown): Promise<LspMessage> {
    if (closed) {
      return { jsonrpc: "2.0", error: { code: -32000, message: "server_exited" } };
    }
    const id = nextId;
    nextId += 1;

    return new Promise<LspMessage>((resolve) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        resolve({ jsonrpc: "2.0", id, error: { code: -32001, message: "request_timeout" } });
      }, requestTimeoutMs);
      timer.unref?.();

      pending.set(id, (message) => {
        clearTimeout(timer);
        resolve(message);
      });
      write({ jsonrpc: "2.0", id, method, params });
    });
  }

  function notify(method: string, params: unknown): void {
    write({ jsonrpc: "2.0", method, params });
  }

  async function close(): Promise<void> {
    if (closed) return;
    // Two-second grace, then a hard kill, per the confirmed bounded shutdown.
    try {
      child.stdin.end();
    } catch {
      // Already closed.
    }
    const exited = new Promise<void>((resolve) => {
      const timer = setTimeout(() => resolve(), 2_000);
      timer.unref?.();
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
    await exited;
    if (!closed) {
      try {
        child.kill();
      } catch {
        // Ignore; the exit handler already settled state.
      }
    }
    closed = true;
  }

  return {
    request,
    notify,
    close,
    isAlive: () => !closed,
    processId: child.pid ?? null,
  };
}
