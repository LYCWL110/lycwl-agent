/**
 * lycwl web client.
 *
 * The browser is a pure view over the local `lycwl --web` server: the first paint
 * comes from GET /api/state, every later frame replaces the whole snapshot, and
 * commands are POSTed to the endpoints documented in docs/web-api.md. Nothing
 * here executes a tool or decides a permission; the SSR snapshot is the only
 * source of transcript text (no optimistic rendering).
 *
 * No build step, no dependencies, no external requests. ES module, modern
 * browsers only.
 */

// ---------------------------------------------------------------------------
// Static inline icons (trusted constants; never derived from transcript data).
// ---------------------------------------------------------------------------

const ICONS = {
  edit: `<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M4 20h4.2L19 9.2 14.8 5 4 15.8V20Z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><path d="m13.2 6.6 4.2 4.2" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>`,
  trash: `<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M5 7h14M10 7V5h4v2M7 7l.8 12h8.4L17 7M10.5 10.5v5M13.5 10.5v5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  alert: `<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M12 4.5 21 19H3l9-14.5Z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><path d="M12 10v4M12 16.6v.1" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>`,
  info: `<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><circle cx="12" cy="12" r="8.4" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M12 11v5M12 8.2v.1" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>`,
  shield: `<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M12 3.6 19 6v6c0 4.2-2.8 7.2-7 8.4-4.2-1.2-7-4.2-7-8.4V6l7-2.4Z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><path d="m9.2 12 2 2 3.8-4" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  eye: `<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M2.8 12S6.3 5.8 12 5.8 21.2 12 21.2 12 17.7 18.2 12 18.2 2.8 12 2.8 12Z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><circle cx="12" cy="12" r="2.8" fill="none" stroke="currentColor" stroke-width="1.6"/></svg>`,
  question: `<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><circle cx="12" cy="12" r="8.4" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M9.6 9.4a2.5 2.5 0 1 1 3.4 2.3c-.8.4-1 .9-1 1.7M12 16.5v.1" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>`,
  clock: `<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><circle cx="12" cy="12" r="8.4" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M12 7.6V12l3 1.8" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  checklist: `<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="m4 7 1.6 1.6L8.8 5.4M4 16.4 5.6 18l3.2-3.2M12 7.2h8M12 16.6h8" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
};

const API = {
  state: "/api/state",
  events: "/api/events",
  message: "/api/message",
  approval: "/api/approval",
  question: "/api/question",
  questionDecline: "/api/question/decline",
  cancel: "/api/cancel",
  session: "/api/session",
  sessionRename: "/api/session/rename",
  sessionDelete: "/api/session/delete",
  quit: "/api/quit",
  config: "/api/config",
};

const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_IMAGES = 6;

const USER_STATUS_LABELS = {
  queued: "已排队",
  sending: "发送中…",
  ready: "已发送",
  sent: "已发送",
  retained: "已保留",
  withdrawn: "已撤回",
  unknown: "状态未知",
};

const TOOL_STATUS_LABELS = {
  ok: "完成",
  succeeded: "完成",
  success: "完成",
  requested: "已请求",
  running: "运行中",
  "awaiting approval": "等待批准",
  waiting: "等待中",
  queued: "排队中",
  denied: "已拒绝",
  failed: "失败",
  error: "失败",
  cancelled: "已取消",
  canceled: "已取消",
};

const RUN_STATUS_LABELS = {
  idle: "空闲",
  active: "运行中",
  waiting: "等待中",
  completed: "已完成",
  failed: "失败",
  cancelled: "已取消",
};

// ---------------------------------------------------------------------------
// DOM references (module script runs after the document is parsed).
// ---------------------------------------------------------------------------

const dom = {
  sidebar: document.getElementById("sidebar"),
  sidebarScrim: document.getElementById("sidebar-scrim"),
  brandMode: document.getElementById("brand-mode"),
  sessionList: document.getElementById("session-list"),
  newSessionBtn: document.getElementById("new-session-btn"),
  openConsoleBtn: document.getElementById("open-console"),
  openSettingsBtn: document.getElementById("open-settings"),
  sidebarCollapse: document.getElementById("sidebar-collapse"),
  sidebarToggle: document.getElementById("sidebar-toggle"),
  headerDemo: document.getElementById("header-demo"),
  warningsBtn: document.getElementById("warnings-btn"),
  chatStatus: document.getElementById("chat-status"),
  connectionBanner: document.getElementById("connection-banner"),
  switchingBanner: document.getElementById("switching-banner"),
  chatScroll: document.getElementById("chat-scroll"),
  emptyState: document.getElementById("empty-state"),
  suggestions: document.getElementById("suggestions"),
  transcript: document.getElementById("transcript"),
  todoPanel: document.getElementById("todo-panel"),
  waitingSlot: document.getElementById("waiting-slot"),
  bannerSlot: document.getElementById("banner-slot"),
  composer: document.getElementById("composer"),
  composerInput: document.getElementById("composer-input"),
  attachBtn: document.getElementById("attach-btn"),
  attachChips: document.getElementById("attach-chips"),
  imageInput: document.getElementById("image-input"),
  modelPill: document.getElementById("model-pill"),
  contextMeter: document.getElementById("context-meter"),
  stopBtn: document.getElementById("stop-btn"),
  sendBtn: document.getElementById("send-btn"),
  composerHint: document.getElementById("composer-hint"),
  shutdownNotice: document.getElementById("shutdown-notice"),
  toastStack: document.getElementById("toast-stack"),
  modalBackdrop: document.getElementById("modal-backdrop"),
  modal: document.getElementById("modal"),
  modalTitle: document.getElementById("modal-title"),
  modalBody: document.getElementById("modal-body"),
  modalClose: document.getElementById("modal-close"),
};

// ---------------------------------------------------------------------------
// Client state. The only authoritative content is `state.snapshot`.
// ---------------------------------------------------------------------------

const state = {
  snapshot: null,
  connected: false,
  sending: false,
  images: [],
  shutdown: false,
};

let sse = null;
let hadDisconnect = false;

let transcriptStructureKey = "";
const transcriptNodes = new Map();
const transcriptSignatures = new Map();
let sidebarKey = "";
let waitingKey = "";
let todoKey = "";
let bannerKey = "";
let attachKey = "";
let todoOpen = true;
let lastCommandNotice = null;
let pendingScroll = false;
let questionState = { questionId: "", version: -1, selected: new Set() };
let modalOpen = false;
let lastFocusedElement = null;

const mobileQuery = window.matchMedia("(max-width: 720px)");

// ---------------------------------------------------------------------------
// Small helpers.
// ---------------------------------------------------------------------------

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

const HTML_ESCAPES = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => HTML_ESCAPES[character] ?? character);
}

function formatTokens(value) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return null;
  if (value < 1024) return String(Math.round(value));
  const thousands = value / 1024;
  const rounded = thousands >= 10 ? Math.round(thousands) : Math.round(thousands * 10) / 10;
  return `${rounded}k`;
}

function formatNumber(value) {
  return typeof value === "number" && Number.isFinite(value) ? value.toLocaleString("zh-CN") : "—";
}

function formatTimestamp(isoString) {
  if (typeof isoString !== "string") return "";
  const date = new Date(isoString);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString("zh-CN", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function describeMode(snapshot) {
  return snapshot.modeLabel === "read-only" ? "只读模式" : "普通模式";
}

function describeRunStatus(snapshot) {
  if (snapshot.switching) return "正在切换会话";
  return RUN_STATUS_LABELS[snapshot.runStatus] ?? String(snapshot.runStatus ?? "未知");
}

function sessionLabel(entry) {
  const title = typeof entry.title === "string" ? entry.title.trim() : "";
  if (title.length > 0) return title;
  const label = typeof entry.label === "string" ? entry.label.trim() : "";
  return label.length > 0 ? label : entry.sessionId;
}

function isNearBottom() {
  const scroller = dom.chatScroll;
  return scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 90;
}

function hasPendingCard(snapshot) {
  return Boolean(
    snapshot.pendingApproval || snapshot.pendingDisclosure || snapshot.pendingQuestion,
  );
}

function isWaitingMode(snapshot) {
  return hasPendingCard(snapshot) || snapshot.runStatus === "waiting";
}

function toolDotClass(status) {
  const value = String(status ?? "").toLowerCase();
  if (value.includes("fail") || value.includes("error") || value === "denied")
    return "tool-dot-fail";
  if (value.includes("await") || value === "requested" || value === "waiting")
    return "tool-dot-warn";
  if (value === "running" || value === "started") return "tool-dot-run";
  if (value === "ok" || value === "succeeded" || value === "success" || value === "completed") {
    return "tool-dot-ok";
  }
  return "";
}

function toolStatusLabel(status) {
  const value = String(status ?? "");
  if (value.length === 0) return "";
  return TOOL_STATUS_LABELS[value] ?? value;
}

// ---------------------------------------------------------------------------
// Markdown-lite renderer.
//
// Everything is HTML-escaped before any tag is introduced, so transcript text
// can never inject markup. Only code spans, bold, headings, lists, blockquotes
// and http(s) links produce tags. No eval, no raw HTML.
// ---------------------------------------------------------------------------

function renderMarkdownLite(source) {
  const text = String(source ?? "").replace(/\r\n?/g, "\n");
  const lines = escapeHtml(text).split("\n");
  const blocks = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];
    const trimmed = line.trim();

    if (trimmed.startsWith("```")) {
      const language = trimmed.slice(3).trim();
      const codeLines = [];
      index += 1;
      while (index < lines.length && lines[index].trim() !== "```") {
        codeLines.push(lines[index]);
        index += 1;
      }
      if (index < lines.length) index += 1;
      const safeLanguage = /^[\w+#.-]{1,32}$/u.test(language) ? language : "";
      const classAttribute = safeLanguage ? ` class="language-${safeLanguage}"` : "";
      blocks.push(`<pre><code${classAttribute}>${codeLines.join("\n")}</code></pre>`);
      continue;
    }

    if (trimmed.length === 0) {
      index += 1;
      continue;
    }

    const heading = /^(#{1,6})\s+(.*)$/u.exec(line);
    if (heading !== null) {
      const level = heading[1].length;
      blocks.push(`<h${level}>${renderInline(heading[2])}</h${level}>`);
      index += 1;
      continue;
    }

    if (/^\s*[-*+]\s+/u.test(line)) {
      const items = [];
      while (index < lines.length && /^\s*[-*+]\s+/u.test(lines[index])) {
        items.push(`<li>${renderInline(lines[index].replace(/^\s*[-*+]\s+/u, ""))}</li>`);
        index += 1;
      }
      blocks.push(`<ul>${items.join("")}</ul>`);
      continue;
    }

    if (/^\s*\d+[.)]\s+/u.test(line)) {
      const items = [];
      while (index < lines.length && /^\s*\d+[.)]\s+/u.test(lines[index])) {
        items.push(`<li>${renderInline(lines[index].replace(/^\s*\d+[.)]\s+/u, ""))}</li>`);
        index += 1;
      }
      blocks.push(`<ol>${items.join("")}</ol>`);
      continue;
    }

    if (/^&gt;\s?/u.test(line)) {
      const quoted = [];
      while (index < lines.length && /^&gt;\s?/u.test(lines[index])) {
        quoted.push(lines[index].replace(/^&gt;\s?/u, ""));
        index += 1;
      }
      blocks.push(`<blockquote>${renderInline(quoted.join(" "))}</blockquote>`);
      continue;
    }

    const paragraph = [];
    while (index < lines.length && lines[index].trim() !== "" && !isBlockStart(lines[index])) {
      paragraph.push(renderInline(lines[index]));
      index += 1;
    }
    if (paragraph.length === 0) {
      index += 1;
      continue;
    }
    blocks.push(`<p>${paragraph.join("<br>")}</p>`);
  }

  return blocks.join("");
}

function isBlockStart(line) {
  const trimmed = line.trim();
  return (
    trimmed.startsWith("```") ||
    /^#{1,6}\s+/u.test(line) ||
    /^\s*[-*+]\s+/u.test(line) ||
    /^\s*\d+[.)]\s+/u.test(line) ||
    /^&gt;\s?/u.test(line)
  );
}

// Private-use sentinels mark protected spans while the rest of the line is
// formatted; they cannot collide with normal chat text in practice.
function renderInline(escapedText) {
  const codeSpans = [];
  let output = String(escapedText).replace(/`([^`\n]+)`/gu, (_match, code) => {
    codeSpans.push(`<code>${code}</code>`);
    return `\uE000c${codeSpans.length - 1}\uE001`;
  });

  const linkSpans = [];
  output = output.replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/gu, (_match, label, url) => {
    linkSpans.push(`<a href="${url}" target="_blank" rel="noopener noreferrer">${label}</a>`);
    return `\uE000l${linkSpans.length - 1}\uE001`;
  });

  output = output.replace(/\*\*([^*\n]+)\*\*/gu, "<strong>$1</strong>");
  output = autolink(output);

  output = output.replace(/\uE000l(\d+)\uE001/gu, (_match, position) => {
    return linkSpans[Number(position)] ?? "";
  });
  output = output.replace(/\uE000c(\d+)\uE001/gu, (_match, position) => {
    return codeSpans[Number(position)] ?? "";
  });
  return output;
}

function autolink(text) {
  return text.replace(/(^|[\s（(])(https?:\/\/[^\s<）)]+)/gu, (_match, prefix, rawUrl) => {
    let url = rawUrl;
    let trailing = "";
    const punctuation = /[.,;:!?，。；：！？、）】]+$/u.exec(url);
    if (punctuation !== null) {
      trailing = punctuation[0];
      url = url.slice(0, url.length - trailing.length);
    }
    if (url.length === 0) return `${prefix}${rawUrl}`;
    return `${prefix}<a href="${url}" target="_blank" rel="noopener noreferrer">${url}</a>${trailing}`;
  });
}

// ---------------------------------------------------------------------------
// Transport: snapshot fetch + SSE.
// ---------------------------------------------------------------------------

function setConnectionState(connected) {
  state.connected = connected;
  if (state.shutdown) return;
  dom.connectionBanner.hidden = connected;
}

async function refreshState() {
  try {
    const response = await fetch(API.state, {
      cache: "no-store",
      headers: { Accept: "application/json" },
    });
    if (!response.ok) return false;
    const payload = await response.json();
    if (payload === null || typeof payload !== "object") return false;
    if (payload.ok === true && payload.state && typeof payload.state === "object") {
      applySnapshot(payload.state);
      return true;
    }
    if (payload.ok === false && typeof payload.message === "string") {
      showToast(payload.message, "error");
    }
    return false;
  } catch {
    return false;
  }
}

function connectEvents() {
  if (state.shutdown) return;
  if (sse !== null) {
    sse.close();
    sse = null;
  }
  const source = new EventSource(API.events);
  sse = source;

  source.onopen = () => {
    setConnectionState(true);
    if (state.snapshot === null || hadDisconnect) {
      hadDisconnect = false;
      void refreshState();
    }
  };

  source.onmessage = (event) => handleEventPayload(event.data);
  source.addEventListener("state", (event) => handleEventPayload(event.data));
  source.addEventListener("ping", () => {});

  source.onerror = () => {
    if (state.shutdown) return;
    hadDisconnect = true;
    setConnectionState(false);
  };
}

function handleEventPayload(raw) {
  if (typeof raw !== "string" || raw.length === 0) return;
  let payload = null;
  try {
    payload = JSON.parse(raw);
  } catch {
    return;
  }
  if (payload === null || typeof payload !== "object") return;
  if (payload.type === "state" && payload.state && typeof payload.state === "object") {
    applySnapshot(payload.state);
  }
}

function applySnapshot(next) {
  const previousSessionId = state.snapshot === null ? null : state.snapshot.sessionId;
  state.snapshot = next;
  setConnectionState(true);

  if (previousSessionId !== null && next.sessionId !== previousSessionId) {
    state.images = [];
    attachKey = "";
    questionState = { questionId: "", version: -1, selected: new Set() };
    pendingScroll = true;
  }

  renderAll();
  handleCommandNotice();
}

async function boot() {
  const loaded = await refreshState();
  if (!loaded) setConnectionState(false);
  connectEvents();
}

// ---------------------------------------------------------------------------
// Toasts.
// ---------------------------------------------------------------------------

function showToast(message, kind = "info", timeoutMs) {
  const text = String(message ?? "").trim();
  if (text.length === 0) return;
  const toast = el("div", `toast toast-${kind}`, text);
  toast.addEventListener("click", () => toast.remove());
  dom.toastStack.append(toast);
  while (dom.toastStack.children.length > 3) {
    dom.toastStack.firstElementChild?.remove();
  }
  const lifetime = timeoutMs ?? (kind === "error" ? 6000 : 3600);
  window.setTimeout(() => toast.remove(), lifetime);
}

function handleCommandNotice() {
  const notice = state.snapshot === null ? null : state.snapshot.commandNotice;
  if (typeof notice === "string" && notice.trim().length > 0) {
    if (notice !== lastCommandNotice) {
      showToast(notice, "info");
      lastCommandNotice = notice;
    }
    return;
  }
  if (notice === null) lastCommandNotice = null;
}

// ---------------------------------------------------------------------------
// Commands over HTTP.
// ---------------------------------------------------------------------------

async function postJson(path, body) {
  let response;
  try {
    const headers = body === undefined ? {} : { "Content-Type": "application/json" };
    response = await fetch(path, {
      method: "POST",
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    showToast("无法连接本地服务，请确认 lycwl --web 仍在运行。", "error");
    return null;
  }

  let payload = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }

  if (!response.ok || payload === null || payload.ok !== true) {
    const message =
      payload !== null && typeof payload.message === "string" && payload.message.length > 0
        ? payload.message
        : `请求失败（HTTP ${response.status}）`;
    showToast(message, "error");
    return null;
  }
  return payload;
}

async function submitCommand(button, path, body) {
  if (button !== null) button.disabled = true;
  const payload = await postJson(path, body);
  if (payload === null && button !== null && button.isConnected) button.disabled = false;
  return payload;
}

async function runCardCommand(card, path, body) {
  const buttons = [...card.querySelectorAll("button")];
  for (const button of buttons) button.disabled = true;
  const payload = await postJson(path, body);
  if (payload === null) {
    for (const button of buttons) button.disabled = false;
    updateMultiSubmit(card);
  }
  return payload;
}

function updateMultiSubmit(card) {
  const submit = card.querySelector('[data-role="multi-submit"]');
  if (submit !== null) submit.disabled = questionState.selected.size === 0;
}

// ---------------------------------------------------------------------------
// Render pump.
// ---------------------------------------------------------------------------

function renderAll() {
  const snapshot = state.snapshot;
  if (snapshot === null) return;
  renderSidebar(snapshot);
  renderHeader(snapshot);
  renderChatStatus(snapshot);
  renderBanners(snapshot);
  renderWaiting(snapshot);
  renderTodo(snapshot);
  renderTranscript(snapshot);
  renderComposer(snapshot);
}

// ------------------------------- sidebar ----------------------------------

function renderSidebar(snapshot) {
  const modeText = snapshot.modeLabel === "read-only" ? "只读模式" : "普通模式";
  dom.brandMode.textContent = modeText;
  dom.brandMode.className = "brand-mode";
  dom.brandMode.title = "";

  const sessions = Array.isArray(snapshot.sessionList) ? snapshot.sessionList : [];
  const switching = snapshot.switching === true;
  const key = JSON.stringify([
    switching,
    sessions.map((entry) => [entry.sessionId, entry.title, entry.label, entry.current === true]),
  ]);
  if (key === sidebarKey) {
    dom.newSessionBtn.disabled = switching || state.shutdown;
    return;
  }
  sidebarKey = key;

  dom.sessionList.replaceChildren();
  if (sessions.length === 0) {
    dom.sessionList.append(el("p", "session-empty", "暂无记录会话"));
  } else {
    for (const entry of sessions) {
      dom.sessionList.append(buildSessionRow(entry, switching));
    }
  }
  dom.newSessionBtn.disabled = switching || state.shutdown;
}

function buildSessionRow(entry, switching) {
  const row = el("div", `session-row${entry.current === true ? " current" : ""}`);
  row.setAttribute("role", "listitem");

  const main = el("button", "session-main", sessionLabel(entry));
  main.type = "button";
  main.disabled = switching || state.shutdown;
  const modified = formatTimestamp(entry.modifiedAtUtc);
  main.title =
    modified.length > 0 ? `${sessionLabel(entry)}\n修改于 ${modified}` : sessionLabel(entry);
  if (entry.current === true) main.setAttribute("aria-current", "true");
  main.addEventListener("click", () => {
    void switchSession(entry.sessionId);
  });
  row.append(main);

  const actions = el("div", "session-actions");

  const rename = el("button", "session-action");
  rename.type = "button";
  rename.setAttribute("aria-label", `重命名会话：${sessionLabel(entry)}`);
  rename.title = "重命名";
  rename.innerHTML = ICONS.edit;
  rename.disabled = switching || state.shutdown;
  rename.addEventListener("click", (event) => {
    event.stopPropagation();
    void renameSession(entry);
  });

  const remove = el("button", "session-action danger");
  remove.type = "button";
  remove.setAttribute("aria-label", `删除会话：${sessionLabel(entry)}`);
  remove.title = "删除";
  remove.innerHTML = ICONS.trash;
  remove.disabled = switching || state.shutdown;
  remove.addEventListener("click", (event) => {
    event.stopPropagation();
    void deleteSession(entry);
  });

  actions.append(rename, remove);
  row.append(actions);
  return row;
}

async function switchSession(sessionId) {
  if (state.shutdown) return;
  const snapshot = state.snapshot;
  if (snapshot !== null && snapshot.switching === true) {
    showToast("正在切换会话，请稍候。", "warn");
    return;
  }
  if (sessionId !== null && snapshot !== null && sessionId === snapshot.sessionId) return;
  const payload = await postJson(API.session, { sessionId });
  if (payload === null) return;
  closeMobileSidebar();
  pendingScroll = true;
}

async function renameSession(entry) {
  if (state.shutdown) return;
  const current =
    typeof entry.title === "string" && entry.title.length > 0 ? entry.title : entry.label;
  const next = window.prompt("重命名会话", typeof current === "string" ? current : "");
  if (next === null) return;
  const trimmed = next.trim();
  await postJson(API.sessionRename, {
    sessionId: entry.sessionId,
    title: trimmed.length === 0 ? null : trimmed,
  });
}

async function deleteSession(entry) {
  if (state.shutdown) return;
  const label = sessionLabel(entry);
  const confirmed = window.confirm(`删除会话「${label}」？此操作不可撤销。`);
  if (!confirmed) return;
  await postJson(API.sessionDelete, { sessionId: entry.sessionId });
}

// ------------------------------- header -----------------------------------

function renderHeader(snapshot) {
  dom.headerDemo.hidden = true;
  const warnings = Array.isArray(snapshot.warnings) ? snapshot.warnings : [];
  dom.warningsBtn.hidden = warnings.length === 0;
  dom.warningsBtn.title =
    warnings.length === 0 ? "查看注意事项" : `查看 ${warnings.length} 条注意事项`;
}

function renderChatStatus(snapshot) {
  let text = "";
  let busy = false;
  let error = false;

  if (snapshot.switching === true) {
    text = "正在切换会话…";
    busy = true;
  } else if (snapshot.pendingDisclosure || snapshot.pendingApproval) {
    text = "等待你的确认…";
    busy = true;
  } else if (snapshot.pendingQuestion) {
    text = "等待你的回答…";
    busy = true;
  } else if (snapshot.runStatus === "active") {
    text = snapshot.activity === "thinking" ? "思考中…" : "工作中…";
    busy = true;
  } else if (snapshot.runStatus === "waiting") {
    text = "等待中…";
    busy = true;
  } else if (snapshot.runStatus === "failed") {
    text = "上次运行失败";
    error = true;
  }

  dom.chatStatus.textContent = text;
  dom.chatStatus.className = `chat-status${busy ? " is-busy" : ""}${error ? " is-error" : ""}`;
  dom.switchingBanner.hidden = snapshot.switching !== true;
}

// ------------------------------- banners ----------------------------------

function renderBanners(snapshot) {
  const safeCode =
    typeof snapshot.safeCode === "string" && snapshot.safeCode.length > 0
      ? snapshot.safeCode
      : null;
  const answerError =
    typeof snapshot.answerError === "string" && snapshot.answerError.length > 0
      ? snapshot.answerError
      : null;
  const key = `${safeCode ?? ""}\u001f${answerError ?? ""}`;
  if (key === bannerKey) return;
  bannerKey = key;

  dom.bannerSlot.replaceChildren();
  if (safeCode !== null) {
    dom.bannerSlot.append(buildBanner("danger", "运行已安全停止：", safeCode, "alert"));
  }
  if (answerError !== null) {
    dom.bannerSlot.append(buildBanner("warn", "回答未被接受：", answerError, "info"));
  }
  dom.bannerSlot.hidden = dom.bannerSlot.children.length === 0;
}

function buildBanner(kind, labelText, message, iconName) {
  const banner = el("div", `banner banner-${kind}`);
  const icon = el("span", "banner-icon");
  icon.setAttribute("aria-hidden", "true");
  icon.innerHTML = ICONS[iconName] ?? "";
  const text = el("span");
  text.append(el("strong", "banner-label", labelText), document.createTextNode(message));
  banner.append(icon, text);
  return banner;
}

// --------------------------------- todo ------------------------------------

function renderTodo(snapshot) {
  const todo = snapshot.todo;
  const items = todo !== null && Array.isArray(todo.items) ? todo.items : [];
  if (items.length === 0) {
    dom.todoPanel.hidden = true;
    dom.todoPanel.replaceChildren();
    todoKey = "";
    return;
  }

  dom.todoPanel.hidden = false;
  const key = `${todo.revision ?? 0}\u001f${items
    .map((item) => `${item.id}:${item.state}:${item.content}`)
    .join("\u001e")}`;
  if (key !== todoKey) {
    todoKey = key;
    dom.todoPanel.replaceChildren(buildTodoToggle(items), buildTodoList(items));
  }
  dom.todoPanel.classList.toggle("open", todoOpen);
}

function buildTodoToggle(items) {
  const completed = items.filter((item) => item.state === "completed").length;
  const toggle = el("button", "todo-toggle");
  toggle.type = "button";
  toggle.setAttribute("aria-expanded", todoOpen ? "true" : "false");
  const icon = el("span");
  icon.innerHTML = ICONS.checklist;
  icon.setAttribute("aria-hidden", "true");
  toggle.append(
    icon,
    el("span", "", "任务清单"),
    el("span", "todo-count", `${completed}/${items.length}`),
  );
  const chevron = el("span", "todo-chevron", "▾");
  chevron.setAttribute("aria-hidden", "true");
  toggle.append(chevron);
  toggle.addEventListener("click", () => {
    todoOpen = !todoOpen;
    dom.todoPanel.classList.toggle("open", todoOpen);
    toggle.setAttribute("aria-expanded", todoOpen ? "true" : "false");
  });
  return toggle;
}

function buildTodoList(items) {
  const list = el("ul", "todo-list");
  for (const item of items) {
    const stateName = String(item.state ?? "pending");
    const row = el("li", `todo-item ${stateName}`);
    const mark = el("span", "todo-mark");
    mark.setAttribute("aria-hidden", "true");
    if (stateName === "completed") mark.textContent = "✓";
    else if (stateName === "in_progress") mark.textContent = "•";
    else if (stateName === "cancelled") mark.textContent = "–";
    row.append(mark, el("span", "todo-content", String(item.content ?? "")));
    list.append(row);
  }
  return list;
}

// --------------------------- waiting / cards -------------------------------

function renderWaiting(snapshot) {
  const question = snapshot.pendingQuestion;
  const key = JSON.stringify([
    snapshot.switching,
    snapshot.runStatus,
    snapshot.waitingKind,
    snapshot.pendingApproval === null || snapshot.pendingApproval === undefined
      ? null
      : [snapshot.pendingApproval.approvalId, snapshot.pendingApproval.toolName],
    snapshot.pendingApprovalPreview ?? null,
    snapshot.pendingDisclosure === null || snapshot.pendingDisclosure === undefined
      ? null
      : [
          snapshot.pendingDisclosure.disclosureId,
          snapshot.pendingDisclosure.requestVersion,
          snapshot.pendingDisclosure.safePreview,
        ],
    question === null || question === undefined
      ? null
      : [
          question.questionId,
          question.requestVersion,
          question.answerType,
          question.multiple,
          question.allowFreeText,
          question.question,
          (question.options ?? []).map((option) => [option.id, option.label]),
        ],
  ]);

  if (key === waitingKey) return;
  waitingKey = key;

  const cards = [];
  if (snapshot.pendingDisclosure) cards.push(buildDisclosureCard(snapshot.pendingDisclosure));
  if (snapshot.pendingApproval) {
    cards.push(buildApprovalCard(snapshot.pendingApproval, snapshot.pendingApprovalPreview));
  }
  if (snapshot.pendingQuestion) cards.push(buildQuestionCard(snapshot.pendingQuestion));
  if (cards.length === 0 && snapshot.runStatus === "waiting") {
    cards.push(buildWaitingFallback(snapshot));
  }

  dom.waitingSlot.replaceChildren();
  if (cards.length === 0) {
    dom.waitingSlot.hidden = true;
    return;
  }
  dom.waitingSlot.hidden = false;
  dom.waitingSlot.append(...cards);
}

function createCard(title, iconName) {
  const card = el("section", "card");
  const heading = el("h3", "card-title");
  const icon = el("span", "card-icon");
  icon.setAttribute("aria-hidden", "true");
  icon.innerHTML = ICONS[iconName] ?? "";
  heading.append(icon, el("span", "", title));
  card.append(heading);
  return card;
}

function buildApprovalCard(pending, preview) {
  const card = createCard("需要你的确认", "shield");
  const toolName =
    typeof pending.toolName === "string" && pending.toolName.length > 0
      ? pending.toolName
      : "未知工具";
  card.append(el("p", "card-text", `lycwl 想执行工具「${toolName}」，需要你的允许。`));

  const lines = Array.isArray(preview) ? preview : null;
  if (lines === null) {
    card.append(
      el(
        "p",
        "card-note",
        "无法安全预览这次操作的内容，因此这里不提供「允许」。请回到终端确认，或直接拒绝。",
      ),
    );
    const actions = el("div", "card-actions");
    const deny = el("button", "btn btn-danger", "拒绝");
    deny.type = "button";
    deny.addEventListener("click", () => {
      void runCardCommand(card, API.approval, { decision: "deny" });
    });
    actions.append(deny);
    card.append(actions);
    return card;
  }

  const previewBlock = el("pre", "card-preview");
  previewBlock.textContent = lines.length > 0 ? lines.join("\n") : "（预览为空）";
  card.append(previewBlock);

  const actions = el("div", "card-actions");
  const allow = el("button", "btn btn-primary", "允许");
  allow.type = "button";
  allow.addEventListener("click", () => {
    void runCardCommand(card, API.approval, { decision: "allow" });
  });
  const deny = el("button", "btn btn-ghost", "拒绝");
  deny.type = "button";
  deny.addEventListener("click", () => {
    void runCardCommand(card, API.approval, { decision: "deny" });
  });
  actions.append(allow, deny, el("span", "card-actions-note", "决定会立即应用到当前运行"));
  card.append(actions);
  return card;
}

function buildDisclosureCard(pending) {
  const card = createCard("敏感信息确认", "eye");
  card.append(
    el("p", "card-text", "模型请求会把下面的内容发送给模型服务商，请确认其中没有敏感信息。"),
  );
  const preview = el("pre", "card-preview");
  preview.textContent = String(pending.safePreview ?? "");
  card.append(preview);

  const actions = el("div", "card-actions");
  const allow = el("button", "btn btn-primary", "同意发送");
  allow.type = "button";
  allow.addEventListener("click", () => {
    void runCardCommand(card, API.approval, { decision: "allow" });
  });
  const deny = el("button", "btn btn-ghost", "拒绝");
  deny.type = "button";
  deny.addEventListener("click", () => {
    void runCardCommand(card, API.approval, { decision: "deny" });
  });
  actions.append(allow, deny, el("span", "card-actions-note", "同意后会继续当前运行"));
  card.append(actions);
  return card;
}

function ensureQuestionState(question) {
  if (
    questionState.questionId !== question.questionId ||
    questionState.version !== question.requestVersion
  ) {
    questionState = {
      questionId: question.questionId,
      version: question.requestVersion,
      selected: new Set(),
    };
  }
}

function buildQuestionCard(question) {
  ensureQuestionState(question);
  const card = createCard("lycwl 想问你一个问题", "question");
  card.append(el("p", "card-text", String(question.question ?? "")));

  if (question.answerType === "confirmation") {
    const actions = el("div", "card-actions");
    const yes = el("button", "btn btn-primary", "确认");
    yes.type = "button";
    yes.addEventListener("click", () => {
      void runCardCommand(card, API.question, { text: "yes" });
    });
    const no = el("button", "btn btn-ghost", "取消");
    no.type = "button";
    no.addEventListener("click", () => {
      void runCardCommand(card, API.question, { text: "no" });
    });
    actions.append(yes, no, buildDeclineButton(card));
    card.append(actions);
    return card;
  }

  if (
    question.answerType === "choice" &&
    Array.isArray(question.options) &&
    question.options.length > 0
  ) {
    const optionsWrap = el("div", "question-options");
    for (const [index, option] of question.options.entries()) {
      const button = el("button", "option-btn");
      button.type = "button";
      const selected = questionState.selected.has(option.id);
      button.setAttribute("aria-pressed", selected ? "true" : "false");
      button.append(
        el("span", "option-key", String.fromCharCode(65 + index)),
        el("span", "option-label", String(option.label ?? option.id)),
      );
      button.addEventListener("click", () => {
        if (question.multiple === true) {
          if (questionState.selected.has(option.id)) questionState.selected.delete(option.id);
          else questionState.selected.add(option.id);
          button.setAttribute(
            "aria-pressed",
            questionState.selected.has(option.id) ? "true" : "false",
          );
          updateMultiSubmit(card);
        } else {
          void runCardCommand(card, API.question, { text: option.id });
        }
      });
      optionsWrap.append(button);
    }
    card.append(optionsWrap);

    if (question.multiple === true) {
      const actions = el("div", "card-actions");
      const submit = el("button", "btn btn-primary", "提交选择");
      submit.type = "button";
      submit.dataset.role = "multi-submit";
      submit.disabled = questionState.selected.size === 0;
      submit.addEventListener("click", () => {
        const ids = [...questionState.selected];
        if (ids.length > 0) void runCardCommand(card, API.question, { text: ids.join(",") });
      });
      actions.append(submit, buildDeclineButton(card));
      card.append(actions);
      card.append(el("p", "card-hint", "可多选：勾选若干项后点击「提交选择」。"));
    } else {
      const actions = el("div", "card-actions");
      actions.append(
        el("span", "card-actions-note", "点击一个选项即可回答"),
        buildDeclineButton(card),
      );
      card.append(actions);
    }
  }

  if (question.allowFreeText === true || question.answerType === "text") {
    const row = el("div", "free-text-row");
    const input = el("input", "free-text-input");
    input.type = "text";
    input.maxLength = 4000;
    input.placeholder =
      question.multiple === true ? "补充说明（多选时可选）" : "或输入你自己的回答…";
    input.setAttribute("aria-label", "输入回答");
    const send = el("button", "btn btn-primary", "发送");
    send.type = "button";
    const submitFreeText = () => {
      const value = input.value.trim();
      if (value.length === 0) {
        showToast("请先输入回答。", "warn");
        return;
      }
      void runCardCommand(card, API.question, { text: value });
    };
    send.addEventListener("click", submitFreeText);
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        submitFreeText();
      }
    });
    row.append(input, send);
    card.append(row);
  }

  return card;
}

function buildDeclineButton(card) {
  const button = el("button", "btn btn-ghost btn-small", "拒绝");
  button.type = "button";
  button.addEventListener("click", () => {
    void runCardCommand(card, API.questionDecline);
  });
  return button;
}

function buildWaitingFallback(snapshot) {
  const card = createCard("等待运行继续", "clock");
  let text = "当前运行正在等待终端中的操作，请在终端窗口中查看。";
  if (snapshot.waitingKind === "configuration") {
    text =
      "当前运行正在等待终端完成配置（例如 API Key 或模型设置）。请在终端处理后，运行会自动继续。";
  } else if (snapshot.waitingKind === "approval") {
    text = "当前运行正在等待终端中的审批操作，请在终端窗口中确认。";
  } else if (snapshot.waitingKind === "question") {
    text = "当前运行正在等待终端中的回答，请在终端窗口中输入。";
  }
  card.append(el("p", "card-text", text));

  const actions = el("div", "card-actions");
  const stop = el("button", "btn btn-ghost", "停止任务");
  stop.type = "button";
  stop.addEventListener("click", () => {
    void submitCommand(stop, API.cancel);
  });
  actions.append(stop);
  card.append(actions);
  return card;
}

// ------------------------------ transcript --------------------------------

function buildTranscriptItems(snapshot) {
  const entries = Array.isArray(snapshot.transcript) ? snapshot.transcript : [];
  const streamingText =
    snapshot.streaming !== null &&
    snapshot.streaming !== undefined &&
    typeof snapshot.streaming.text === "string"
      ? snapshot.streaming.text
      : "";
  const lastEntry = entries.length > 0 ? entries[entries.length - 1] : null;
  const items = [];
  let streamingSeen = false;

  for (const entry of entries) {
    const isStreaming =
      entry.status === "streaming" ||
      entry.id === "streaming" ||
      (streamingText.length > 0 &&
        entry === lastEntry &&
        entry.kind === "assistant" &&
        entry.text === streamingText);
    if (isStreaming) streamingSeen = true;
    items.push({ entry, streaming: isStreaming });
  }

  if (!streamingSeen && streamingText.length > 0) {
    items.push({
      entry: { id: "streaming", kind: "assistant", text: streamingText, status: "streaming" },
      streaming: true,
    });
  }
  return items;
}

function transcriptItemSignature(item) {
  const entry = item.entry;
  return JSON.stringify([
    entry.kind,
    entry.status ?? null,
    entry.text ?? "",
    entry.tool ?? null,
    item.streaming === true,
  ]);
}

function renderTranscript(snapshot) {
  const items = buildTranscriptItems(snapshot);
  const nearBottom = isNearBottom();
  const structureKey = items
    .map((item) => `${item.entry.id}\u001f${item.entry.kind}\u001f${item.streaming ? 1 : 0}`)
    .join("\u001e");

  if (structureKey !== transcriptStructureKey) {
    transcriptStructureKey = structureKey;
    const fragment = document.createDocumentFragment();
    const liveIds = new Set();
    for (const item of items) {
      liveIds.add(item.entry.id);
      let node = transcriptNodes.get(item.entry.id);
      if (!node || node.dataset.kind !== item.entry.kind) {
        node = createTranscriptNode(item.entry.kind);
        transcriptNodes.set(item.entry.id, node);
      }
      updateTranscriptNode(node, item.entry, item.streaming);
      fragment.append(node);
    }
    for (const id of transcriptNodes.keys()) {
      if (!liveIds.has(id)) {
        transcriptNodes.delete(id);
        transcriptSignatures.delete(id);
      }
    }
    dom.transcript.replaceChildren(fragment);
  }

  for (const item of items) {
    const node = transcriptNodes.get(item.entry.id);
    if (!node) continue;
    const signature = transcriptItemSignature(item);
    if (transcriptSignatures.get(item.entry.id) === signature) continue;
    updateTranscriptNode(node, item.entry, item.streaming);
  }

  const empty = items.length === 0 && !hasPendingCard(snapshot);
  dom.emptyState.hidden = !empty;
  dom.transcript.hidden = items.length === 0;

  if (nearBottom || pendingScroll) {
    dom.chatScroll.scrollTop = dom.chatScroll.scrollHeight;
    pendingScroll = false;
  }
}

function createTranscriptNode(kind) {
  let node;
  if (kind === "user") {
    node = el("article", "msg msg-user");
  } else if (kind === "assistant") {
    node = el("article", "msg msg-assistant");
  } else if (kind === "tool") {
    node = buildToolNode();
  } else {
    node = el("div", "msg msg-system");
  }
  node.dataset.kind = kind;
  return node;
}

function updateTranscriptNode(node, entry, streaming) {
  if (entry.kind === "user") {
    let bubble = node.querySelector(".user-bubble");
    if (!bubble) {
      bubble = el("div", "user-bubble");
      node.append(bubble);
    }
    bubble.textContent = String(entry.text ?? "");
    const statusLabel =
      typeof entry.status === "string" && entry.status.length > 0 && entry.status !== "sent"
        ? (USER_STATUS_LABELS[entry.status] ?? entry.status)
        : "";
    let meta = node.querySelector(".msg-meta");
    if (statusLabel.length > 0) {
      if (!meta) {
        meta = el("div", "msg-meta");
        node.append(meta);
      }
      meta.textContent = statusLabel;
    } else if (meta) {
      meta.remove();
    }
  } else if (entry.kind === "assistant") {
    let content = node.querySelector(".assistant-text");
    if (!content) {
      content = el("div", "assistant-text markdown");
      node.append(content);
    }
    const body = renderMarkdownLite(entry.text ?? "");
    content.innerHTML = streaming
      ? `${body}<span class="streaming-caret" aria-hidden="true"></span>`
      : body;
    if (streaming) content.setAttribute("aria-busy", "true");
    else content.removeAttribute("aria-busy");
    node.classList.toggle("is-streaming", streaming);
  } else if (entry.kind === "tool") {
    updateToolNode(node, entry);
  } else {
    node.textContent = String(entry.text ?? "");
  }
  transcriptSignatures.set(entry.id, transcriptItemSignature({ entry, streaming }));
}

function buildToolNode() {
  const node = el("article", "msg msg-tool");
  const head = el("div", "tool-head");
  const dot = el("span", "tool-dot");
  const name = el("span", "tool-name");
  const summary = el("span", "tool-summary");
  const status = el("span", "tool-status");
  head.append(dot, name, summary, status);

  const details = el("details", "tool-details");
  details.append(el("summary", "", "查看详情"), el("pre", "tool-pre"));
  node.append(head, details);
  return node;
}

function updateToolNode(node, entry) {
  const tool = entry.tool ?? {};
  const status = String(entry.status ?? "");
  node.querySelector(".tool-dot").className = `tool-dot ${toolDotClass(status)}`.trim();
  node.querySelector(".tool-name").textContent = String(tool.name ?? "tool");
  node.querySelector(".tool-summary").textContent = String(tool.summary ?? entry.text ?? "");
  node.querySelector(".tool-status").textContent = toolStatusLabel(status);

  const details = node.querySelector(".tool-details");
  const pre = node.querySelector(".tool-pre");
  const detailsText = typeof tool.details === "string" ? tool.details : "";
  if (detailsText.length > 0) {
    pre.textContent = detailsText;
    details.hidden = false;
  } else {
    pre.textContent = "";
    details.hidden = true;
  }
}

// ------------------------------- composer ---------------------------------

function renderComposer(snapshot) {
  const shutdown = state.shutdown;
  const waitingMode = isWaitingMode(snapshot);
  const switching = snapshot.switching === true;
  const disabled = shutdown || switching;

  dom.composer.hidden = waitingMode || shutdown;
  dom.composerHint.hidden = waitingMode || shutdown;
  dom.shutdownNotice.hidden = !shutdown;
  dom.attachChips.hidden = shutdown || state.images.length === 0;

  dom.modelPill.textContent =
    snapshot.modelLabel ?? "未配置模型";
  dom.modelPill.classList.remove("demo");
  dom.modelPill.title =
    snapshot.modelLabel === null || snapshot.modelLabel === undefined
      ? "当前没有配置模型"
      : `模型：${snapshot.modelLabel}`;

  const meter = describeMeter(snapshot.meter);
  dom.contextMeter.textContent = meter.text;
  dom.contextMeter.title = meter.title;
  dom.contextMeter.classList.toggle("is-warning", meter.warning);

  dom.stopBtn.hidden =
    shutdown || (snapshot.runStatus !== "active" && snapshot.runStatus !== "waiting");

  dom.composerInput.disabled = disabled;
  dom.attachBtn.disabled = disabled;
  dom.sendBtn.disabled = disabled || state.sending;
  dom.newSessionBtn.disabled = disabled;
  dom.composerInput.placeholder =
    "给 lycwl 发消息";

  let hint = "Enter 发送 · Shift+Enter 换行";
  if (snapshot.runStatus === "active") {
    hint = "Enter 发送 · 当前任务进行中，发送的内容会排队";
  } else if (snapshot.queueingInput === true) {
    hint = "Enter 发送 · 发送的内容会排队等待";
  }
  dom.composerHint.textContent = hint;

  renderAttachChips();
}

function describeMeter(meter) {
  if (meter === null || meter === undefined) {
    return { text: "上下文 --", warning: false, title: "还没有上下文用量数据" };
  }
  const used = formatTokens(meter.used);
  const windowSize = formatTokens(meter.window);
  const approximate = meter.source === "estimated" ? "≈" : "";
  const usedText = used === null ? "--" : `${approximate}${used}`;
  const windowText = windowSize === null ? "--" : windowSize;
  const fraction = typeof meter.fraction === "number" ? Math.round(meter.fraction * 100) : null;
  const warning = meter.atCompaction === true || (fraction !== null && fraction >= 85);
  const parts = [
    meter.source === "estimated" ? "估算值" : "已测量",
    fraction === null ? null : `占用 ${fraction}%`,
    meter.atCompaction === true ? "即将压缩上下文" : null,
  ].filter((part) => part !== null);
  return {
    text: `上下文 ${usedText} / ${windowText}`,
    warning,
    title: parts.join(" · "),
  };
}

function renderAttachChips() {
  const key = state.images.map((image) => `${image.name}:${image.base64.length}`).join("\u001f");
  if (key === attachKey) return;
  attachKey = key;
  dom.attachChips.replaceChildren();
  if (state.images.length === 0) {
    dom.attachChips.hidden = true;
    return;
  }
  dom.attachChips.hidden = state.shutdown;
  state.images.forEach((image, index) => {
    const chip = el("div", "attach-chip");
    const thumbnail = el("img");
    thumbnail.src = image.dataUrl;
    thumbnail.alt = image.name;
    thumbnail.title = image.name;
    const remove = el("button", "attach-remove", "×");
    remove.type = "button";
    remove.setAttribute("aria-label", `移除图片：${image.name}`);
    remove.addEventListener("click", () => {
      state.images.splice(index, 1);
      attachKey = "";
      renderAttachChips();
      renderComposer(state.snapshot ?? {});
    });
    chip.append(thumbnail, remove);
    dom.attachChips.append(chip);
  });
}

// --------------------------- composer actions ------------------------------

function autoGrowComposer() {
  const input = dom.composerInput;
  input.style.height = "auto";
  input.style.height = `${Math.min(input.scrollHeight, 200)}px`;
}

async function handleSend() {
  if (state.shutdown || state.sending) return;
  const snapshot = state.snapshot;
  if (snapshot !== null && snapshot.switching === true) {
    showToast("正在切换会话，请稍候。", "warn");
    return;
  }

  const text = dom.composerInput.value.trim();
  if (text.startsWith("/")) {
    dom.composerInput.value = "";
    autoGrowComposer();
    await handleSlashCommand(text);
    return;
  }

  if (text.length === 0 && state.images.length === 0) {
    showToast("请输入内容再发送。", "warn");
    return;
  }

  const images = state.images.map((image) => ({
    mediaType: image.mediaType,
    base64: image.base64,
  }));
  state.sending = true;
  if (snapshot !== null) renderComposer(snapshot);

  const body = images.length > 0 ? { text, images } : { text };
  const payload = await postJson(API.message, body);
  state.sending = false;
  if (payload === null) {
    if (snapshot !== null) renderComposer(snapshot);
    return;
  }

  dom.composerInput.value = "";
  state.images = [];
  attachKey = "";
  autoGrowComposer();
  renderAttachChips();
  if (snapshot !== null) renderComposer(snapshot);
  pendingScroll = true;
  dom.composerInput.focus();
}

async function handleSlashCommand(raw) {
  const name = raw.split(/\s+/u)[0].toLowerCase();
  if (name === "/new") {
    await switchSession(null);
    return;
  }
  if (name === "/cancel") {
    await postJson(API.cancel);
    return;
  }
  if (name === "/help") {
    showToast(
      "网页端可用命令：/new 新建会话 · /cancel 停止当前任务 · /help 查看帮助。其他命令请在终端中使用。",
      "info",
      6000,
    );
    return;
  }
  showToast("该命令请在终端中使用", "warn");
}

async function addImageFiles(fileList) {
  const files = [...fileList];
  for (const file of files) {
    if (state.images.length >= MAX_IMAGES) {
      showToast(`最多附加 ${MAX_IMAGES} 张图片。`, "warn");
      break;
    }
    if (!IMAGE_TYPES.has(file.type)) {
      showToast(`不支持的图片格式：${file.type || file.name}`, "warn");
      continue;
    }
    if (file.size > MAX_IMAGE_BYTES) {
      showToast(`图片过大（上限 ${MAX_IMAGE_BYTES / 1024 / 1024} MB）：${file.name}`, "warn");
      continue;
    }
    const data = await readImageFile(file);
    if (data === null) {
      showToast(`读取图片失败：${file.name}`, "error");
      continue;
    }
    state.images.push({
      name: file.name,
      mediaType: file.type,
      base64: data.base64,
      dataUrl: data.dataUrl,
    });
  }
  attachKey = "";
  renderAttachChips();
  if (state.snapshot !== null) renderComposer(state.snapshot);
}

function readImageFile(file) {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = typeof reader.result === "string" ? reader.result : "";
      const comma = result.indexOf(",");
      if (comma < 0) {
        resolve(null);
        return;
      }
      resolve({ dataUrl: result, base64: result.slice(comma + 1) });
    };
    reader.onerror = () => resolve(null);
    reader.readAsDataURL(file);
  });
}

async function sendSuggestion(prompt) {
  if (state.shutdown) return;
  const snapshot = state.snapshot;
  if (snapshot !== null && snapshot.switching === true) return;
  pendingScroll = true;
  const payload = await postJson(API.message, { text: prompt });
  if (payload === null) return;
  dom.composerInput.focus();
}

// -------------------------------- modals ----------------------------------

function openModal(title, build) {
  lastFocusedElement = document.activeElement;
  dom.modalTitle.textContent = title;
  dom.modalBody.replaceChildren();
  build(dom.modalBody);
  dom.modalBackdrop.hidden = false;
  modalOpen = true;
  dom.modal.focus();
}

function closeModal() {
  if (!modalOpen) return;
  modalOpen = false;
  dom.modalBackdrop.hidden = true;
  dom.modalBody.replaceChildren();
  if (lastFocusedElement instanceof HTMLElement && lastFocusedElement.isConnected) {
    lastFocusedElement.focus();
  }
  lastFocusedElement = null;
}

function appendKv(parent, key, value, options = {}) {
  const row = el("div", "kv-row");
  row.append(el("span", "kv-key", key));
  const classNames = ["kv-value"];
  if (options.mono === true) classNames.push("mono");
  if (options.muted === true) classNames.push("muted");
  const valueNode = el("span", classNames.join(" "), value);
  if (typeof options.title === "string") valueNode.title = options.title;
  row.append(valueNode);
  parent.append(row);
}

function openConsoleModal() {
  openModal("控制台", buildConsoleModal);
}

function buildConsoleModal(body) {
  const snapshot = state.snapshot;
  if (snapshot === null) {
    body.append(el("p", "modal-note", "尚未收到服务状态，请稍候。"));
    return;
  }

  const overview = el("section", "modal-section");
  overview.append(el("h3", "section-title", "运行概览"));
  const overviewList = el("div", "kv-list");
  appendKv(overviewList, "模型", snapshot.modelLabel ?? "未配置", { mono: true });
  appendKv(overviewList, "模式", describeMode(snapshot));
  appendKv(overviewList, "上下文窗口", formatTokens(snapshot.contextWindow) ?? "未知");
  appendKv(overviewList, "运行状态", describeRunStatus(snapshot));
  appendKv(overviewList, "服务连接", state.connected ? "已连接" : "重连中…");
  appendKv(overviewList, "当前会话", shortcutSessionId(snapshot.sessionId), {
    mono: true,
    title: snapshot.sessionId,
  });
  overview.append(overviewList);
  body.append(overview);
  const warnings = Array.isArray(snapshot.warnings) ? snapshot.warnings : [];
  if (warnings.length > 0) {
    const warningSection = el("section", "modal-section");
    warningSection.append(el("h3", "section-title", "注意事项"));
    const list = el("ul", "warning-list");
    for (const warning of warnings) list.append(el("li", "", String(warning)));
    warningSection.append(list);
    body.append(warningSection);
  }

  const usageSection = el("section", "modal-section");
  usageSection.append(el("h3", "section-title", "上次用量"));
  const usage = snapshot.usage;
  if (usage !== null && usage !== undefined) {
    const usageList = el("div", "kv-list");
    appendKv(usageList, "输入 tokens", formatNumber(usage.inputTokens));
    appendKv(usageList, "输出 tokens", formatNumber(usage.outputTokens));
    if (typeof usage.cachedInputTokens === "number") {
      appendKv(usageList, "缓存输入 tokens", formatNumber(usage.cachedInputTokens));
    }
    if (typeof usage.reasoningTokens === "number") {
      appendKv(usageList, "推理 tokens", formatNumber(usage.reasoningTokens));
    }
    usageSection.append(usageList);
  } else {
    usageSection.append(el("p", "modal-note", "本次运行尚未报告 token 用量。"));
  }
  body.append(usageSection);

  const danger = el("section", "modal-section danger-zone");
  danger.append(
    el("p", "danger-zone-text", "关闭服务会结束 lycwl --web 进程，当前页面将断开连接。"),
  );
  const quitButton = el("button", "btn btn-danger", "关闭服务");
  quitButton.type = "button";
  quitButton.addEventListener("click", () => {
    void quitServer(quitButton);
  });
  danger.append(quitButton);
  body.append(danger);
}

function shortcutSessionId(sessionId) {
  if (typeof sessionId !== "string" || sessionId.length === 0) return "—";
  return sessionId.length > 14 ? `${sessionId.slice(0, 8)}…${sessionId.slice(-4)}` : sessionId;
}

function openSettingsModal() {
  openModal("设置", buildSettingsModal);
}

function buildSettingsModal(body) {
  const snapshot = state.snapshot;
  const modelSection = el("section", "modal-section");
  modelSection.append(el("h3", "section-title", "模型与服务"));
  const modelList = el("div", "kv-list");
  appendKv(modelList, "当前模型", snapshot?.modelLabel ?? "未配置");
  appendKv(modelList, "连接状态", "已配置");
  modelSection.append(modelList);
  modelSection.append(
    el(
      "p",
      "modal-note",
      "模型、接口地址和 API Key 通过本机配置文件管理。首次配置或修改配置时，请运行 lycwl --cli --setup；保存后重新打开网页即可使用。",
    ),
  );
  const configForm = el("form", "config-form");
  const protocol = el("select", "config-input");
  protocol.innerHTML = '<option value="openai_responses">OpenAI Responses</option><option value="openai_chat">OpenAI Chat Completions</option><option value="anthropic_messages">Anthropic Messages</option>';
  const endpoint = el("input", "config-input");
  endpoint.type = "url";
  endpoint.placeholder = "https://api.openai.com";
  endpoint.value = "https://api.openai.com";
  const model = el("input", "config-input");
  model.type = "text";
  model.placeholder = "模型名称，例如 gpt-4.1";
  model.value = snapshot?.modelLabel ?? "";
  const key = el("input", "config-input");
  key.type = "password";
  key.placeholder = "API Key（仅发送到本机服务）";
  const save = el("button", "btn btn-primary", "保存并应用");
  save.type = "submit";
  configForm.append(
    el("label", "config-label", "协议"), protocol,
    el("label", "config-label", "接口地址"), endpoint,
    el("label", "config-label", "模型"), model,
    el("label", "config-label", "API Key"), key,
    save,
  );
  configForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    save.disabled = true;
    try {
      const response = await fetch(API.config, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ protocol: protocol.value, baseUrl: endpoint.value.trim(), model: model.value.trim(), apiKey: key.value }),
      });
      if (!response.ok) throw new Error("配置保存失败，请检查地址和凭据。");
      key.value = "";
      closeModal();
      showToast("配置已保存，模型已切换。", "info");
    } catch (error) {
      showToast(error instanceof Error ? error.message : "配置保存失败。", "error");
    } finally {
      save.disabled = false;
    }
  });
  modelSection.append(configForm);
  body.append(modelSection);

  const appearance = el("section", "modal-section");
  appearance.append(el("h3", "section-title", "外观"));
  const appearanceList = el("div", "kv-list");
  appendKv(appearanceList, "主题", "深色（当前仅提供深色主题）");
  appendKv(appearanceList, "界面语言", "简体中文");
  appearance.append(appearanceList);
  body.append(appearance);

  const sessionsSection = el("section", "modal-section");
  sessionsSection.append(el("h3", "section-title", "会话"));
  sessionsSection.append(
    el(
      "p",
      "modal-note",
      "会话记录保存在本机。左侧栏可以新建、切换、重命名或删除会话；删除当前会话会被拒绝，请先切换到其他会话。",
    ),
  );
  body.append(sessionsSection);

  const contextSection = el("section", "modal-section");
  contextSection.append(el("h3", "section-title", "上下文"));
  contextSection.append(
    el(
      "p",
      "modal-note",
      "输入框右下角显示上下文用量。达到模型窗口上限时由服务端决定是否压缩，网页端不会改写或截断历史记录。",
    ),
  );
  body.append(contextSection);

  const securitySection = el("section", "modal-section");
  securitySection.append(el("h3", "section-title", "关于"));
  securitySection.append(
    el(
      "p",
      "modal-note",
      "这是 lycwl 的本地网页界面，与终端共用同一个 Runtime、权限策略和会话记录。服务只监听回环地址，所有操作都通过本机连接发送。",
    ),
  );
  body.append(securitySection);

  if (snapshot !== null) {
    const warnings = Array.isArray(snapshot.warnings) ? snapshot.warnings : [];
    if (warnings.length > 0) {
      const warningSection = el("section", "modal-section");
      warningSection.append(el("h3", "section-title", "警告"));
      if (warnings.length > 0) {
        const list = el("ul", "warning-list");
        for (const warning of warnings) list.append(el("li", "", String(warning)));
        warningSection.append(list);
      }
      body.append(warningSection);
    }
  }
}

async function quitServer(button) {
  const confirmed = window.confirm(
    "确定要关闭 lycwl 服务吗？关闭后需要重新运行 lycwl --web 才能继续使用。",
  );
  if (!confirmed) return;
  button.disabled = true;

  let closed = false;
  try {
    const response = await fetch(API.quit, { method: "POST" });
    let payload = null;
    try {
      payload = await response.json();
    } catch {
      payload = null;
    }
    if (response.ok && (payload === null || payload.ok !== false)) {
      closed = true;
    } else if (payload !== null && typeof payload.message === "string") {
      showToast(payload.message, "error");
    }
  } catch {
    closed = true;
  }

  if (closed) enterShutdown();
  else button.disabled = false;
}

function enterShutdown() {
  if (state.shutdown) return;
  state.shutdown = true;
  if (sse !== null) {
    sse.close();
    sse = null;
  }
  closeModal();
  dom.connectionBanner.hidden = true;
  dom.switchingBanner.hidden = true;
  dom.waitingSlot.hidden = true;
  dom.waitingSlot.replaceChildren();
  waitingKey = "";
  dom.todoPanel.hidden = true;
  dom.composer.hidden = true;
  dom.composerHint.hidden = true;
  dom.shutdownNotice.hidden = false;
  dom.composerInput.disabled = true;
  dom.attachBtn.disabled = true;
  dom.sendBtn.disabled = true;
  dom.stopBtn.hidden = true;
  dom.newSessionBtn.disabled = true;
  dom.chatStatus.textContent = "服务已关闭";
  dom.chatStatus.className = "chat-status is-error";
  showToast("服务已关闭。", "info");
}

// ----------------------------- sidebar toggle ------------------------------

function isMobileLayout() {
  return mobileQuery.matches;
}

function openMobileSidebar() {
  document.body.classList.add("sidebar-mobile-open");
  dom.sidebarScrim.hidden = false;
  updateSidebarToggleAria();
}

function closeMobileSidebar() {
  document.body.classList.remove("sidebar-mobile-open");
  dom.sidebarScrim.hidden = true;
  updateSidebarToggleAria();
}

function toggleSidebar() {
  if (isMobileLayout()) {
    if (document.body.classList.contains("sidebar-mobile-open")) closeMobileSidebar();
    else openMobileSidebar();
    return;
  }
  document.body.classList.toggle("sidebar-collapsed");
  updateSidebarToggleAria();
}

function updateSidebarToggleAria() {
  const expanded = isMobileLayout()
    ? document.body.classList.contains("sidebar-mobile-open")
    : !document.body.classList.contains("sidebar-collapsed");
  dom.sidebarToggle.setAttribute("aria-expanded", expanded ? "true" : "false");
}

// -------------------------------- wiring -----------------------------------

function wireEvents() {
  dom.newSessionBtn.addEventListener("click", () => {
    void switchSession(null);
  });
  dom.sidebarToggle.addEventListener("click", toggleSidebar);
  dom.sidebarCollapse.addEventListener("click", () => {
    if (isMobileLayout()) {
      closeMobileSidebar();
      return;
    }
    document.body.classList.add("sidebar-collapsed");
    updateSidebarToggleAria();
    dom.sidebarToggle.focus();
  });
  dom.sidebarScrim.addEventListener("click", closeMobileSidebar);

  dom.suggestions.addEventListener("click", (event) => {
    const button = event.target.closest("[data-prompt]");
    if (!(button instanceof HTMLElement)) return;
    const prompt = button.dataset.prompt ?? "";
    if (prompt.length === 0) return;
    void sendSuggestion(prompt);
  });

  dom.composer.addEventListener("submit", (event) => {
    event.preventDefault();
    void handleSend();
  });

  dom.composerInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      void handleSend();
    }
  });
  dom.composerInput.addEventListener("input", autoGrowComposer);
  dom.composerInput.addEventListener("paste", (event) => {
    const files = event.clipboardData === null ? [] : [...event.clipboardData.files];
    if (files.length === 0) return;
    event.preventDefault();
    void addImageFiles(files);
  });

  dom.attachBtn.addEventListener("click", () => dom.imageInput.click());
  dom.imageInput.addEventListener("change", () => {
    const files = dom.imageInput.files === null ? [] : [...dom.imageInput.files];
    dom.imageInput.value = "";
    void addImageFiles(files);
  });

  dom.stopBtn.addEventListener("click", () => {
    void submitCommand(dom.stopBtn, API.cancel);
  });

  dom.openConsoleBtn.addEventListener("click", openConsoleModal);
  dom.openSettingsBtn.addEventListener("click", openSettingsModal);
  dom.warningsBtn.addEventListener("click", openConsoleModal);

  dom.modalClose.addEventListener("click", closeModal);
  dom.modalBackdrop.addEventListener("click", (event) => {
    if (event.target === dom.modalBackdrop) closeModal();
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      if (modalOpen) {
        event.preventDefault();
        closeModal();
        return;
      }
      if (document.body.classList.contains("sidebar-mobile-open")) {
        event.preventDefault();
        closeMobileSidebar();
      }
      return;
    }
    if (event.key === "Tab" && modalOpen) trapModalFocus(event);
  });

  dom.modal.addEventListener("keydown", (event) => {
    if (event.key === "Tab") trapModalFocus(event);
  });

  const onLayoutChange = () => {
    closeMobileSidebar();
    updateSidebarToggleAria();
  };
  mobileQuery.addEventListener("change", onLayoutChange);
}

function trapModalFocus(event) {
  const focusable = [
    ...dom.modal.querySelectorAll(
      'button:not([disabled]), [href], input:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
    ),
  ].filter((node) => node instanceof HTMLElement && node.offsetParent !== null);
  if (focusable.length === 0) return;
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

// --------------------------------- boot ------------------------------------

function init() {
  wireEvents();
  updateSidebarToggleAria();
  autoGrowComposer();
  dom.composerInput.disabled = true;
  dom.sendBtn.disabled = true;
  void boot();
}

init();
