# lycwl web interface — HTTP contract

`lycwl web` serves a local browser interface over the same Runtime the terminal
drives. The server binds loopback only, and the browser is a pure view: it reads
snapshots and submits commands through the `TuiController` command surface.

Source of truth: [`src/web/protocol.ts`](../src/web/protocol.ts). This page mirrors
it for the client author; if they disagree, the TypeScript types win.

## Security model

- Bind address is `127.0.0.1` (never `0.0.0.0`).
- `Host` must be a loopback name (`127.0.0.1`, `localhost`, `[::1]`) with the
  server's port. Anything else is rejected with `403`, so DNS rebinding cannot
  reach the API.
- State-changing requests (`POST`/`DELETE`) whose `Origin` header names another
  origin are rejected with `403`. Same-origin and header-less (curl) requests are
  allowed.
- Request bodies are JSON and capped at 24 MiB (images travel base64 inline).
- The server has the same authority as the terminal process it lives in: anyone
  who can reach the loopback port can drive the agent. That is the same trust
  boundary as a terminal on the machine, and it is documented rather than
  implied.

## Endpoints

| Method | Path                 | Request body                  | Response                    |
| ------ | -------------------- | ----------------------------- | --------------------------- |
| `GET`  | `/api/state`         | —                             | `WebStateResponse`          |
| `GET`  | `/api/events`        | — (SSE)                       | `text/event-stream` of `WebEvent` |
| `POST` | `/api/message`       | `WebMessageRequest`           | `WebCommandResponse` (202)  |
| `POST` | `/api/approval`      | `WebApprovalRequest`          | `WebCommandResponse`        |
| `POST` | `/api/question`      | `WebAnswerRequest`            | `WebCommandResponse`        |
| `POST` | `/api/question/decline` | —                          | `WebCommandResponse`        |
| `POST` | `/api/cancel`        | —                             | `WebCommandResponse`        |
| `POST` | `/api/session`       | `WebSessionRequest`           | `WebCommandResponse`        |
| `POST` | `/api/session/rename`| `WebRenameRequest`            | `WebCommandResponse`        |
| `POST` | `/api/session/delete`| `WebDeleteRequest`            | `WebCommandResponse`        |
| `POST` | `/api/quit`          | —                             | `WebCommandResponse`        |

`GET /` and `GET /assets/*` serve the static client. Unknown extension-less `GET`
paths serve `index.html` (single-page app). Static assets are cached briefly
(`Cache-Control: no-cache`) so a rebuilt client is picked up on refresh.

### `GET /api/state` → `{ ok: true, state: WebState }`

The complete snapshot. The browser uses this for the first paint; afterwards the
SSE stream keeps it current.

### `GET /api/events` → Server-Sent Events

Each frame is `data: <JSON WebEvent>\n\n`. The first frame is always the current
`state`. Afterwards a `state` frame is sent whenever a serialized snapshot
changes (the server samples at ~8 Hz while a Run is active and slower when idle),
plus a `ping` comment every 15 s so idle proxies do not close the stream.
`retry: 1000` is sent once.

### `POST /api/message`

Body `{ "text": string, "images"?: [{ "mediaType": "image/png", "base64": "..." }] }`.
Returns `202 { ok: true }` immediately; the Run streams through SSE. A Run already
in progress accepts queued input exactly like the TUI composer.

### `POST /api/approval`

Body `{ "decision": "allow" | "deny" }`. Applies to whichever pending approval,
sensitive-disclosure confirmation or verification prompt is current.

### `POST /api/question` / `POST /api/question/decline`

Answer the pending model question, or decline it. The snapshot carries the
question shape (`answerType`, `options`, `multiple`, `allowFreeText`).

### `POST /api/cancel`

Cancel the active Run. After it settles the snapshot returns to `idle` and the
partial transcript is kept (same behaviour as the terminal).

### `POST /api/session`

Body `{ "sessionId": string | null }`. `null` starts a new Session. Any other id
must be a recorded Session, otherwise `404 not_found`. The switch opens the new
runtime first and only then closes the previous one, so a failed switch leaves
the current conversation usable. While switching, the snapshot has
`switching: true` and mutations answer `409 conflict`.

### `POST /api/session/rename` / `POST /api/session/delete`

Rename with `title: string | null` (`null` clears the override); delete removes a
recorded Session. Deleting the current Session is `409 conflict`.

### `POST /api/quit`

Closes the server and lets the process exit. The browser shows the shutdown in
the composer area.

## `WebState` shape

```jsonc
{
  "sessionId": "uuid",
  "modelLabel": "deepseek-v4.1-flash", // null in demo mode
  "modeLabel": "full",                  // "read-only" when launched --read-only
  "contextWindow": 262144,              // null when the provider did not report one
  "demo": false,
  "warnings": ["..."],
  "switching": false,
  "runStatus": "idle",                  // idle|active|waiting|completed|failed|cancelled
  "waitingKind": null,                  // approval|question|configuration|other
  "activity": null,                     // thinking|working
  "streaming": { "text": "..." },        // live assistant text, or null
  "transcript": [
    { "id": "...", "kind": "user", "text": "...", "status": null },
    { "id": "...", "kind": "assistant", "text": "...", "status": null },
    { "id": "...", "kind": "tool", "text": "...", "status": "ok",
      "tool": { "name": "read_file", "summary": "src/main.ts", "details": "..." } },
    { "id": "...", "kind": "system", "text": "...", "status": null }
  ],
  "todo": { "items": [{ "id": "1", "content": "...", "state": "in_progress" }], "revision": 3 },
  "meter": { "used": 7168, "window": 262144, "fraction": 0.027, "source": "measured", "atCompaction": false },
  "usage": { "inputTokens": 7000, "outputTokens": 120, "cachedInputTokens": 0, "reasoningTokens": 0 },
  "safeCode": null,
  "answerError": null,
  "commandNotice": null,
  "pendingApproval": { "approvalId": "...", "toolCallId": "...", "toolName": "run_command", "requestVersion": 2 },
  "pendingApprovalPreview": ["$ pnpm test"],
  "pendingDisclosure": null,
  "pendingQuestion": null,
  "canSubmit": true,
  "queueingInput": false,
  "sessionList": [
    { "sessionId": "uuid", "label": "什么是 Rime LLM", "title": null,
      "modifiedAtUtc": "2026-11-28T03:00:00.000Z", "bytes": 4096, "current": true }
  ]
}
```

## Failure shape

Every non-2xx JSON response is `{ "ok": false, "code": WebErrorCode, "message": string }`
with codes: `bad_request`, `forbidden`, `not_found`, `conflict`, `unavailable`,
`unsupported`, `internal`, `session_open_failed`, `catalog_failed`.

## Client behaviour rules

- Never apply optimistic transcript entries: render the snapshot, so a failed or
  cancelled Run cannot leave invented text on screen.
- While `runStatus` is `active` show `streaming.text` at the end of the
  transcript and a cancel control; while `waiting` show the approval, disclosure
  or question card instead of the composer.
- `demo: true` must be visible: the header shows "演示模式" and the settings panel
  repeats the warning. A demo runtime never looks like configured agent output.
- When SSE drops, retry with `EventSource` (built-in reconnect) and re-fetch
  `/api/state` after reconnect before trusting the stream.
