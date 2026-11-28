import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";
import { describe, it } from "node:test";

import type { TuiViewState } from "../../src/tui/view-model.ts";
import type { WebEvent, WebState } from "../../src/web/protocol.ts";
import { startWebServer, type WebServerHandle } from "../../src/web/server.ts";
import { WebSessionError } from "../../src/web/session-host.ts";
import {
  createFakeAssetSource,
  createFakeController,
  createFakeHost,
  createFakeRuntime,
  emptyView,
  type FakeAssetSourceHandle,
  type FakeCatalogEntry,
  type FakeControllerHandle,
  type FakeHostHandle,
} from "../fakes/web-session.ts";

/**
 * End-to-end tests for the loopback HTTP + SSE server.
 *
 * Every test starts a real server on port 0 and talks to it over real sockets:
 * the contract here is HTTP behaviour (status codes, headers, streaming), which
 * a mocked request object would not exercise. The Runtime behind it is a fake
 * host, so the expected state is exact rather than "whatever the agent does".
 */

const INDEX_HTML = "<!doctype html><html><body><h1>lycwl</h1></body></html>";
const APP_CSS = "body { color: #111; }";

const ASSET_FILES = {
  "/": { body: INDEX_HTML, contentType: "text/html; charset=utf-8" },
  "/index.html": { body: INDEX_HTML, contentType: "text/html; charset=utf-8" },
  "/app.css": { body: APP_CSS, contentType: "text/css; charset=utf-8" },
} as const;

const DEFAULT_SESSIONS: readonly FakeCatalogEntry[] = [
  {
    sessionId: "session-current",
    label: "current session",
    title: null,
    modifiedAtUtc: "2026-11-28T04:00:00.000Z",
    bytes: 1024,
  },
  {
    sessionId: "session-other",
    label: "another session",
    title: null,
    modifiedAtUtc: "2026-11-27T04:00:00.000Z",
    bytes: 512,
  },
];

type FixtureOptions = Readonly<{
  view?: Partial<TuiViewState>;
  sessions?: readonly FakeCatalogEntry[];
  switching?: boolean;
  onSwitch?: (
    sessionId: string | null,
  ) => ReturnType<typeof createFakeRuntime> | Promise<ReturnType<typeof createFakeRuntime>>;
}>;

type TestFixture = Readonly<{
  server: WebServerHandle;
  baseUrl: string;
  controller: FakeControllerHandle;
  fakeHost: FakeHostHandle;
  assets: FakeAssetSourceHandle;
  quitCalls: () => number;
}>;

async function startFixture(options: FixtureOptions = {}): Promise<TestFixture> {
  const controller = createFakeController({ view: emptyView(options.view) });
  const initial = createFakeRuntime({
    sessionId: "session-current",
    controller: controller.controller,
  });
  const fakeHost = createFakeHost({
    initial,
    sessions: options.sessions ?? DEFAULT_SESSIONS,
    switching: options.switching ?? false,
    ...(options.onSwitch === undefined ? {} : { onSwitch: options.onSwitch }),
  });
  const assets = createFakeAssetSource(ASSET_FILES);
  let quitCount = 0;
  const server = await startWebServer({
    host: fakeHost.host,
    assets: assets.source,
    listen: { hostname: "127.0.0.1", port: 0 },
    tickMs: 40,
    onQuit: () => {
      quitCount += 1;
    },
  });
  return { server, baseUrl: server.url, controller, fakeHost, assets, quitCalls: () => quitCount };
}

async function withFixture(
  run: (fixture: TestFixture) => Promise<void>,
  options: FixtureOptions = {},
): Promise<void> {
  const fixture = await startFixture(options);
  try {
    await run(fixture);
  } finally {
    await fixture.server.close();
    await fixture.fakeHost.host.close();
  }
}

type HttpResult = Readonly<{
  status: number;
  body: unknown;
  headers: Headers;
  text: string;
}>;

type RequestOptions = Readonly<{
  payload?: unknown;
  rawBody?: string;
  headers?: Readonly<Record<string, string>>;
}>;

async function request(
  baseUrl: string,
  method: string,
  pathname: string,
  options: RequestOptions = {},
): Promise<HttpResult> {
  const headers: Record<string, string> = { ...options.headers };
  const body =
    options.rawBody ??
    (options.payload === undefined ? undefined : JSON.stringify(options.payload));
  if (body !== undefined && headers["content-type"] === undefined) {
    headers["content-type"] = "application/json";
  }
  const response = await fetch(`${baseUrl}${pathname}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body }),
  });
  const text = await response.text();
  let parsed: unknown = text;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    // Non-JSON bodies (static files, plain 404s) stay as text.
  }
  return { status: response.status, body: parsed, headers: response.headers, text };
}

function asRecord(value: unknown, context: string): Record<string, unknown> {
  assert.equal(typeof value, "object", `${context}: expected an object body`);
  assert.notEqual(value, null, `${context}: expected an object body`);
  return value as Record<string, unknown>;
}

function expectOk(result: HttpResult, context: string): Record<string, unknown> {
  const body = asRecord(result.body, context);
  assert.equal(body["ok"], true, `${context}: expected ok:true`);
  return body;
}

function expectFailure(result: HttpResult, status: number, code: string, context: string): void {
  assert.equal(result.status, status, `${context}: unexpected status`);
  const body = asRecord(result.body, context);
  assert.equal(body["ok"], false, `${context}: expected ok:false`);
  assert.equal(body["code"], code, `${context}: unexpected error code`);
}

type RawResponse = Readonly<{ status: number; body: string }>;

/** A request with a caller-chosen `Host`, which `fetch` refuses to set. */
function requestRaw(
  port: number,
  options: Readonly<{ path: string; method?: string; host: string; body?: string }>,
): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string | number> = { Host: options.host };
    if (options.body !== undefined) {
      headers["Content-Type"] = "application/json";
      headers["Content-Length"] = Buffer.byteLength(options.body);
    }
    const outgoing = httpRequest(
      {
        hostname: "127.0.0.1",
        port,
        path: options.path,
        method: options.method ?? "GET",
        headers,
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => {
          resolve({
            status: response.statusCode ?? 0,
            body: Buffer.concat(chunks).toString("utf8"),
          });
        });
      },
    );
    outgoing.on("error", reject);
    if (options.body !== undefined) outgoing.write(options.body);
    outgoing.end();
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

type SseStream = Readonly<{
  response: Response;
  events: WebEvent[];
  rawText: () => string;
  waitFor: (
    predicate: (events: readonly WebEvent[]) => boolean,
    timeoutMs?: number,
  ) => Promise<void>;
  close: () => Promise<void>;
  finished: Promise<void>;
}>;

/** Read an SSE stream the way a browser does: parse `data:` frames as they arrive. */
async function openSse(url: string): Promise<SseStream> {
  const aborter = new AbortController();
  const response = await fetch(url, {
    headers: { accept: "text/event-stream" },
    signal: aborter.signal,
  });
  const body = response.body;
  if (body === null) throw new Error("SSE response has no body");
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const events: WebEvent[] = [];
  let raw = "";
  let buffer = "";

  const finished = (async () => {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return;
        const chunk = decoder.decode(value, { stream: true });
        raw += chunk;
        buffer += chunk;
        for (let cut = buffer.indexOf("\n\n"); cut >= 0; cut = buffer.indexOf("\n\n")) {
          const frame = buffer.slice(0, cut);
          buffer = buffer.slice(cut + 2);
          for (const line of frame.split("\n")) {
            if (!line.startsWith("data:")) continue;
            const payload = line.slice("data:".length).trim();
            if (payload.length > 0) events.push(JSON.parse(payload) as WebEvent);
          }
        }
      }
    } catch {
      // Aborting the fetch closes the stream with an error; that is our own close().
    }
  })();

  async function waitFor(
    predicate: (events: readonly WebEvent[]) => boolean,
    timeoutMs = 3000,
  ): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (predicate(events)) return;
      if (Date.now() >= deadline) {
        throw new Error(`timed out waiting for an SSE frame (received ${events.length})`);
      }
      await delay(5);
    }
  }

  async function close(): Promise<void> {
    aborter.abort();
    try {
      await reader.cancel();
    } catch {
      // The stream may already be finished.
    }
    await finished;
  }

  return { response, events, rawText: () => raw, waitFor, close, finished };
}

const PENDING_APPROVAL: Partial<TuiViewState> = {
  runStatus: "waiting",
  waitingKind: "approval",
  pendingApproval: {
    approvalId: "approval-1",
    toolCallId: "tool-1",
    toolName: "write_file",
    requestVersion: 3,
  },
  pendingApprovalPreview: ["--- a/src/main.ts", "+++ b/src/main.ts"],
};

const PENDING_QUESTION: Partial<TuiViewState> = {
  runStatus: "waiting",
  waitingKind: "question",
  pendingQuestion: {
    questionId: "question-1",
    toolCallId: "tool-2",
    question: "Which file should I change?",
    answerType: "text",
    options: [],
    multiple: false,
    allowFreeText: true,
    requestVersion: 2,
  },
};

describe("web server: state and static assets", () => {
  it("projects the current controller state at /api/state", async () => {
    await withFixture(async ({ baseUrl }) => {
      const result = await request(baseUrl, "GET", "/api/state");
      assert.equal(result.status, 200);
      const state = expectOk(result, "state")["state"] as WebState;
      assert.equal(state.sessionId, "session-current");
      assert.equal(state.runStatus, "idle");
      assert.equal(state.modelLabel, "deepseek-v4.1-flash");
      assert.deepEqual(
        state.sessionList.map((entry) => [entry.sessionId, entry.current]),
        [
          ["session-current", true],
          ["session-other", false],
        ],
      );
    });
  });

  it("serves the client at /", async () => {
    await withFixture(async ({ baseUrl }) => {
      const result = await request(baseUrl, "GET", "/");
      assert.equal(result.status, 200);
      assert.match(result.headers.get("content-type") ?? "", /^text\/html/u);
      assert.match(result.text, /<h1>lycwl<\/h1>/u);
    });
  });

  it("serves static assets with their content type", async () => {
    await withFixture(async ({ baseUrl }) => {
      const result = await request(baseUrl, "GET", "/app.css");
      assert.equal(result.status, 200);
      assert.match(result.headers.get("content-type") ?? "", /^text\/css/u);
      assert.equal(result.text, APP_CSS);
    });
  });

  it("falls back to the SPA index only for extensionless paths", async () => {
    await withFixture(async ({ baseUrl, assets }) => {
      for (const pathname of ["/settings", "/some/deep/route"]) {
        const result = await request(baseUrl, "GET", pathname);
        assert.equal(result.status, 200, pathname);
        assert.match(result.text, /<h1>lycwl<\/h1>/u, pathname);
      }
      assert.deepEqual(
        assets.reads.filter((pathname) => pathname === "/"),
        ["/", "/"],
      );
      // A missing file with an extension is a real 404, not a client route.
      const missing = await request(baseUrl, "GET", "/missing.png");
      assert.equal(missing.status, 404);
    });
  });
});

describe("web server: Server-Sent Events", () => {
  it("streams the initial state and pushes the next change", async () => {
    await withFixture(async ({ baseUrl, controller }) => {
      const sse = await openSse(`${baseUrl}/api/events`);
      try {
        assert.match(sse.response.headers.get("content-type") ?? "", /^text\/event-stream/u);
        await sse.waitFor((events) => events.length >= 1);
        const first = sse.events[0];
        assert.equal(first?.type, "state");
        if (first?.type === "state") {
          assert.equal(first.state.sessionId, "session-current");
          assert.equal(first.state.runStatus, "idle");
        }

        controller.patchView({ runStatus: "active" });
        await sse.waitFor((events) =>
          events.some((event) => event.type === "state" && event.state.runStatus === "active"),
        );
        // The stream also tells EventSource how fast to reconnect.
        assert.match(sse.rawText(), /retry: 1000/u);
      } finally {
        await sse.close();
      }
    });
  });

  it("does not push a frame when the view has not changed", async () => {
    await withFixture(async ({ baseUrl }) => {
      const sse = await openSse(`${baseUrl}/api/events`);
      try {
        await sse.waitFor((events) => events.length >= 1);
        await delay(150);
        assert.equal(sse.events.length, 1);
      } finally {
        await sse.close();
      }
    });
  });
});

describe("web server: messages", () => {
  it("accepts a message with images and forwards both", async () => {
    await withFixture(async ({ baseUrl, controller }) => {
      const images = [{ mediaType: "image/png", base64: "iVBORw0KGgo=" }];
      const result = await request(baseUrl, "POST", "/api/message", {
        payload: { text: "look at this", images },
      });
      assert.equal(result.status, 202);
      expectOk(result, "message");
      assert.deepEqual(controller.calls.submit, [{ text: "look at this", images }]);
    });
  });

  it("rejects a message with an invalid JSON body", async () => {
    await withFixture(async ({ baseUrl, controller }) => {
      const result = await request(baseUrl, "POST", "/api/message", {
        rawBody: "{not json",
        headers: { "content-type": "application/json" },
      });
      expectFailure(result, 400, "bad_request", "invalid json");
      assert.equal(controller.calls.submit.length, 0);
    });
  });

  it("rejects a message without text", async () => {
    await withFixture(async ({ baseUrl, controller }) => {
      const result = await request(baseUrl, "POST", "/api/message", { payload: {} });
      expectFailure(result, 400, "bad_request", "missing text");
      assert.equal(controller.calls.submit.length, 0);
    });
  });
});

describe("web server: approvals and questions", () => {
  it("allows a pending approval through the controller", async () => {
    await withFixture(
      async ({ baseUrl, controller }) => {
        const result = await request(baseUrl, "POST", "/api/approval", {
          payload: { decision: "allow" },
        });
        assert.equal(result.status, 200);
        expectOk(result, "approval allow");
        assert.equal(controller.calls.approve, 1);
        assert.equal(controller.calls.deny, 0);
      },
      { view: PENDING_APPROVAL },
    );
  });

  it("denies a pending approval through the controller", async () => {
    await withFixture(
      async ({ baseUrl, controller }) => {
        const result = await request(baseUrl, "POST", "/api/approval", {
          payload: { decision: "deny" },
        });
        assert.equal(result.status, 200);
        expectOk(result, "approval deny");
        assert.equal(controller.calls.deny, 1);
        assert.equal(controller.calls.approve, 0);
      },
      { view: PENDING_APPROVAL },
    );
  });

  it("rejects an approval when nothing is pending", async () => {
    await withFixture(async ({ baseUrl, controller }) => {
      const result = await request(baseUrl, "POST", "/api/approval", {
        payload: { decision: "allow" },
      });
      expectFailure(result, 409, "conflict", "approval idle");
      assert.equal(controller.calls.approve, 0);
    });
  });

  it("answers a pending question through the controller", async () => {
    await withFixture(
      async ({ baseUrl, controller }) => {
        const result = await request(baseUrl, "POST", "/api/question", {
          payload: { text: "src/main.ts" },
        });
        assert.equal(result.status, 200);
        expectOk(result, "question answer");
        assert.deepEqual(controller.calls.answer, ["src/main.ts"]);
      },
      { view: PENDING_QUESTION },
    );
  });

  it("declines a pending question through the controller", async () => {
    await withFixture(
      async ({ baseUrl, controller }) => {
        const result = await request(baseUrl, "POST", "/api/question/decline");
        assert.equal(result.status, 200);
        expectOk(result, "question decline");
        assert.equal(controller.calls.declineQuestion, 1);
      },
      { view: PENDING_QUESTION },
    );
  });

  it("rejects an answer and a decline when no question is pending", async () => {
    await withFixture(async ({ baseUrl, controller }) => {
      const answered = await request(baseUrl, "POST", "/api/question", {
        payload: { text: "src/main.ts" },
      });
      expectFailure(answered, 409, "conflict", "question idle");
      const declined = await request(baseUrl, "POST", "/api/question/decline");
      expectFailure(declined, 409, "conflict", "decline idle");
      assert.deepEqual(controller.calls.answer, []);
      assert.equal(controller.calls.declineQuestion, 0);
    });
  });
});

describe("web server: cancelling runs", () => {
  for (const runStatus of ["active", "waiting"] as const) {
    it(`cancels a ${runStatus} run`, async () => {
      await withFixture(
        async ({ baseUrl, controller }) => {
          const result = await request(baseUrl, "POST", "/api/cancel");
          assert.equal(result.status, 200);
          expectOk(result, "cancel");
          assert.equal(controller.calls.cancelRun, 1);
        },
        { view: { runStatus } },
      );
    });
  }

  it("rejects a cancel when no run is active", async () => {
    await withFixture(async ({ baseUrl, controller }) => {
      const result = await request(baseUrl, "POST", "/api/cancel");
      expectFailure(result, 409, "conflict", "cancel idle");
      assert.equal(controller.calls.cancelRun, 0);
    });
  });
});

describe("web server: sessions", () => {
  it("switches to a new Session and reports its id", async () => {
    await withFixture(async ({ baseUrl, fakeHost }) => {
      const result = await request(baseUrl, "POST", "/api/session", {
        payload: { sessionId: null },
      });
      assert.equal(result.status, 200);
      expectOk(result, "session switch");
      assert.deepEqual(fakeHost.calls.switchSession, [null]);
      const stateResult = await request(baseUrl, "GET", "/api/state");
      const state = expectOk(stateResult, "state after switch")["state"] as WebState;
      assert.equal(state.sessionId, "session-fake-1");
    });
  });

  it("reports a switch to an unknown Session as 404", async () => {
    await withFixture(async ({ baseUrl, fakeHost }) => {
      fakeHost.failNextSwitch(new WebSessionError("not_found", "no such session"));
      const result = await request(baseUrl, "POST", "/api/session", {
        payload: { sessionId: "session-missing" },
      });
      expectFailure(result, 404, "not_found", "unknown session");
    });
  });

  it("reports a Session that cannot be opened as 502", async () => {
    await withFixture(async ({ baseUrl, fakeHost }) => {
      fakeHost.failNextSwitch(new WebSessionError("session_open_failed", "provider failed"));
      const result = await request(baseUrl, "POST", "/api/session", {
        payload: { sessionId: "session-broken" },
      });
      expectFailure(result, 502, "session_open_failed", "failed open");
    });
  });

  it("refuses to mutate while a switch is in progress", async () => {
    await withFixture(
      async ({ baseUrl, controller }) => {
        const result = await request(baseUrl, "POST", "/api/message", {
          payload: { text: "too early" },
        });
        expectFailure(result, 409, "conflict", "switching");
        assert.equal(controller.calls.submit.length, 0);
      },
      { switching: true },
    );
  });

  it("renames a Session through the host", async () => {
    await withFixture(async ({ baseUrl, fakeHost }) => {
      const result = await request(baseUrl, "POST", "/api/session/rename", {
        payload: { sessionId: "session-other", title: "Renamed" },
      });
      assert.equal(result.status, 200);
      expectOk(result, "rename");
      assert.deepEqual(fakeHost.calls.renameSession, [
        { sessionId: "session-other", title: "Renamed" },
      ]);
    });
  });

  it("deletes another Session but not the current one", async () => {
    await withFixture(async ({ baseUrl, fakeHost }) => {
      const removedOther = await request(baseUrl, "POST", "/api/session/delete", {
        payload: { sessionId: "session-other" },
      });
      assert.equal(removedOther.status, 200);
      expectOk(removedOther, "delete other");

      const removedCurrent = await request(baseUrl, "POST", "/api/session/delete", {
        payload: { sessionId: "session-current" },
      });
      expectFailure(removedCurrent, 409, "conflict", "delete current");
      assert.deepEqual(fakeHost.calls.deleteSession, ["session-other", "session-current"]);
    });
  });
});

describe("web server: security boundaries", () => {
  it("rejects a cross-site POST", async () => {
    await withFixture(async ({ baseUrl, controller }) => {
      const result = await request(baseUrl, "POST", "/api/message", {
        payload: { text: "csrf" },
        headers: { origin: "http://evil.example" },
      });
      expectFailure(result, 403, "forbidden", "cross-site");
      assert.equal(controller.calls.submit.length, 0);
    });
  });

  it("accepts a same-origin POST", async () => {
    await withFixture(async ({ baseUrl }) => {
      const result = await request(baseUrl, "POST", "/api/message", {
        payload: { text: "same origin" },
        headers: { origin: baseUrl },
      });
      assert.equal(result.status, 202);
      expectOk(result, "same-origin");
    });
  });

  it("rejects a request whose Host is not this server", async () => {
    await withFixture(async ({ server }) => {
      const result = await requestRaw(server.port, { path: "/api/state", host: "evil.example" });
      assert.equal(result.status, 403);
      const body = JSON.parse(result.body) as { ok: boolean; code: string };
      assert.equal(body.ok, false);
      assert.equal(body.code, "forbidden");
    });
  });

  it("rejects an unknown API endpoint with 404", async () => {
    await withFixture(async ({ baseUrl }) => {
      const result = await request(baseUrl, "GET", "/api/nope");
      expectFailure(result, 404, "not_found", "unknown endpoint");
    });
  });

  it("answers a wrong method with 405 and an Allow header", async () => {
    await withFixture(async ({ baseUrl }) => {
      const onMessage = await request(baseUrl, "GET", "/api/message");
      expectFailure(onMessage, 405, "unsupported", "GET message");
      assert.match(onMessage.headers.get("allow") ?? "", /POST/u);

      const onState = await request(baseUrl, "POST", "/api/state", { payload: {} });
      expectFailure(onState, 405, "unsupported", "POST state");
      assert.match(onState.headers.get("allow") ?? "", /GET/u);
    });
  });

  it("runs the quit handler", async () => {
    await withFixture(async ({ baseUrl, quitCalls }) => {
      const result = await request(baseUrl, "POST", "/api/quit");
      assert.equal(result.status, 200);
      expectOk(result, "quit");
      await delay(10);
      assert.equal(quitCalls(), 1);
    });
  });
});

describe("web server: shutdown", () => {
  it("closes the port, ends SSE streams, and tolerates a second close", async () => {
    const fixture = await startFixture();
    const sse = await openSse(`${fixture.baseUrl}/api/events`);
    try {
      await sse.waitFor((events) => events.length >= 1);
      await fixture.server.close();
      await sse.finished;
      await assert.rejects(fetch(`${fixture.baseUrl}/api/state`));
      await fixture.server.close();
    } finally {
      await sse.close();
      await fixture.fakeHost.host.close();
    }
  });
});
