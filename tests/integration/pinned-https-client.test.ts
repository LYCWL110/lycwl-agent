import assert from "node:assert/strict";
import { createServer, type Server } from "node:https";
import { describe, it } from "node:test";

import { pinnedFetch } from "../../src/adapters/windows/pinned-https-client.ts";
import { TEST_CERT_PEM, TEST_KEY_PEM } from "../fakes/web-cert.ts";

function startServer(
  handler: Parameters<typeof createServer>[1],
): Promise<Readonly<{ server: Server; port: number }>> {
  return new Promise((resolve) => {
    const server = createServer({ cert: TEST_CERT_PEM, key: TEST_KEY_PEM }, handler);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      resolve({ server, port });
    });
  });
}

function stop(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

describe("pinned HTTPS connector", () => {
  it("fetches a response from the approved address", async () => {
    const { server, port } = await startServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/html" });
      response.end("hello from stub");
    });

    const result = await pinnedFetch({
      url: `https://localhost:${port}/`,
      host: "localhost",
      scheme: "https",
      headers: { accept: "text/html" },
      approvedAddresses: ["127.0.0.1"],
      userAgent: "lycwl-agent/test",
      trustedCaPem: TEST_CERT_PEM,
    });

    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.status, 200);
    assert.match(result.bodyText, /hello from stub/);
    assert.equal(result.location, null);
    await stop(server);
  });

  it("returns a redirect target without following it", async () => {
    let secondHit = false;
    const { server, port } = await startServer((request, response) => {
      if (request.url === "/target") secondHit = true;
      response.writeHead(302, { location: "/target" });
      response.end();
    });

    const result = await pinnedFetch({
      url: `https://localhost:${port}/start`,
      host: "localhost",
      scheme: "https",
      headers: {},
      approvedAddresses: ["127.0.0.1"],
      userAgent: "lycwl-agent/test",
      trustedCaPem: TEST_CERT_PEM,
    });

    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.status, 302);
    assert.equal(result.location, "/target");
    assert.equal(secondHit, false, "a redirect must never be followed");
    await stop(server);
  });

  it("refuses a connection to an address that was not approved", async () => {
    const { server, port } = await startServer((_request, response) => {
      response.writeHead(200);
      response.end("should not reach");
    });

    const result = await pinnedFetch({
      url: `https://localhost:${port}/`,
      host: "localhost",
      scheme: "https",
      headers: {},
      // A deliberately wrong approved address: the pinned lookup cannot reach
      // the real listener.
      approvedAddresses: ["127.0.0.2"],
      userAgent: "lycwl-agent/test",
      trustedCaPem: TEST_CERT_PEM,
    });

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.code === "connect_failed" || result.code === "timeout", true);
    await stop(server);
  });

  it("rejects a certificate that does not match the hostname", async () => {
    const { server, port } = await startServer((_request, response) => {
      response.writeHead(200);
      response.end("tls should fail");
    });

    // The certificate is for `localhost`, but the request claims another host,
    // so hostname verification must fail even though the IP is approved.
    const result = await pinnedFetch({
      url: `https://wrong-host.example:${port}/`,
      host: "wrong-host.example",
      scheme: "https",
      headers: {},
      approvedAddresses: ["127.0.0.1"],
      userAgent: "lycwl-agent/test",
      trustedCaPem: TEST_CERT_PEM,
    });

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.code === "tls_failed" || result.code === "connect_failed", true);
    await stop(server);
  });

  it("fails explicitly when the response exceeds the raw cap", async () => {
    const oversized = Buffer.alloc(5 * 1024 * 1024 + 1024, 0x61);
    const { server, port } = await startServer((_request, response) => {
      response.writeHead(200);
      response.end(oversized);
    });

    const result = await pinnedFetch({
      url: `https://localhost:${port}/`,
      host: "localhost",
      scheme: "https",
      headers: {},
      approvedAddresses: ["127.0.0.1"],
      userAgent: "lycwl-agent/test",
      trustedCaPem: TEST_CERT_PEM,
    });

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.code, "response_too_large");
    await stop(server);
  });

  it("sends only the Harness-managed User-Agent plus approved headers", async () => {
    let seen: Record<string, unknown> = {};
    const { server, port } = await startServer((request, response) => {
      seen = { ...request.headers };
      response.writeHead(200);
      response.end("ok");
    });

    await pinnedFetch({
      url: `https://localhost:${port}/`,
      host: "localhost",
      scheme: "https",
      headers: { accept: "text/html" },
      approvedAddresses: ["127.0.0.1"],
      userAgent: "lycwl-agent/fixed",
      trustedCaPem: TEST_CERT_PEM,
    });

    assert.equal(seen["user-agent"], "lycwl-agent/fixed");
    assert.equal(seen["accept"], "text/html");
    assert.equal(seen["authorization"], undefined);
    assert.equal(seen["cookie"], undefined);
    await stop(server);
  });
});
