/**
 * Minimal stub language server for tests. It speaks Content-Length framed
 * JSON-RPC and mutates nothing on disk. Test-only fixture.
 */
let buffer: Buffer = Buffer.alloc(0);

process.stdin.on("data", (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  drain();
});

function drain(): void {
  for (;;) {
    const headerEnd = buffer.indexOf("\r\n\r\n");
    if (headerEnd === -1) return;
    const header = buffer.subarray(0, headerEnd).toString("ascii");
    const match = /Content-Length:\s*(\d+)/i.exec(header);
    if (match === null) {
      buffer = buffer.subarray(headerEnd + 4);
      continue;
    }
    const length = Number(match[1]);
    const bodyStart = headerEnd + 4;
    if (buffer.length < bodyStart + length) return;
    const body = buffer.subarray(bodyStart, bodyStart + length).toString("utf8");
    buffer = buffer.subarray(bodyStart + length);

    let message: {
      id?: number | string;
      method?: string;
      params?: unknown;
    };
    try {
      message = JSON.parse(body);
    } catch {
      continue;
    }
    handle(message);
  }
}

function send(message: unknown): void {
  const body = Buffer.from(JSON.stringify(message), "utf8");
  process.stdout.write(
    Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, "ascii"), body]),
  );
}

function handle(message: { id?: number | string; method?: string; params?: unknown }): void {
  if (message.method === undefined) return;

  // A request from the Harness always carries an id.
  if (message.id !== undefined) {
    switch (message.method) {
      case "initialize":
        send({
          jsonrpc: "2.0",
          id: message.id,
          result: { capabilities: { diagnosticProvider: true } },
        });
        return;
      case "textDocument/diagnostic":
        send({
          jsonrpc: "2.0",
          id: message.id,
          result: {
            kind: "full",
            items: [
              {
                path: "a.ts",
                line: 2,
                character: 4,
                severity: "error",
                message: "stub diagnostic",
                source: "stub",
              },
            ],
          },
        });
        return;
      case "textDocument/definition":
      case "textDocument/references":
        send({
          jsonrpc: "2.0",
          id: message.id,
          result: [{ path: "b.ts", line: 1, character: 0 }],
        });
        return;
      case "test/askServerToEdit":
        // A server-initiated edit request, used to prove rejection.
        send({
          jsonrpc: "2.0",
          id: "server-edit-1",
          method: "workspace/applyEdit",
          params: { edit: { changes: {} } },
        });
        send({ jsonrpc: "2.0", id: message.id, result: { sent: true } });
        return;
      case "test/hang":
        return;
      case "test/oversize":
        process.stdout.write("Content-Length: 999999999\r\n\r\n");
        return;
      default:
        send({ jsonrpc: "2.0", id: message.id, result: null });
        return;
    }
  }
}
