/**
 * Loopback HTTP + SSE server for the browser client.
 *
 * It presents the same Runtime the terminal drives: every command goes through the
 * `TuiController`, and every snapshot is a projection of its state. The browser has
 * no authority of its own, so nothing here executes a tool, decides a permission,
 * or invents transcript text.
 *
 * Security is part of the contract, not an assumption: the socket binds loopback
 * only, the `Host` header must name this server's own port (DNS rebinding),
 * state-changing requests must not carry a foreign `Origin` (cross-site POST), and
 * the JSON body is bounded because images travel base64 inline.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

import type { WebAssetSource } from "./assets.ts";
import {
  WEB_IMAGE_MEDIA_TYPES,
  type WebConfigRequest,
  type WebErrorCode,
  type WebEvent,
  type WebImage,
  type WebState,
} from "./protocol.ts";
import { WebSessionError, type WebSessionHost } from "./session-host.ts";
import { toWebState } from "./state.ts";

/** Images travel base64 inline, so the whole body has to fit in one bounded read. */
const MAX_JSON_BODY_BYTES = 24 * 1024 * 1024;

/** Snapshot sampling cadence: ~8 Hz keeps streaming text legible without flooding. */
const DEFAULT_TICK_MS = 125;
const PING_INTERVAL_MS = 15 * 1000;

/** Loopback names the browser may address, with the server's actual port. */
const LOOPBACK_HOST_NAMES = ["127.0.0.1", "localhost", "[::1]"] as const;

/** Bind names accepted from the launcher; anything else would expose the agent. */
const LOOPBACK_BIND_NAMES: ReadonlySet<string> = new Set([
  "127.0.0.1",
  "localhost",
  "::1",
  "0:0:0:0:0:0:0:1",
]);

export type WebServerOptions = Readonly<{
  host: WebSessionHost;
  assets: WebAssetSource;
  listen?: Readonly<{ hostname?: string; port?: number }>;
  tickMs?: number;
  /** Called after the shutdown response is written; the process may then exit. */
  onQuit?: () => void | Promise<void>;
  configure?: (request: WebConfigRequest) => Promise<void>;
  log?: (message: string) => void;
}>;

export type WebServerHandle = Readonly<{
  port: number;
  url: string;
  close(): Promise<void>;
}>;

export async function startWebServer(options: WebServerOptions): Promise<WebServerHandle> {
  const log = options.log ?? (() => undefined);
  const tickMs = normalizeTickMs(options.tickMs);
  const bindHostname = options.listen?.hostname ?? "127.0.0.1";
  const bindPort = options.listen?.port ?? 0;
  if (!LOOPBACK_BIND_NAMES.has(bindHostname.toLowerCase())) {
    throw new Error(`the web server may only bind to a loopback address, not ${bindHostname}`);
  }

  const clients = new Set<Readonly<{ stop(): void }>>();
  let closing: Promise<void> | null = null;

  const server = createServer((request, response) => {
    void handleRequest(request, response).catch((error: unknown) => {
      log(`web request failed: ${describeError(error)}`);
      if (!response.headersSent) {
        sendFailure(response, 500, "internal", "internal server error");
      } else if (!response.writableEnded) {
        response.end();
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => reject(error);
    server.once("error", onError);
    server.listen(bindPort, bindHostname, () => {
      server.off("error", onError);
      resolve();
    });
  });

  const address = server.address();
  if (address === null || typeof address === "string") {
    await closeServer();
    throw new Error("the web server did not report a listening address");
  }
  const port = address.port;
  const url = `http://${formatUrlHost(address.address)}:${port}`;
  const allowedHosts: ReadonlySet<string> = new Set([
    ...LOOPBACK_HOST_NAMES.map((name) => `${name}:${port}`),
    `${formatUrlHost(address.address).toLowerCase()}:${port}`,
  ]);
  // After a successful listen the socket stays up for the process lifetime; an
  // unhandled 'error' here would otherwise terminate the agent.
  server.on("error", (error: Error) => {
    log(`web server error: ${error.message}`);
  });

  const getRoutes: ReadonlyMap<string, ApiHandler> = new Map([
    ["/api/state", handleState],
    ["/api/events", handleEvents],
  ]);
  const postRoutes: ReadonlyMap<string, ApiHandler> = new Map([
    ["/api/message", handleMessage],
    ["/api/approval", handleApproval],
    ["/api/question", handleQuestion],
    ["/api/question/decline", handleDeclineQuestion],
    ["/api/cancel", handleCancel],
    ["/api/session", handleSession],
    ["/api/session/rename", handleRename],
    ["/api/session/delete", handleDelete],
    ["/api/quit", handleQuit],
    ["/api/config", handleConfig],
  ]);
  /** While a switch runs, the live controller is being replaced: no commands. */
  const mutatingPaths: ReadonlySet<string> = new Set([
    "/api/message",
    "/api/approval",
    "/api/question",
    "/api/question/decline",
    "/api/cancel",
    "/api/session/rename",
    "/api/session/delete",
  ]);

  async function closeServer(): Promise<void> {
    await new Promise<void>((resolve) => {
      if (!server.listening) {
        resolve();
        return;
      }
      server.close(() => resolve());
      server.closeAllConnections();
    });
  }

  function isAllowedHost(hostHeader: string | undefined): boolean {
    return hostHeader !== undefined && allowedHosts.has(hostHeader.toLowerCase());
  }

  /**
   * A same-origin or header-less request may change state.
   *
   * `Origin` is only sent by browsers on these methods, so a foreign value is a
   * cross-site request; header-less clients are the documented local tools.
   */
  function isAllowedOrigin(request: IncomingMessage): boolean {
    const method = request.method;
    if (method !== "POST" && method !== "DELETE") return true;
    const origin = request.headers.origin;
    if (origin === undefined) return true;
    const host = request.headers.host;
    return host !== undefined && origin.toLowerCase() === `http://${host.toLowerCase()}`;
  }

  async function currentState(): Promise<WebState> {
    const session = options.host.current();
    const view = session.controller.view();
    const switching = options.host.isSwitching();
    const sessionList = await options.host.listSessions();
    return toWebState({ session, view, sessionList, switching });
  }

  async function handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (!isAllowedHost(request.headers.host)) {
      reject(response, request, 403, "forbidden", "host is not allowed");
      return;
    }
    const parsed = parseUrl(request.url);
    if (parsed === null) {
      reject(response, request, 400, "bad_request", "request url is not valid");
      return;
    }
    if (!isAllowedOrigin(request)) {
      reject(response, request, 403, "forbidden", "origin is not allowed");
      return;
    }
    const { pathname } = parsed;
    if (pathname === "/api" || pathname.startsWith("/api/")) {
      await handleApi(request, response, pathname);
      return;
    }
    await handleStatic(request, response, pathname);
  }

  function handleApi(
    request: IncomingMessage,
    response: ServerResponse,
    pathname: string,
  ): Promise<void> {
    const method = request.method ?? "GET";
    const getHandler = getRoutes.get(pathname);
    const postHandler = postRoutes.get(pathname);
    if (getHandler === undefined && postHandler === undefined) {
      request.resume();
      sendFailure(response, 404, "not_found", "unknown endpoint");
      return Promise.resolve();
    }
    if (method === "GET" && getHandler !== undefined) {
      return Promise.resolve(getHandler(request, response));
    }
    if (method === "POST" && postHandler !== undefined) {
      if (mutatingPaths.has(pathname) && options.host.isSwitching()) {
        request.resume();
        sendFailure(response, 409, "conflict", "a session switch is in progress");
        return Promise.resolve();
      }
      return Promise.resolve(postHandler(request, response));
    }
    request.resume();
    const allowed: string[] = [];
    if (getHandler !== undefined) allowed.push("GET");
    if (postHandler !== undefined) allowed.push("POST");
    sendMethodNotAllowed(response, allowed);
    return Promise.resolve();
  }

  async function handleState(_request: IncomingMessage, response: ServerResponse): Promise<void> {
    const state = await currentState();
    sendJson(response, 200, { ok: true, state });
  }

  async function handleConfig(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (options.configure === undefined) {
      sendFailure(response, 501, "unsupported", "configuration is unavailable");
      return;
    }
    const body = await readJsonBody(request);
    if (!body.ok) {
      sendFailure(response, body.status, body.code, body.message);
      return;
    }
    if (!isConfigRequest(body.value)) {
      sendFailure(response, 400, "bad_request", "invalid configuration");
      return;
    }
    try {
      await options.configure(body.value);
      if (options.host.reloadCurrent === undefined) {
        throw new Error("configuration reload is unavailable");
      }
      await options.host.reloadCurrent();
      sendJson(response, 200, { ok: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      sendFailure(response, 400, "bad_request", message);
    }
  }

  async function handleEvents(request: IncomingMessage, response: ServerResponse): Promise<void> {
    // Build the snapshot before switching protocol so a projection failure can
    // still be answered as an ordinary JSON error.
    const initial = await currentState();
    response.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    response.flushHeaders();

    let closed = false;
    let ticking = false;
    let lastSerialized = JSON.stringify(initial);
    let tickTimer: ReturnType<typeof setInterval> | null = null;
    let pingTimer: ReturnType<typeof setInterval> | null = null;

    function stop(): void {
      if (closed) return;
      closed = true;
      if (tickTimer !== null) clearInterval(tickTimer);
      if (pingTimer !== null) clearInterval(pingTimer);
      clients.delete(client);
      if (!response.writableEnded) {
        try {
          response.end();
        } catch {
          // The peer is already gone; there is nothing left to close.
        }
      }
    }

    function writeFrame(frame: string): void {
      if (closed || response.writableEnded) return;
      try {
        response.write(frame);
      } catch (error) {
        log(`sse write failed: ${describeError(error)}`);
        stop();
      }
    }

    async function tick(): Promise<void> {
      if (closed || ticking) return;
      ticking = true;
      try {
        const state = await currentState();
        const serialized = JSON.stringify(state);
        if (serialized === lastSerialized) return;
        lastSerialized = serialized;
        const event: WebEvent = { type: "state", state };
        writeFrame(`data: ${JSON.stringify(event)}\n\n`);
      } catch (error) {
        // A failed projection must not kill the stream; the next tick retries.
        log(`sse state failed: ${describeError(error)}`);
      } finally {
        ticking = false;
      }
    }

    const client = { stop };
    clients.add(client);
    const initialEvent: WebEvent = { type: "state", state: initial };
    writeFrame(`data: ${JSON.stringify(initialEvent)}\n\n`);
    writeFrame("retry: 1000\n\n");
    tickTimer = setInterval(() => {
      void tick();
    }, tickMs);
    pingTimer = setInterval(() => {
      writeFrame(": ping\n\n");
    }, PING_INTERVAL_MS);
    response.on("close", stop);
    response.on("error", stop);
    request.resume();
  }

  async function handleMessage(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const body = await readJsonBody(request);
    if (!body.ok) {
      sendFailure(response, body.status, body.code, body.message);
      return;
    }
    const record = asRecord(body.value);
    const text = record?.["text"];
    if (record === null || typeof text !== "string") {
      sendFailure(response, 400, "bad_request", "text is required");
      return;
    }
    const images = parseImages(record["images"]);
    if (!images.ok) {
      sendFailure(response, 400, "bad_request", images.message);
      return;
    }
    const run = options.host.current().controller.submit(text, images.images);
    // The Run outlives this request: its progress is delivered by SSE, exactly
    // like the terminal's composer, so the response must not wait for the result.
    void run.catch((error: unknown) => {
      log(`web run failed: ${describeError(error)}`);
    });
    sendJson(response, 202, { ok: true });
  }

  async function handleApproval(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const body = await readJsonBody(request);
    if (!body.ok) {
      sendFailure(response, body.status, body.code, body.message);
      return;
    }
    const record = asRecord(body.value);
    const decision = record?.["decision"];
    if (decision !== "allow" && decision !== "deny") {
      sendFailure(response, 400, "bad_request", "decision must be allow or deny");
      return;
    }
    const controller = options.host.current().controller;
    const view = controller.view();
    const disclosure = view.pendingDisclosure ?? null;
    if (
      view.pendingApproval === null &&
      disclosure === null &&
      view.pendingApprovalPreview === null
    ) {
      sendFailure(response, 409, "conflict", "no approval is pending");
      return;
    }
    const action = decision === "allow" ? controller.approve() : controller.deny();
    void action.catch((error: unknown) => {
      log(`web approval failed: ${describeError(error)}`);
    });
    sendJson(response, 200, { ok: true });
  }

  async function handleQuestion(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const body = await readJsonBody(request);
    if (!body.ok) {
      sendFailure(response, body.status, body.code, body.message);
      return;
    }
    const record = asRecord(body.value);
    const text = record?.["text"];
    if (record === null || typeof text !== "string") {
      sendFailure(response, 400, "bad_request", "text is required");
      return;
    }
    const controller = options.host.current().controller;
    if (controller.view().pendingQuestion === null) {
      sendFailure(response, 409, "conflict", "no question is pending");
      return;
    }
    const answered = controller.answer(text);
    void answered.catch((error: unknown) => {
      log(`web answer failed: ${describeError(error)}`);
    });
    sendJson(response, 200, { ok: true });
  }

  async function handleDeclineQuestion(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    request.resume();
    const controller = options.host.current().controller;
    if (controller.view().pendingQuestion === null) {
      sendFailure(response, 409, "conflict", "no question is pending");
      return;
    }
    const declined = controller.declineQuestion();
    void declined.catch((error: unknown) => {
      log(`web question decline failed: ${describeError(error)}`);
    });
    sendJson(response, 200, { ok: true });
  }

  async function handleCancel(request: IncomingMessage, response: ServerResponse): Promise<void> {
    request.resume();
    const controller = options.host.current().controller;
    const { runStatus } = controller.view();
    if (runStatus !== "active" && runStatus !== "waiting") {
      sendFailure(response, 409, "conflict", "no run is active");
      return;
    }
    const cancelled = controller.cancelRun();
    void cancelled.catch((error: unknown) => {
      log(`web cancel failed: ${describeError(error)}`);
    });
    sendJson(response, 200, { ok: true });
  }

  async function handleSession(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const body = await readJsonBody(request);
    if (!body.ok) {
      sendFailure(response, body.status, body.code, body.message);
      return;
    }
    const record = asRecord(body.value);
    if (record === null) {
      sendFailure(response, 400, "bad_request", "sessionId is required");
      return;
    }
    const sessionId = record["sessionId"];
    if (sessionId !== null && typeof sessionId !== "string") {
      sendFailure(response, 400, "bad_request", "sessionId must be a string or null");
      return;
    }
    try {
      await options.host.switchSession(sessionId);
    } catch (error) {
      if (error instanceof WebSessionError) {
        sendFailure(response, statusForCode(error.code), error.code, error.message);
        return;
      }
      throw error;
    }
    sendJson(response, 200, { ok: true });
  }

  async function handleRename(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const body = await readJsonBody(request);
    if (!body.ok) {
      sendFailure(response, body.status, body.code, body.message);
      return;
    }
    const record = asRecord(body.value);
    const sessionId = record?.["sessionId"];
    if (record === null || typeof sessionId !== "string" || sessionId.length === 0) {
      sendFailure(response, 400, "bad_request", "sessionId is required");
      return;
    }
    const title = record["title"];
    if (title !== null && typeof title !== "string") {
      sendFailure(response, 400, "bad_request", "title must be a string or null");
      return;
    }
    await runSessionOperation(response, () => options.host.renameSession(sessionId, title));
  }

  async function handleDelete(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const body = await readJsonBody(request);
    if (!body.ok) {
      sendFailure(response, body.status, body.code, body.message);
      return;
    }
    const record = asRecord(body.value);
    const sessionId = record?.["sessionId"];
    if (record === null || typeof sessionId !== "string" || sessionId.length === 0) {
      sendFailure(response, 400, "bad_request", "sessionId is required");
      return;
    }
    await runSessionOperation(response, async () => {
      if (options.host.current().sessionId === sessionId) {
        await options.host.switchSession(null);
      }
      await options.host.deleteSession(sessionId);
    });
  }

  async function runSessionOperation(
    response: ServerResponse,
    operation: () => Promise<void>,
  ): Promise<void> {
    try {
      await operation();
    } catch (error) {
      if (error instanceof WebSessionError) {
        sendFailure(response, statusForCode(error.code), error.code, error.message);
        return;
      }
      throw error;
    }
    sendJson(response, 200, { ok: true });
  }

  async function handleQuit(request: IncomingMessage, response: ServerResponse): Promise<void> {
    request.resume();
    sendJson(response, 200, { ok: true });
    const quit = options.onQuit;
    if (quit === undefined) return;
    try {
      const outcome = quit();
      if (outcome instanceof Promise) {
        void outcome.catch((error: unknown) => {
          log(`quit handler failed: ${describeError(error)}`);
        });
      }
    } catch (error) {
      log(`quit handler failed: ${describeError(error)}`);
    }
  }

  async function handleStatic(
    request: IncomingMessage,
    response: ServerResponse,
    pathname: string,
  ): Promise<void> {
    const method = request.method ?? "GET";
    if (method !== "GET" && method !== "HEAD") {
      sendMethodNotAllowed(response, ["GET", "HEAD"]);
      return;
    }
    let asset = await readAsset(pathname);
    if (asset === null && spaEligible(pathname)) asset = await readAsset("/");
    if (asset === null) {
      response.statusCode = 404;
      response.setHeader("Content-Type", "text/plain; charset=utf-8");
      response.setHeader("Cache-Control", "no-store");
      response.end("Not Found");
      return;
    }
    response.statusCode = 200;
    response.setHeader("Content-Type", asset.contentType);
    response.setHeader("Content-Length", String(asset.body.byteLength));
    response.setHeader("Cache-Control", "no-cache");
    if (method === "HEAD") {
      response.end();
      return;
    }
    response.end(asset.body);
  }

  async function readAsset(
    pathname: string,
  ): Promise<Readonly<{ body: Uint8Array; contentType: string }> | null> {
    const asset = await options.assets.read(pathname);
    if (asset !== null) return asset;
    // The asset source serves "/" as index.html; accepting "/index.html" as well
    // keeps a minimal source implementation compatible with the contract.
    return pathname === "/" ? options.assets.read("/index.html") : null;
  }

  function reject(
    response: ServerResponse,
    request: IncomingMessage,
    status: number,
    code: WebErrorCode,
    message: string,
  ): void {
    request.resume();
    sendFailure(response, status, code, message);
  }

  function close(): Promise<void> {
    if (closing !== null) return closing;
    closing = (async () => {
      for (const client of [...clients]) client.stop();
      clients.clear();
      await closeServer();
    })();
    return closing;
  }

  return { port, url, close };
}

type ApiHandler = (request: IncomingMessage, response: ServerResponse) => Promise<void> | void;

type RawBody =
  | Readonly<{ kind: "ok"; buffer: Buffer }>
  | Readonly<{ kind: "too_large" }>
  | Readonly<{ kind: "aborted" }>;

type JsonBody =
  | Readonly<{ ok: true; value: unknown }>
  | Readonly<{ ok: false; status: number; code: WebErrorCode; message: string }>;

type ImageParse =
  | Readonly<{ ok: true; images: readonly WebImage[] | undefined }>
  | Readonly<{ ok: false; message: string }>;

const IMAGE_MEDIA_TYPES: readonly string[] = WEB_IMAGE_MEDIA_TYPES;

async function readJsonBody(request: IncomingMessage): Promise<JsonBody> {
  const read = await readBodyBytes(request);
  if (read.kind === "aborted") {
    return {
      ok: false,
      status: 400,
      code: "bad_request",
      message: "request body could not be read",
    };
  }
  if (read.kind === "too_large") {
    return {
      ok: false,
      status: 413,
      code: "bad_request",
      message: `request body exceeds ${MAX_JSON_BODY_BYTES} bytes`,
    };
  }
  if (read.buffer.length === 0) {
    return { ok: false, status: 400, code: "bad_request", message: "request body is required" };
  }
  try {
    return { ok: true, value: JSON.parse(read.buffer.toString("utf8")) as unknown };
  } catch {
    return {
      ok: false,
      status: 400,
      code: "bad_request",
      message: "request body is not valid JSON",
    };
  }
}

function readBodyBytes(request: IncomingMessage): Promise<RawBody> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;
    const settle = (result: RawBody): void => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    request.on("data", (chunk: Buffer | string) => {
      if (settled) return;
      const buffer = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
      total += buffer.length;
      if (total > MAX_JSON_BODY_BYTES) {
        // Stop buffering but leave the stream flowing so the client can finish
        // the upload and read the 413 on the same connection.
        chunks.length = 0;
        settle({ kind: "too_large" });
        return;
      }
      chunks.push(buffer);
    });
    request.on("end", () => settle({ kind: "ok", buffer: Buffer.concat(chunks) }));
    request.on("error", () => settle({ kind: "aborted" }));
    request.on("aborted", () => settle({ kind: "aborted" }));
  });
}

function parseImages(value: unknown): ImageParse {
  if (value === undefined) return { ok: true, images: undefined };
  if (!Array.isArray(value)) return { ok: false, message: "images must be an array" };
  const images: WebImage[] = [];
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      return { ok: false, message: "each image must be an object" };
    }
    const record = entry as Record<string, unknown>;
    const mediaType = record["mediaType"];
    const base64 = record["base64"];
    if (typeof mediaType !== "string" || !IMAGE_MEDIA_TYPES.includes(mediaType)) {
      return { ok: false, message: "unsupported image mediaType" };
    }
    if (typeof base64 !== "string" || base64.length === 0) {
      return { ok: false, message: "image base64 is required" };
    }
    images.push({ mediaType: mediaType as WebImage["mediaType"], base64 });
  }
  return { ok: true, images };
}

function isConfigRequest(value: unknown): value is WebConfigRequest {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    ["anthropic_messages", "openai_chat", "openai_responses"].includes(
      String(record["protocol"]),
    ) &&
    typeof record["baseUrl"] === "string" &&
    record["baseUrl"].length > 0 &&
    typeof record["model"] === "string" &&
    record["model"].length > 0 &&
    typeof record["apiKey"] === "string" &&
    record["apiKey"].length > 0
  );
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

/** Single-page-app fallback: only a path that does not name a file can be a route. */
function spaEligible(pathname: string): boolean {
  if (looksLikeTraversal(pathname)) return false;
  const segment = pathname.slice(pathname.lastIndexOf("/") + 1);
  return segment.length > 0 && !segment.includes(".");
}

function looksLikeTraversal(pathname: string): boolean {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return true;
  }
  if (decoded.includes("\u0000") || decoded.includes("\\")) return true;
  return decoded.split("/").some((segment) => segment === "..");
}

function parseUrl(rawUrl: string | undefined): URL | null {
  try {
    return new URL(rawUrl ?? "/", "http://localhost");
  } catch {
    return null;
  }
}

function statusForCode(code: WebErrorCode): number {
  switch (code) {
    case "bad_request":
      return 400;
    case "forbidden":
      return 403;
    case "not_found":
      return 404;
    case "conflict":
      return 409;
    case "unavailable":
      return 503;
    case "unsupported":
      return 405;
    case "internal":
      return 500;
    case "session_open_failed":
      return 502;
    case "catalog_failed":
      return 502;
  }
}

function sendJson(response: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  response.statusCode = status;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("Content-Length", String(Buffer.byteLength(body)));
  response.setHeader("Cache-Control", "no-store");
  response.end(body);
}

function sendFailure(
  response: ServerResponse,
  status: number,
  code: WebErrorCode,
  message: string,
): void {
  sendJson(response, status, { ok: false, code, message });
}

function sendMethodNotAllowed(response: ServerResponse, allowed: readonly string[]): void {
  response.setHeader("Allow", allowed.join(", "));
  sendFailure(response, 405, "unsupported", "method is not allowed");
}

function normalizeTickMs(value: number | undefined): number {
  return value !== undefined && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : DEFAULT_TICK_MS;
}

function formatUrlHost(address: string): string {
  return address.includes(":") ? `[${address}]` : address;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
