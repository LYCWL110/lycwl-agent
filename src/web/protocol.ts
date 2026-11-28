/**
 * Wire contract between the local web server and the browser client.
 *
 * The web interface is a second presentation layer over the same Runtime the TUI
 * drives: the browser reads `WebState` snapshots and sends commands, exactly like
 * the terminal reads `TuiViewState` and submits composer intents. Nothing here
 * executes a tool or decides a permission; that authority stays in the
 * Coordinator behind `TuiController`.
 *
 * These types are the single source of truth for the HTTP/SSE payloads. The
 * browser assets are plain JavaScript, so `docs/web-api.md` mirrors this file for
 * the client author; keep the two in step.
 */
import type {
  PendingApprovalView,
  PendingDisclosureView,
  PendingQuestionView,
} from "../application/coordinator/runtime-coordinator.ts";
import type { TodoList } from "../domain/planning/todo.ts";
import type { ProviderImage } from "../ports/model-provider.ts";
import type { TuiController } from "../tui/controller.ts";
import type { TranscriptEntry, TuiViewState } from "../tui/view-model.ts";

/** Permission mode the process was launched with, shown as 普通模式 / 只读模式. */
export type WebModeLabel = "full" | "read-only";

/**
 * One live Session the web server can present.
 *
 * `controller` is the same presentation-agnostic command surface the Ink app
 * uses. The web layer never reaches past it to the Coordinator.
 */
export type WebSessionRuntime = Readonly<{
  sessionId: string;
  controller: TuiController;
  /** Configured model name, or null for the demo runtime. */
  modelLabel: string | null;
  modeLabel: WebModeLabel;
  contextWindow: number | null;
  demo: boolean;
  warnings: readonly string[];
}>;

/** One row of the session sidebar. `current` marks this process's Session. */
export type WebSessionListEntry = Readonly<{
  sessionId: string;
  label: string;
  title: string | null;
  modifiedAtUtc: string;
  bytes: number;
  current: boolean;
}>;

/**
 * Complete snapshot the browser renders.
 *
 * Every field is a projection of authoritative Runtime state, so a snapshot is
 * always safe to apply wholesale (no increment protocol to fall out of sync).
 */
export type WebState = Readonly<{
  sessionId: string;
  modelLabel: string | null;
  modeLabel: WebModeLabel;
  contextWindow: number | null;
  demo: boolean;
  warnings: readonly string[];
  /** True while a session switch is replacing the live runtime. */
  switching: boolean;
  runStatus: TuiViewState["runStatus"];
  waitingKind: TuiViewState["waitingKind"];
  activity: TuiViewState["activity"];
  streaming: Readonly<{ text: string }> | null;
  transcript: readonly TranscriptEntry[];
  todo: TodoList | null;
  meter: TuiViewState["meter"];
  usage: TuiViewState["usage"];
  safeCode: string | null;
  answerError: string | null;
  commandNotice: string | null;
  pendingApproval: PendingApprovalView | null;
  pendingApprovalPreview: readonly string[] | null;
  pendingDisclosure: PendingDisclosureView | null;
  pendingQuestion: PendingQuestionView | null;
  canSubmit: boolean;
  queueingInput: boolean;
  sessionList: readonly WebSessionListEntry[];
}>;

/**
 * Failure codes the client may act on. `session_busy` and `conflict` mean the
 * same thing to the user: try again after the current turn settles.
 */
export type WebErrorCode =
  | "bad_request"
  | "forbidden"
  | "not_found"
  | "conflict"
  | "unavailable"
  | "unsupported"
  | "internal"
  | "session_open_failed"
  | "catalog_failed";

export type WebFailure = Readonly<{
  ok: false;
  code: WebErrorCode;
  message: string;
}>;

export type WebCommandResponse = Readonly<{ ok: true }> | WebFailure;

export type WebStateResponse = Readonly<{ ok: true; state: WebState }> | WebFailure;

/** An image attached in the composer; base64 without a data-URL prefix. */
export type WebImage = Readonly<{
  mediaType: ProviderImage["mediaType"];
  base64: string;
}>;

export const WEB_IMAGE_MEDIA_TYPES: readonly ProviderImage["mediaType"][] = [
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
];

export type WebMessageRequest = Readonly<{
  text: string;
  images?: readonly WebImage[];
}>;

export type WebApprovalRequest = Readonly<{
  decision: "allow" | "deny";
}>;

export type WebAnswerRequest = Readonly<{ text: string }>;

/** `sessionId: null` starts a new Session. */
export type WebSessionRequest = Readonly<{ sessionId: string | null }>;

export type WebRenameRequest = Readonly<{
  sessionId: string;
  title: string | null;
}>;

export type WebDeleteRequest = Readonly<{ sessionId: string }>;

export type WebConfigRequest = Readonly<{
  protocol: "anthropic_messages" | "openai_chat" | "openai_responses";
  baseUrl: string;
  model: string;
  apiKey: string;
}>;

/** Server-sent event frames. `state` replaces the client's snapshot. */
export type WebEvent = Readonly<{ type: "state"; state: WebState }> | Readonly<{ type: "ping" }>;

/**
 * Session records on disk, as the sidebar needs them.
 *
 * Same shape as the TUI controller's `sessionCatalog`, resolved in bootstrap so
 * the web layer never parses session files itself.
 */
export type WebSessionCatalog = Readonly<{
  list: () => Promise<
    | Readonly<{ ok: true; sessions: readonly Omit<WebSessionListEntry, "current">[] }>
    | Readonly<{ ok: false; code: string }>
  >;
  rename: (
    sessionId: string,
    title: string | null,
  ) => Promise<Readonly<{ ok: true }> | Readonly<{ ok: false; code: string }>>;
  remove: (
    sessionId: string,
  ) => Promise<Readonly<{ ok: true }> | Readonly<{ ok: false; code: string }>>;
}>;

/**
 * Build a fresh runtime for a Session.
 *
 * `null` means a new Session; any other id must resolve to a recorded Session or
 * reject with a `not_found` error. The factory is supplied by bootstrap because
 * only it owns configuration, credentials and the process-wide directories.
 */
export type WebSessionOpener = (sessionId: string | null) => Promise<WebSessionRuntime>;
