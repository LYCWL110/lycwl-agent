import { readContextMeter } from "../domain/context/context-meter.js";
import { emptyTodoList, replaceTodoList } from "../domain/planning/todo.js";
import { resolveAnswer } from "./answer-input.js";
import { deriveView, interpretComposer } from "./view-model.js";
export function createTuiController(deps) {
    let runStatus = "idle";
    let safeCode = null;
    let lastResult = null;
    /**
     * Usage of the last finished Run.
     *
     * Kept separately from the view derivation because it comes from the result, not
     * from the event log: a Run that reported no usage has no figure at all, and the
     * view must not derive one.
     */
    let usage = null;
    /**
     * Prompt tokens the provider counted for the newest response.
     *
     * This is the authoritative half of the context meter: it describes the prompt
     * the provider actually received, cache included.
     */
    let measuredInputTokens = null;
    let draft = "";
    let commandCounter = 0;
    let events = deps.initialEvents ?? [];
    let todo = deriveTodo(emptyTodoList(), events);
    /**
     * The Run promise for the active Run. `coordinator.run` does not resolve while
     * the Run is suspended, so an approval or question reply must await this rather
     * than `settle()`, which only covers ResumeRun continuations.
     */
    let activeRun = null;
    /** Why the last answer was rejected, shown in the question panel. */
    let answerError = null;
    let navigation = null;
    let localPanel = null;
    /** Loaded once per panel open, so the view never performs I/O. */
    let skillCatalog = null;
    let skillCatalogError = null;
    let mcpServers = null;
    let mcpError = null;
    let mcpBusy = false;
    let sessionList = null;
    let sessionListError = null;
    let sessionListBusy = false;
    let undoBusy = false;
    let initPreview = null;
    let initBusy = false;
    let commandNotice = null;
    let checkingSession = false;
    let closing = null;
    function rememberEvents(incoming) {
        const known = new Set(events.map((event) => event.eventId));
        events = [...events, ...incoming.filter((event) => !known.has(event.eventId))];
        return events;
    }
    function applyResult(result) {
        lastResult = result;
        runStatus = result.status;
        safeCode = result.safeCode;
        usage = result.usage ?? null;
        for (let index = result.events.length - 1; index >= 0; index -= 1) {
            const payload = result.events[index]?.payload;
            if (payload?.kind === "model_response_validated" && payload.usage !== undefined) {
                measuredInputTokens = payload.usage.inputTokens;
                break;
            }
        }
        rememberEvents(result.events);
        todo = deriveTodo(todo, result.events);
    }
    /**
     * Await the suspended Run after a reply. `settle()` returns null for approval
     * and question replies because it only resolves ResumeRun continuations, so
     * relying on it left the view stuck showing the wait after the user acted.
     */
    async function settleActiveRun() {
        const run = activeRun;
        if (run === null)
            return;
        const result = await run;
        if (activeRun === run)
            activeRun = null;
        applyResult(result);
    }
    /**
     * Load the Skill catalog for the panel.
     *
     * A failure is kept as a reason rather than rendered as an empty catalog: an empty
     * list would claim the workspace has no skills, which is a different fact.
     */
    async function loadSkillCatalog() {
        const loader = deps.skillCatalog;
        if (loader === undefined) {
            skillCatalog = null;
            skillCatalogError = "skills are disabled";
            return;
        }
        try {
            const loaded = await loader();
            if (loaded.ok) {
                skillCatalog = loaded.skills;
                skillCatalogError = null;
                return;
            }
            skillCatalog = null;
            skillCatalogError = loaded.code;
        }
        catch {
            skillCatalog = null;
            skillCatalogError = "catalog_unavailable";
        }
    }
    /** Read the recorded sessions. A failure is a reason, not an empty catalog. */
    async function loadSessionList() {
        const loader = deps.sessionCatalog;
        if (loader === undefined) {
            sessionList = null;
            sessionListError = "session records are not readable in this build";
            return;
        }
        try {
            const loaded = await loader.list();
            if (loaded.ok) {
                // The current session is marked here rather than by the store: only this
                // process knows which id it owns.
                sessionList = loaded.sessions.map((entry) => ({
                    ...entry,
                    current: entry.sessionId === deps.sessionId,
                }));
                sessionListError = null;
                return;
            }
            sessionList = null;
            sessionListError = loaded.code;
        }
        catch {
            sessionList = null;
            sessionListError = "session records could not be read";
        }
    }
    /**
     * Apply a session edit and re-read the list from disk.
     *
     * Re-reading rather than patching locally is what makes the panel show what the
     * directory actually contains after a rename or a delete.
     */
    async function changeSession(apply, successNotice) {
        if (sessionListBusy)
            return;
        sessionListBusy = true;
        commandNotice = null;
        try {
            const result = await apply();
            if (!result.ok) {
                sessionListError = result.code;
                return;
            }
            commandNotice = successNotice;
            await loadSessionList();
        }
        catch {
            sessionListError = "the change could not be saved";
        }
        finally {
            sessionListBusy = false;
        }
    }
    /** Read the declared MCP servers. A failure is kept as a reason, not an empty list. */
    async function loadMcpServers() {
        const loader = deps.mcpServers;
        if (loader === undefined) {
            mcpServers = null;
            mcpError = "configuration is not readable in this build";
            return;
        }
        try {
            const loaded = await loader();
            if (loaded.ok) {
                mcpServers = loaded.servers;
                mcpError = null;
                return;
            }
            mcpServers = null;
            mcpError = loaded.code;
        }
        catch {
            mcpServers = null;
            mcpError = "configuration could not be read";
        }
    }
    /**
     * Apply an MCP edit. The list is re-read from the result rather than patched
     * locally, so the panel shows what the document actually contains.
     */
    async function changeMcp(change) {
        if (mcpBusy)
            return;
        const apply = deps.mcpChange;
        if (apply === undefined) {
            mcpError = "configuration is not writable in this build";
            return;
        }
        mcpBusy = true;
        commandNotice = null;
        try {
            const result = await apply(change);
            if (result.ok) {
                mcpServers = result.servers;
                mcpError = null;
                commandNotice = change.remove === undefined ? "server added" : "server removed";
            }
            else {
                mcpError = result.code;
            }
        }
        catch {
            mcpError = "configuration could not be saved";
        }
        finally {
            mcpBusy = false;
        }
    }
    function view() {
        const live = deps.coordinator.currentRunProjection();
        const derived = deriveView({
            runStatus: live?.status ?? runStatus,
            safeCode,
            events: live === null ? events : rememberEvents(live.events),
            todo: todo.items.length === 0 ? null : todo,
            pendingApproval: deps.coordinator.pendingApprovalView(),
            pendingDisclosure: deps.coordinator.pendingDisclosureView(),
            pendingQuestion: deps.coordinator.pendingQuestionView(),
            answerError,
            draft,
        });
        return {
            ...derived,
            meter: meterFor(derived.transcript),
            usage,
            initPreview,
            localPanel,
            skillCatalog,
            skillCatalogError,
            mcpServers,
            mcpError,
            mcpBusy,
            sessionList,
            sessionListError,
            sessionListBusy,
            commandNotice,
        };
    }
    /**
     * Context occupancy for the footer.
     *
     * The transcript is the projection the user sees, which is not exactly the prompt:
     * it omits system instructions and tool schemas. Those are counted as fixed
     * overhead so the percentage is not optimistic. The measured provider count, when
     * present, is preferred because it is the real prompt size.
     */
    function meterFor(transcript) {
        const items = transcript
            .filter((entry) => entry.kind === "user" || entry.kind === "assistant" || entry.kind === "tool")
            .map((entry) => entry.kind === "tool"
            ? { kind: "tool_result", text: entry.text }
            : entry.kind === "user"
                ? { kind: "user", text: entry.text }
                : { kind: "assistant", text: entry.text, toolCalls: [] });
        const meter = readContextMeter({
            conversation: items,
            measuredInputTokens,
            window: deps.contextWindow ?? null,
            compactionTrigger: null,
            fixedTokens: 0,
        });
        return {
            used: meter.used,
            window: meter.window,
            fraction: meter.fraction,
            source: meter.source,
            atCompaction: meter.atCompaction,
        };
    }
    async function submit(text, images) {
        if (closing !== null || navigation !== null || checkingSession)
            return;
        const intent = interpretComposer(view(), text, undefined, images);
        draft = "";
        commandNotice = null;
        if (intent.kind === "reject") {
            if (intent.reason !== "empty")
                commandNotice = {
                    run_active: "Finish or cancel the current run first.",
                    unknown_command: "Unknown command. Use /help.",
                    invalid_command: "Invalid command. Use /help.",
                }[intent.reason];
            return;
        }
        if (intent.kind === "withdraw")
            return;
        if (intent.kind === "correct_credential") {
            if (deps.correctCredential === undefined)
                commandNotice = "Credential correction unavailable in this build.";
            else
                localPanel = "credential";
            return;
        }
        if (intent.kind === "resume_run") {
            const waiting = deps.coordinator.configurationWaitView();
            if (waiting === null)
                return;
            const resumed = await deps.coordinator.resumeRun({
                ...waiting,
                commandId: `tui-resume-${++commandCounter}`,
            });
            if (!resumed.ok) {
                commandNotice = `Run not resumed: ${resumed.code}`;
                return;
            }
            const continuation = await deps.coordinator.settle();
            if (continuation !== null)
                applyResult(continuation);
            return;
        }
        if (intent.kind === "queue_input") {
            let queued;
            try {
                queued = await deps.coordinator.queueInput(intent.text);
            }
            catch {
                draft = text;
                commandNotice = "Input not queued: storage unavailable";
                return false;
            }
            if (!queued.ok) {
                draft = text;
                commandNotice = `Input not queued: ${queued.code}`;
                return false;
            }
            return true;
        }
        if (intent.kind === "open_config" || intent.kind === "open_model") {
            navigation = { kind: "config", page: intent.kind === "open_model" ? "model" : "setup" };
            return;
        }
        if (intent.kind === "open_panel") {
            localPanel = intent.panel;
            if (intent.panel === "skills")
                await loadSkillCatalog();
            if (intent.panel === "mcp")
                await loadMcpServers();
            if (intent.panel === "sessions")
                await loadSessionList();
            return;
        }
        if (intent.kind === "switch_session") {
            checkingSession = true;
            try {
                if (intent.sessionId !== null && !(await deps.canResumeSession?.(intent.sessionId))) {
                    commandNotice = "Session unavailable. Enter an existing session ID.";
                    return;
                }
                navigation = { kind: "session", sessionId: intent.sessionId };
            }
            catch {
                commandNotice = "Session records could not be checked.";
            }
            finally {
                checkingSession = false;
            }
            return;
        }
        if (intent.kind === "cancel_run") {
            localPanel = null;
            await cancelRun();
            return;
        }
        if (intent.kind === "rename_session") {
            await changeSession(async () => (await deps.sessionCatalog?.rename(intent.sessionId, intent.title)) ?? {
                ok: false,
                code: "unavailable",
            }, intent.title === null ? "title cleared" : "session renamed");
            return;
        }
        if (intent.kind === "delete_session") {
            await changeSession(async () => (await deps.sessionCatalog?.remove(intent.sessionId)) ?? {
                ok: false,
                code: "unavailable",
            }, "session deleted");
            return;
        }
        if (intent.kind === "undo_changes") {
            const undo = deps.undoChanges;
            if (undo === undefined) {
                commandNotice = "Undo is unavailable in this build.";
                return;
            }
            undoBusy = true;
            commandNotice = null;
            try {
                const outcome = await undo();
                commandNotice = outcome.ok
                    ? `reverted ${outcome.files} file(s)`
                    : `undo failed: ${outcome.code}`;
            }
            catch {
                commandNotice = "undo failed";
            }
            finally {
                undoBusy = false;
            }
            return;
        }
        if (intent.kind === "quit") {
            navigation = { kind: "quit" };
            return;
        }
        if (intent.kind === "project_init") {
            // Scan first and show the draft. Writing without a preview was the one file
            // mutation that bypassed approval; the panel is where that is corrected.
            const scan = deps.initDraft;
            if (scan === undefined) {
                commandNotice = "AGENTS.md drafting is unavailable in this build.";
                return;
            }
            try {
                const drafted = await scan();
                if (!drafted.ok) {
                    commandNotice = `init failed: ${drafted.code}`;
                    return;
                }
                if (drafted.alreadyExists) {
                    commandNotice = "AGENTS.md already exists; not overwriting.";
                    return;
                }
                initPreview = drafted.preview;
                localPanel = "init";
            }
            catch {
                commandNotice = "init failed: scan unavailable";
            }
            return;
        }
        localPanel = null;
        runStatus = "active";
        safeCode = null;
        // Pasted images already carry their bytes, so there is nothing to read here.
        const attached = intent.images;
        const run = intent.skillId === undefined && attached === undefined
            ? deps.coordinator.run(intent.text)
            : deps.coordinator.run(intent.text, {
                ...(intent.skillId === undefined ? {} : { skillId: intent.skillId }),
                ...(attached === undefined ? {} : { images: attached }),
            });
        activeRun = run;
        const result = await run;
        // Only clear when this is still the active Run: a later Run may have started.
        if (activeRun === run)
            activeRun = null;
        applyResult(result);
    }
    async function reply(decision) {
        const disclosure = deps.coordinator.pendingDisclosureView();
        if (disclosure !== null) {
            commandCounter++;
            await deps.coordinator.replySensitiveDisclosure({
                ...disclosure,
                commandId: `tui-disclosure-${commandCounter}`,
                decision,
            });
            await settleActiveRun();
            return;
        }
        const pending = deps.coordinator.pendingApprovalView();
        if (pending === null)
            return;
        commandCounter += 1;
        await deps.coordinator.replyApproval({
            commandId: `tui-approval-${commandCounter}`,
            approvalId: pending.approvalId,
            toolCallId: pending.toolCallId,
            requestVersion: pending.requestVersion,
            decision,
        });
        await settleActiveRun();
    }
    async function answer(text) {
        const pending = deps.coordinator.pendingQuestionView();
        if (pending === null)
            return;
        draft = "";
        commandCounter += 1;
        // Accept an option id or the label the panel showed. A rejected answer keeps
        // the question open and reports why, instead of failing silently.
        const resolved = resolveAnswer({
            answerType: pending.answerType,
            multiple: pending.multiple,
            allowFreeText: pending.allowFreeText,
            options: pending.options,
        }, text);
        if (!resolved.ok) {
            answerError = resolved.detail;
            return;
        }
        answerError = null;
        const answerPayload = resolved.answer;
        await deps.coordinator.submitUserInput({
            commandId: `tui-question-${commandCounter}`,
            questionId: pending.questionId,
            toolCallId: pending.toolCallId,
            requestVersion: pending.requestVersion,
            answer: answerPayload,
        });
        await settleActiveRun();
    }
    async function declineQuestion() {
        const pending = deps.coordinator.pendingQuestionView();
        if (pending === null)
            return;
        commandCounter += 1;
        await deps.coordinator.declineQuestion({
            commandId: `tui-decline-${commandCounter}`,
            questionId: pending.questionId,
            toolCallId: pending.toolCallId,
            requestVersion: pending.requestVersion,
        });
        await settleActiveRun();
    }
    async function cancelRun() {
        const status = view().runStatus;
        if (status !== "active" && status !== "waiting")
            return;
        commandCounter += 1;
        await deps.coordinator.cancelRun(`tui-cancel-${commandCounter}`);
        await settleActiveRun();
        const live = deps.coordinator.currentRunProjection();
        if (live === null && activeRun === null) {
            const finished = deps.coordinator.lastRunResult();
            if (finished !== null)
                applyResult(finished);
        }
    }
    function close() {
        if (closing === null) {
            commandCounter += 1;
            closing = (async () => {
                try {
                    await deps.coordinator.closeSession(`tui-close-${commandCounter}`);
                }
                finally {
                    await settleActiveRun();
                }
            })();
        }
        return closing;
    }
    return {
        view,
        submit,
        approve: () => reply("approved"),
        deny: () => reply("denied"),
        answer,
        declineQuestion,
        cancelRun,
        close,
        lastResult: () => lastResult,
        correctCredential: async (secret) => {
            if (deps.coordinator.configurationWaitView() === null || closing !== null)
                return false;
            const saved = (await deps.correctCredential?.(secret)) ?? false;
            if (saved) {
                localPanel = null;
                commandNotice = "Key saved. Run remains waiting; use /resume.";
            }
            return saved;
        },
        closePanel: () => {
            localPanel = null;
            initPreview = null;
            commandNotice = null;
        },
        confirmInit: async () => {
            if (initBusy)
                return;
            const write = deps.initWrite;
            if (write === undefined) {
                commandNotice = "AGENTS.md writing is unavailable in this build.";
                return;
            }
            initBusy = true;
            try {
                const written = await write();
                if (written.ok) {
                    localPanel = null;
                    initPreview = null;
                    commandNotice = "AGENTS.md created; review and edit it.";
                }
                else {
                    commandNotice = `init failed: ${written.code}`;
                }
            }
            catch {
                commandNotice = "init failed: write unavailable";
            }
            finally {
                initBusy = false;
            }
        },
        addMcpServer: (entry) => changeMcp({ add: entry }),
        removeMcpServer: (serverId) => changeMcp({ remove: serverId }),
        renameSession: (sessionId, title) => changeSession(async () => (await deps.sessionCatalog?.rename(sessionId, title)) ?? {
            ok: false,
            code: "unavailable",
        }, title === null ? "title cleared" : "session renamed"),
        deleteSession: (sessionId) => changeSession(async () => (await deps.sessionCatalog?.remove(sessionId)) ?? {
            ok: false,
            code: "unavailable",
        }, "session deleted"),
        takeNavigationRequest: () => {
            const requested = navigation;
            navigation = null;
            return requested;
        },
    };
}
/**
 * Todo state is restored from the authoritative todo_replaced events rather than
 * trusting the model's message history.
 */
function deriveTodo(previous, events) {
    let current = previous;
    for (const event of events) {
        if (event.payload.kind !== "todo_replaced")
            continue;
        const replaced = replaceTodoList(current, event.payload.items);
        if (replaced.ok)
            current = replaced.value;
    }
    return current;
}
