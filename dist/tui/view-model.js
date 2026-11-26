import { isSessionId } from "../domain/identity/session-id.js";
export const EMPTY_VIEW = {
    runStatus: "idle",
    waitingKind: null,
    activity: null,
    streaming: null,
    safeCode: null,
    transcript: [],
    todo: null,
    pendingApproval: null,
    pendingDisclosure: null,
    pendingApprovalPreview: null,
    answerError: null,
    pendingQuestion: null,
    draft: "",
    canSubmit: true,
    queueingInput: false,
    meter: null,
};
/**
 * Derive the renderable state. Waiting kind is derived from the event chain and
 * live pending views, so a closed question panel still shows the wait.
 */
export function deriveView(input) {
    const waitingKind = deriveWaitingKind(input);
    const runStatus = input.runStatus;
    const transcript = buildTranscript(input.events);
    const streaming = input.streaming ?? null;
    const streamed = streaming === null || streaming.text.length === 0
        ? transcript
        : [
            ...transcript,
            {
                id: "streaming",
                kind: "assistant",
                text: streaming.text,
                status: "streaming",
            },
        ];
    return {
        runStatus,
        waitingKind,
        activity: streaming === null || streaming.text.length === 0
            ? deriveActivity(input, waitingKind)
            : "working",
        streaming,
        safeCode: input.safeCode,
        transcript: streamed,
        todo: input.todo,
        pendingApproval: input.pendingApproval,
        pendingDisclosure: input.pendingDisclosure ?? null,
        pendingApprovalPreview: deriveApprovalPreview(input),
        answerError: input.answerError ?? null,
        meter: null,
        pendingQuestion: input.pendingQuestion,
        draft: input.draft,
        canSubmit: runStatus !== "active" && waitingKind === null,
        queueingInput: runStatus === "active" || waitingKind !== null,
    };
}
function deriveActivity(input, waiting) {
    if (input.runStatus !== "active" || waiting !== null)
        return null;
    for (let index = input.events.length - 1; index >= 0; index -= 1) {
        switch (input.events[index]?.payload.kind) {
            case "run_cancel_requested":
            case "run_completed":
            case "run_failed":
            case "run_cancelled":
                return null;
            case "model_request_started":
            case "model_retry_scheduled":
                return "thinking";
            case "model_response_validated":
            case "tool_execution_started":
            case "tool_execution_finished":
            case "run_started":
            case "run_resumed":
                return "working";
        }
    }
    return null;
}
/**
 * The preview is read from the authoritative `approval_requested` event for the
 * pending approval, not from local state. The panel must show what the Runtime
 * actually recorded, so a stale local copy cannot become the thing the user
 * approves.
 */
function deriveApprovalPreview(input) {
    const pending = input.pendingApproval;
    if (pending === null)
        return null;
    for (let index = input.events.length - 1; index >= 0; index -= 1) {
        const payload = input.events[index]?.payload;
        if (payload === undefined)
            continue;
        if (payload.kind !== "approval_requested")
            continue;
        if (payload.approvalId !== pending.approvalId)
            continue;
        return payload.safePreview.split("\n");
    }
    // No recorded preview: the panel cannot describe the operation, so it offers
    // no preview rather than inventing one.
    return null;
}
function deriveWaitingKind(input) {
    if (input.pendingDisclosure != null)
        return "approval";
    if (input.pendingApproval !== null)
        return "approval";
    if (input.pendingQuestion !== null)
        return "question";
    if (input.runStatus !== "active" && input.runStatus !== "waiting")
        return null;
    for (let index = input.events.length - 1; index >= 0; index -= 1) {
        const payload = input.events[index]?.payload;
        if (payload === undefined)
            continue;
        if (payload.kind === "run_waiting") {
            if (payload.reason === "approval")
                return "approval";
            if (payload.reason === "user_input")
                return "question";
            if (payload.reason === "configuration")
                return "configuration";
            return "other";
        }
        if (payload.kind === "run_completed" ||
            payload.kind === "run_failed" ||
            payload.kind === "run_cancelled" ||
            payload.kind === "run_started" ||
            payload.kind === "run_resumed") {
            return null;
        }
    }
    return null;
}
function buildTranscript(events) {
    const entries = [];
    const tools = new Map();
    const inputs = new Map();
    const requests = new Map();
    const consumed = new Set();
    const inputRuns = new Map();
    const terminalRuns = new Set();
    const pausedRuns = new Set();
    const key = (runId, id) => `${runId}:${id}`;
    function updateTool(event, toolCallId, name, status, result) {
        const id = key(event.runId, toolCallId);
        let index = tools.get(id);
        if (index === undefined) {
            index = entries.length;
            tools.set(id, index);
            entries.push({
                id: event.eventId,
                kind: "tool",
                text: `${name ?? "tool"} ${status}`,
                status,
                tool: { name: name ?? "tool", summary: name ?? "tool", details: "" },
            });
        }
        const previous = entries[index];
        if (previous === undefined)
            return;
        const toolName = previous.tool?.name ?? name ?? "tool";
        entries[index] = {
            ...previous,
            text: result ?? `${toolName} ${status}`,
            status,
            tool: {
                name: toolName,
                summary: previous.tool?.summary ?? toolName,
                details: `${previous.tool?.details ?? ""}${result == null ? "" : `\n${result}`}`.trim(),
            },
        };
    }
    for (const event of events) {
        const payload = event.payload;
        switch (payload.kind) {
            case "run_input_queued":
                inputs.set(key(event.runId, payload.inputId), entries.length);
                inputRuns.set(entries.length, event.runId);
                entries.push({ id: event.eventId, kind: "user", text: payload.text, status: "queued" });
                break;
            case "run_input_withdrawn": {
                const index = inputs.get(key(event.runId, payload.inputId));
                const previous = index === undefined ? undefined : entries[index];
                if (previous !== undefined && index !== undefined)
                    entries[index] = { ...previous, status: "withdrawn" };
                break;
            }
            case "run_input_batch_consumed":
                for (const id of payload.inputIds) {
                    const inputKey = key(event.runId, id);
                    consumed.add(inputKey);
                    const index = inputs.get(inputKey);
                    const previous = index === undefined ? undefined : entries[index];
                    if (previous !== undefined && index !== undefined)
                        entries[index] = { ...previous, status: "ready" };
                }
                break;
            case "model_request_started": {
                const included = (payload.includedInputIds ?? []).map((id) => key(event.runId, id));
                requests.set(key(event.runId, payload.modelRequestId), included);
                for (const id of included) {
                    const index = inputs.get(id);
                    const previous = index === undefined ? undefined : entries[index];
                    if (previous !== undefined && index !== undefined && previous.status !== "sent")
                        entries[index] = { ...previous, status: "sending" };
                }
                break;
            }
            case "run_started":
                entries.push({
                    id: event.eventId,
                    kind: "user",
                    text: payload.input,
                    status: null,
                });
                break;
            case "model_response_validated":
                for (const id of requests.get(key(event.runId, payload.modelRequestId)) ?? []) {
                    const index = inputs.get(id);
                    const previous = index === undefined ? undefined : entries[index];
                    if (previous !== undefined && index !== undefined && consumed.has(id))
                        entries[index] = { ...previous, status: "sent" };
                }
                if (payload.text !== null && payload.text.length > 0) {
                    entries.push({
                        id: event.eventId,
                        kind: "assistant",
                        text: payload.text,
                        status: null,
                    });
                }
                break;
            case "tool_call_received": {
                updateTool(event, payload.toolCallId, payload.toolName, "requested");
                const index = tools.get(key(event.runId, payload.toolCallId));
                const previous = index === undefined ? undefined : entries[index];
                if (previous !== undefined && index !== undefined)
                    entries[index] = {
                        ...previous,
                        tool: {
                            name: payload.toolName,
                            summary: toolSummary(payload.toolName, payload.arguments),
                            details: JSON.stringify(payload.arguments, null, 2) ?? "",
                        },
                    };
                break;
            }
            case "approval_requested":
                updateTool(event, payload.toolCallId, payload.toolName, "awaiting approval");
                break;
            case "tool_execution_started":
                updateTool(event, payload.toolCallId, payload.toolName, "running");
                break;
            case "tool_execution_finished": {
                updateTool(event, payload.toolCallId, payload.toolName, payload.status, [
                    payload.safeCode,
                    payload.text,
                    ...(payload.evidence === undefined
                        ? []
                        : [
                            `evidence=${payload.evidence.rawComplete ? "complete" : payload.evidence.rawTruncationReason}; bytes=${payload.evidence.capturedBytes}`,
                            ...payload.evidence.attachments.map(({ stream, ref }) => `${stream}: ${ref.attachmentId} sha256=${ref.sha256} bytes=[${ref.start},${ref.end})`),
                        ]),
                ]
                    .filter((text) => text != null)
                    .join("\n") || null);
                break;
            }
            case "tool_execution_denied":
                updateTool(event, payload.toolCallId, payload.toolName, "denied");
                break;
            case "tool_call_cancelled":
                updateTool(event, payload.toolCallId, payload.toolName, "cancelled", payload.reason);
                break;
            case "run_waiting":
                pausedRuns.add(event.runId);
                entries.push({
                    id: event.eventId,
                    kind: "system",
                    text: `waiting: ${payload.reason} (${payload.safeCode})`,
                    status: null,
                });
                break;
            case "run_resumed":
                pausedRuns.delete(event.runId);
                break;
            case "run_completed":
                terminalRuns.add(event.runId);
                break;
            case "run_failed":
                terminalRuns.add(event.runId);
                entries.push({
                    id: event.eventId,
                    kind: "system",
                    text: `run failed: ${payload.safeCode}`,
                    status: "failed",
                });
                break;
            case "run_cancelled":
                terminalRuns.add(event.runId);
                entries.push({
                    id: event.eventId,
                    kind: "system",
                    text: `run cancelled: ${payload.safeCode}`,
                    status: "cancelled",
                });
                break;
            default:
                break;
        }
    }
    for (const index of inputs.values()) {
        const entry = entries[index];
        const runId = inputRuns.get(index);
        if (entry === undefined ||
            runId === undefined ||
            entry.status === "sent" ||
            entry.status === "withdrawn")
            continue;
        if (terminalRuns.has(runId)) {
            entries[index] = { ...entry, status: entry.status === "sending" ? "unknown" : "retained" };
        }
        else if (pausedRuns.has(runId) && entry.status === "sending") {
            entries[index] = { ...entry, status: "unknown" };
        }
    }
    return entries;
}
function toolSummary(name, args) {
    if (typeof args !== "object" || args === null)
        return name;
    const fields = args;
    const target = fields["command"] ?? fields["path"] ?? fields["pattern"] ?? fields["query"] ?? fields["url"];
    return typeof target === "string" ? `${name} ${target.replace(/\s+/gu, " ")}` : name;
}
export const COMPOSER_COMMANDS = [
    { name: "/config", description: "Provider settings", idleOnly: true },
    { name: "/model", description: "Select model and reasoning", idleOnly: true },
    { name: "/session", description: "Current, new or resume session", idleOnly: true },
    { name: "/sessions", description: "List, rename or delete recorded sessions", idleOnly: true },
    { name: "/new", description: "Start a fresh session", idleOnly: true },
    { name: "/init", description: "Draft an AGENTS.md for this project", idleOnly: true },
    { name: "/skill", description: "Run with a workspace skill loaded", idleOnly: true },
    { name: "/skills", description: "List the workspace skill catalog", idleOnly: false },
    { name: "/memory", description: "List, correct or forget saved memory", idleOnly: false },
    { name: "/remember", description: "Save an explicit memory entry", idleOnly: false },
    { name: "/forget", description: "Forget a memory entry by id", idleOnly: false },
    { name: "/mcp", description: "Declare MCP servers", idleOnly: true },
    { name: "/undo", description: "Revert the files this session changed", idleOnly: true },
    { name: "/help", description: "Show commands", idleOnly: false },
    { name: "/cancel", description: "Cancel the current run", idleOnly: false },
    { name: "/key", description: "Correct the waiting connection key", idleOnly: false },
    { name: "/resume", description: "Explicitly resume after key correction", idleOnly: false },
    { name: "/quit", description: "Close the application", idleOnly: false },
];
export function commandEnabled(view, command) {
    if (command.name === "/key" || command.name === "/resume")
        return view.runStatus === "waiting" && view.waitingKind === "configuration";
    return (!command.idleOnly ||
        (view.runStatus !== "active" && view.runStatus !== "waiting" && view.waitingKind === null));
}
export function interpretComposer(view, text, options = { activeRunAcceptsInput: true }, 
/**
 * Images pasted alongside the text.
 *
 * They ride on the task turn rather than forming a turn of their own: the model
 * must read them as part of the request. A slash command is text-only, so an
 * attached image on a command is refused rather than silently dropped.
 */
images) {
    const trimmed = text.trim();
    if (trimmed.length === 0)
        return { kind: "reject", reason: "empty" };
    const [name, ...args] = trimmed.split(/\s+/u);
    const command = COMPOSER_COMMANDS.find((entry) => entry.name === name);
    if (command !== undefined) {
        if (!commandEnabled(view, command)) {
            return { kind: "reject", reason: "run_active" };
        }
        if (args.length > 0 &&
            name !== "/session" &&
            name !== "/skill" &&
            name !== "/remember" &&
            name !== "/forget")
            return { kind: "reject", reason: "invalid_command" };
        switch (name) {
            case "/config":
                return { kind: "open_config" };
            case "/model":
                return { kind: "open_model" };
            case "/sessions":
                return { kind: "open_panel", panel: "sessions" };
            case "/session":
                if (args.length === 0)
                    return { kind: "open_panel", panel: "session" };
                if (args.length === 2 && args[0] === "resume" && isSessionId(args[1] ?? ""))
                    return { kind: "switch_session", sessionId: args[1] ?? null };
                if (args.length !== 1 || args[0] === "resume")
                    return { kind: "reject", reason: "invalid_command" };
                if (args[0] === "new")
                    return { kind: "switch_session", sessionId: null };
                if (!isSessionId(args[0] ?? ""))
                    return { kind: "reject", reason: "invalid_command" };
                return { kind: "switch_session", sessionId: args[0] ?? null };
            case "/new":
                return { kind: "switch_session", sessionId: null };
            case "/init":
                return { kind: "project_init" };
            case "/skills":
                return { kind: "open_panel", panel: "skills" };
            case "/memory":
                return { kind: "open_panel", panel: "memory" };
            case "/remember": {
                let rest = trimmed.slice("/remember".length).trim();
                if (rest.length === 0)
                    return { kind: "reject", reason: "invalid_command" };
                let replaceId;
                if (rest.startsWith("--replace ")) {
                    const match = /^--replace\s+(\S+)\s+([\s\S]+)$/u.exec(rest);
                    if (match === null)
                        return { kind: "reject", reason: "invalid_command" };
                    replaceId = match[1];
                    rest = match[2] ?? "";
                }
                const typeMatch = /^(user|feedback|project|reference)\s+([\s\S]+)$/u.exec(rest);
                const type = (typeMatch?.[1] ?? "feedback");
                const text = typeMatch?.[2]?.trim() ?? rest;
                if (text.length === 0)
                    return { kind: "reject", reason: "invalid_command" };
                return {
                    kind: "remember_memory",
                    type,
                    text,
                    ...(replaceId === undefined ? {} : { replaceId }),
                };
            }
            case "/forget": {
                const id = args[0] ?? "";
                if (args.length !== 1 || id.length === 0) {
                    return { kind: "reject", reason: "invalid_command" };
                }
                return { kind: "forget_memory", id };
            }
            case "/mcp":
                return { kind: "open_panel", panel: "mcp" };
            case "/undo":
                return { kind: "undo_changes" };
            case "/skill": {
                // The id becomes part of the task text so the coordinator can resolve and
                // inject the body at the same safe boundary as any other input.
                const skillId = args[0] ?? "";
                if (args.length !== 1 || !isValidSkillIdForCommand(skillId)) {
                    return { kind: "reject", reason: "invalid_command" };
                }
                return { kind: "start_run", text: `/skill ${skillId}`, skillId };
            }
            case "/help":
                return { kind: "open_panel", panel: "help" };
            case "/cancel":
                return { kind: "cancel_run" };
            case "/key":
                return { kind: "correct_credential" };
            case "/resume":
                return { kind: "resume_run" };
            case "/quit":
                return { kind: "quit" };
        }
    }
    if (/^\/[a-z]+(?:\s|$)/iu.test(trimmed))
        return { kind: "reject", reason: "unknown_command" };
    if (view.runStatus === "active" || view.waitingKind !== null) {
        if (!options.activeRunAcceptsInput)
            return { kind: "reject", reason: "run_active" };
        return { kind: "queue_input", text: trimmed };
    }
    if (view.runStatus === "waiting")
        return { kind: "reject", reason: "run_active" };
    return images === undefined || images.length === 0
        ? { kind: "start_run", text: trimmed }
        : { kind: "start_run", text: trimmed, images };
}
export function panelActionKeepsWait(action) {
    return action === "close" || action === "open";
}
/**
 * Validate a skill id at the command layer.
 *
 * The loader validates again; this exists so a malformed id is rejected as a command
 * error rather than starting a Run that would fail at the tool.
 */
function isValidSkillIdForCommand(value) {
    return /^[a-z0-9]+(-[a-z0-9]+)*$/u.test(value) && value.length <= 64;
}
