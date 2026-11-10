import { realpath, stat } from "node:fs/promises";
import { tavilySearch, toWebSearchRun } from "../adapters/network/tavily-adapter.js";
import { createBackgroundTools } from "../adapters/tools/background-tools.js";
import { createLspTools } from "../adapters/tools/lsp-tools.js";
import { createMutationTools } from "../adapters/tools/mutation-tools.js";
import { createApplyPatchTool } from "../adapters/tools/patch-tool.js";
import { createReadFileTool } from "../adapters/tools/read-file-tool.js";
import { createSearchTools } from "../adapters/tools/search-tools.js";
import { createShellTool } from "../adapters/tools/shell-tool.js";
import { createSkillTool } from "../adapters/tools/skill-tool.js";
import { createTodoTool } from "../adapters/tools/todo-tool.js";
import { createWebTools } from "../adapters/tools/web-tools.js";
import { createWriteTools } from "../adapters/tools/write-tools.js";
import { createBackgroundRegistry } from "../adapters/windows/background-registry.js";
import { resolveWebFetchHost } from "../adapters/windows/dns-resolver.js";
import { createLspRegistry } from "../adapters/windows/lsp-registry.js";
import { pinnedFetch } from "../adapters/windows/pinned-https-client.js";
import { powershellCommand, powershellExecutable } from "../adapters/windows/powershell-command.js";
import { createProcessSupervisor } from "../adapters/windows/process-supervisor.js";
import { createSearchLedger, makeReservationId } from "../adapters/windows/search-ledger.js";
import { createSearchScope } from "../adapters/windows/search-scope.js";
import { createSkillLoader } from "../adapters/windows/skill-loader.js";
import { createWindowsFileReader } from "../adapters/windows/windows-directory-reader.js";
import { createWindowsFsAdapter } from "../adapters/windows/windows-fs-adapter.js";
import { createWindowsMutationAdapter } from "../adapters/windows/windows-mutation-adapter.js";
import { createWindowsWriteAdapter } from "../adapters/windows/windows-write-adapter.js";
import { emptyTodoList } from "../domain/planning/todo.js";
import { resolveWorkspacePath } from "../services/permission/workspace-path.js";
/**
 * Composition root for the delivered filesystem slices.
 *
 * Read-only tools (Stage 2A) and write tools (Stage 2B) are wired to real disk.
 * Optional process, LSP and network delegates follow their explicit build flags.
 * Unavailable tool names fail closed with `tool_unavailable_in_build`.
 */
export const UNAVAILABLE_CODE = "tool_unavailable_in_build";
/** Harness-managed User-Agent; the model never supplies it. */
const HARNESS_USER_AGENT = "lycwl-agent/0.1";
export function createReadOnlyWorkspaceTools(options) {
    return createWorkspaceTools({ ...options, enableWrites: false, enableProcesses: false });
}
export function createWorkspaceTools(options) {
    const { workspaceRoot, approvals, ids } = options;
    const enableWrites = options.enableWrites !== false;
    const enableProcesses = options.enableProcesses === true;
    const enableLsp = options.enableLsp === true;
    const enableWeb = options.enableWeb === true;
    const searchLedger = createSearchLedger(options.searchLedgerDirectory === undefined ? {} : { directory: options.searchLedgerDirectory });
    const ledgerSessionId = options.sessionId ?? "local-session";
    const ledgerRunId = options.runId ?? "local-run";
    const lspRegistry = createLspRegistry({
        inheritedEnvironment: { ...process.env },
    });
    const fsAdapter = createWindowsFsAdapter({ workspaceRoot });
    const reader = createWindowsFileReader({ workspaceRoot });
    const writer = createWindowsWriteAdapter({ workspaceRoot });
    const mutator = createWindowsMutationAdapter({ workspaceRoot });
    const readFile = createReadFileTool({
        workspaceRoot,
        approvals,
        ids,
        inspectTarget: async (requestedPath) => {
            const inspected = await fsAdapter.inspect(requestedPath);
            if (!inspected.ok)
                throw new Error(inspected.code);
            return { snapshot: inspected.snapshot, target: { ...inspected.target, requestedPath } };
        },
        readBytes: async (requestedPath) => {
            const read = await reader.readFile(requestedPath);
            if (!read.ok)
                throw new Error(read.code);
            return read.bytes;
        },
    });
    const scope = createSearchScope(workspaceRoot, reader, fsAdapter);
    const search = createSearchTools({
        begin: scope.begin,
        scopeFacts: scope.facts,
        listEntries: scope.listEntries,
        readText: scope.readText,
    });
    const writes = enableWrites
        ? createWriteTools({
            approvals,
            inspectTarget: async (requestedPath) => {
                try {
                    return await writer.inspectTarget(requestedPath);
                }
                catch (error) {
                    throw new Error(error instanceof Error ? error.message : "invalid_path");
                }
            },
            readBytes: async (requestedPath) => writer.readBytes(requestedPath),
            writeBytes: async (requestedPath, bytes, expected) => {
                const result = await writer.writeBytes(requestedPath, bytes, expected);
                if (!result.ok)
                    throw new Error(result.code);
            },
        })
        : null;
    const patch = enableWrites
        ? createApplyPatchTool({
            inspectTargets: async (paths) => {
                const snapshots = [];
                for (const candidate of paths) {
                    snapshots.push(await writer.inspectPatchTarget(candidate));
                }
                return snapshots;
            },
            writeBytes: async (requestedPath, bytes, expected) => {
                const result = await writer.writeBytes(requestedPath, bytes, expected);
                if (!result.ok)
                    throw new Error(result.code);
            },
        })
        : null;
    const mutations = enableWrites
        ? createMutationTools({
            inspectDeleteTargets: async (paths) => mutator.inspectDeleteTargets(paths),
            inspectRename: async (from, to) => mutator.inspectRename(from, to),
            deletePath: async (target) => mutator.deletePath(target),
            renamePath: async (from, to) => mutator.renamePath(from, to),
        })
        : null;
    const processes = enableProcesses
        ? createShellTool({
            sessionMode: enableWrites ? "workspace_write" : "read_only",
            inheritedEnvironment: { ...process.env },
            runShell: async (request, environment, signal, toolCallId) => {
                await options.refreshOwnedKeys?.();
                const supervisor = createProcessSupervisor(options.ownedKeys === undefined ? {} : { ownedKeys: options.ownedKeys });
                const outcome = await supervisor.runToCompletion({
                    command: request.command,
                    cwd: request.cwd,
                    timeoutMs: request.timeoutMs,
                    environment,
                    ...(signal === undefined ? {} : { signal }),
                });
                if (outcome.kind === "failed") {
                    return { kind: "unknown", safeCode: outcome.code };
                }
                let evidence;
                let deliveryBlocked = outcome.deliveryBlocked;
                if (options.evidenceStore !== undefined) {
                    evidence = {
                        captureId: null,
                        manifestSha256: null,
                        capturedBytes: 0,
                        rawComplete: false,
                        rawTruncationReason: deliveryBlocked !== null
                            ? "blocked"
                            : outcome.outputLimitExceeded
                                ? "raw_limit"
                                : "capture_interrupted",
                        attachments: [],
                    };
                    if (deliveryBlocked === null &&
                        outcome.rawOutput !== undefined &&
                        toolCallId !== undefined) {
                        const stored = await options.evidenceStore.publishProcessOutput({
                            toolCallId,
                            ...outcome.rawOutput,
                        });
                        if (stored.ok)
                            evidence = stored.evidence;
                        else if (stored.code === "protected_delivery_blocked") {
                            deliveryBlocked = stored.reason;
                            evidence = { ...evidence, rawTruncationReason: "blocked" };
                        }
                        else
                            evidence = { ...evidence, rawTruncationReason: "storage_failed" };
                    }
                }
                const captured = evidence === undefined ? {} : { evidence };
                if (outcome.cancelled)
                    return {
                        kind: "unknown",
                        safeCode: "shell_cancelled_outcome_unknown",
                        deliveryBlocked,
                        ...captured,
                    };
                return outcome.timedOut
                    ? {
                        kind: "timed_out",
                        stdout: outcome.stdout,
                        stderr: outcome.stderr,
                        rawBytes: outcome.rawBytes,
                        captureComplete: outcome.captureComplete,
                        deliveryBlocked,
                        ...captured,
                    }
                    : {
                        kind: "completed",
                        exitCode: outcome.exitCode,
                        stdout: outcome.stdout,
                        stderr: outcome.stderr,
                        rawBytes: outcome.rawBytes,
                        captureComplete: outcome.captureComplete,
                        deliveryBlocked,
                        ...captured,
                    };
            },
        })
        : null;
    const backgroundObservers = new Set();
    const backgroundRegistry = enableProcesses
        ? createBackgroundRegistry({
            sessionMode: enableWrites ? "workspace_write" : "read_only",
            inheritedEnvironment: { ...process.env },
            ...(options.evidenceStore === undefined ? {} : { createId: () => ids.create() }),
            observe: async (fact) => {
                for (const observer of backgroundObservers)
                    await observer(fact);
            },
            ...(options.evidenceStore === undefined ? {} : { evidenceStore: options.evidenceStore }),
            ...(options.ownedKeys === undefined ? {} : { ownedKeys: options.ownedKeys }),
            ...(options.refreshOwnedKeys === undefined
                ? {}
                : { refreshOwnedKeys: options.refreshOwnedKeys }),
        })
        : null;
    const background = backgroundRegistry === null ? null : createBackgroundTools(backgroundRegistry.dependencies);
    const delegates = [readFile, search];
    // Todo is a planning tool with no side effects. Its list is held by the caller so
    // a restart restores it from events rather than trusting the model.
    const todoTool = createTodoTool({
        getList: () => emptyTodoList(),
        setList: () => undefined,
    });
    delegates.push(todoTool);
    if (options.enableSkills === true) {
        const loader = createSkillLoader({ workspaceRoot });
        delegates.push(createSkillTool({
            load: async ({ skillId }) => {
                const loaded = await loader.load({ skillId });
                return loaded.ok
                    ? { ok: true, block: loaded.block, skillId: loaded.skillId }
                    : {
                        ok: false,
                        code: loaded.code,
                        ...(loaded.detail === undefined ? {} : { detail: loaded.detail }),
                    };
            },
        }));
    }
    if (writes !== null)
        delegates.push(writes);
    if (patch !== null)
        delegates.push(patch);
    if (mutations !== null)
        delegates.push(mutations);
    if (processes !== null)
        delegates.push(processes);
    if (background !== null)
        delegates.push(background);
    if (enableLsp === true) {
        delegates.push(createLspTools(lspRegistry.dependencies));
    }
    if (enableWeb === true) {
        delegates.push(createWebTools({
            surchargeRulesReviewed: false,
            resolveAddresses: async (host) => {
                const resolved = await resolveWebFetchHost(host);
                if (!resolved.ok)
                    throw new Error(resolved.code);
                return resolved.addresses;
            },
            runSearch: async (request, toolCallId) => {
                if (options.resolveSearchApiKey === undefined) {
                    // No credential boundary was composed, so there is nothing to
                    // authenticate with. This is a definite non-send, not a charge.
                    return { kind: "unknown", safeCode: "search_backend_not_configured" };
                }
                // Resolve the credential BEFORE reserving quota: a missing key means
                // nothing can be sent, so it must not consume a reservation. The value
                // is resolved once per call, at the point of use, so a rotation is
                // honoured by the next call rather than frozen at composition time.
                let apiKey;
                try {
                    apiKey = await options.resolveSearchApiKey();
                }
                catch {
                    apiKey = null;
                }
                if (apiKey === null || apiKey.length === 0) {
                    return { kind: "unknown", safeCode: "search_backend_not_configured" };
                }
                // C07: a durable reservation must exist before the request is sent.
                const reservationId = makeReservationId({
                    sessionId: ledgerSessionId,
                    runId: ledgerRunId,
                    toolCallId,
                    query: request.query,
                });
                const recordedAtUtc = new Date().toISOString();
                const reserved = await searchLedger.reserve({
                    reservationId,
                    utcMonth: recordedAtUtc.slice(0, 7),
                    runId: ledgerRunId,
                    sessionId: ledgerSessionId,
                    recordedAtUtc,
                });
                if (!reserved.ok) {
                    return { kind: "unknown", safeCode: `search_${reserved.code}` };
                }
                const sent = await searchLedger.record({
                    ...reserved.value,
                    kind: "possibly_sent",
                });
                if (!sent.ok) {
                    return { kind: "unknown", safeCode: "search_ledger_write_failed" };
                }
                const result = await tavilySearch({
                    query: request.query,
                    count: request.count,
                }, apiKey);
                await searchLedger.record({
                    ...reserved.value,
                    kind: result.ok ? "reported" : "uncertain",
                    chargeUsd: result.ok ? 0 : null,
                });
                return toWebSearchRun(result);
            },
            runFetch: async (request, approvedAddresses) => {
                const fetched = await pinnedFetch({
                    url: request.url,
                    host: request.host,
                    scheme: request.scheme,
                    headers: request.headers,
                    approvedAddresses,
                    userAgent: HARNESS_USER_AGENT,
                });
                if (!fetched.ok)
                    return { kind: "unknown", safeCode: fetched.code };
                if (fetched.location !== null) {
                    return {
                        kind: "response",
                        status: fetched.status,
                        location: fetched.location,
                        bodyText: "",
                        rawBytes: fetched.wireBytes,
                    };
                }
                return {
                    kind: "response",
                    status: fetched.status,
                    location: null,
                    bodyText: fetched.bodyText,
                    rawBytes: fetched.wireBytes,
                };
            },
        }));
    }
    if (options.mcp !== undefined)
        delegates.push(options.mcp);
    if (options.discover !== undefined)
        delegates.push(options.discover);
    function resolveDelegate(toolName) {
        for (const delegate of delegates) {
            if (delegate.getDefinition(toolName) !== null)
                return delegate;
        }
        return null;
    }
    const processSnapshots = new Map();
    const isStart = (request) => request.toolName === "shell" || request.toolName === "background_start";
    async function normalize(request) {
        if (!isStart(request))
            return request;
        const args = request.arguments;
        if (args === null || typeof args !== "object" || typeof args["cwd"] !== "string")
            throw new Error("invalid_arguments");
        const supplied = resolveWorkspacePath(workspaceRoot, args["cwd"]);
        if (!supplied.ok)
            throw new Error("invalid_path");
        const resolved = await realpath(supplied.value.absolutePath);
        const info = await stat(resolved);
        if (!info.isDirectory())
            throw new Error("invalid_cwd");
        return { ...request, arguments: { ...args, cwd: resolved } };
    }
    async function processIdentity(request) {
        const normalized = await normalize(request);
        const cwd = normalized.arguments.cwd;
        const info = await stat(cwd, { bigint: true });
        return JSON.stringify([
            normalized.arguments,
            `${info.dev}:${info.ino}`,
            powershellExecutable(),
        ]);
    }
    return {
        getDefinition(toolName) {
            for (const delegate of delegates) {
                const definition = delegate.getDefinition(toolName);
                if (definition !== null)
                    return definition;
            }
            return null;
        },
        async preview(request) {
            const normalized = await normalize(request);
            if (isStart(request)) {
                processSnapshots.set(request.toolCallId, await processIdentity(request));
            }
            const delegate = resolveDelegate(request.toolName);
            const preview = delegate?.preview === undefined ? null : await delegate.preview(normalized);
            const command = normalized.arguments?.command;
            return isStart(request) && typeof command === "string"
                ? `${preview}\nexecutable=${powershellExecutable()}\ncommandLine=${powershellCommand(command)}\noutputEncoding=utf-8\ncapture=guarded memory pipes; stdout+stderr limit=8388608 bytes`
                : preview;
        },
        async requiresApproval(request) {
            return (await resolveDelegate(request.toolName)?.requiresApproval?.(request)) ?? false;
        },
        async revalidateApproval(request) {
            if (isStart(request))
                return processSnapshots.get(request.toolCallId) === (await processIdentity(request));
            return (await resolveDelegate(request.toolName)?.revalidateApproval?.(request)) ?? true;
        },
        discardApproval(id) {
            processSnapshots.delete(id);
            for (const delegate of delegates)
                delegate.discardApproval?.(id);
        },
        observeBackground(observer) {
            backgroundObservers.add(observer);
            return () => {
                backgroundObservers.delete(observer);
            };
        },
        async flushBackground() {
            await backgroundRegistry?.flush();
        },
        async cancelAll() {
            const results = await Promise.allSettled([
                Promise.resolve().then(async () => {
                    backgroundRegistry?.disposeAll();
                    await backgroundRegistry?.flush();
                }),
                lspRegistry.close(),
                Promise.resolve().then(async () => {
                    await options.mcp?.cancelAll?.();
                }),
            ]);
            if (results.some((result) => result.status === "rejected")) {
                throw new Error("session_cleanup_failed");
            }
        },
        async execute(request) {
            const delegate = resolveDelegate(request.toolName);
            if (delegate === null) {
                return { status: "failed", safeCode: UNAVAILABLE_CODE, text: null };
            }
            try {
                const normalized = await normalize(request);
                if (request.signal?.aborted)
                    return { status: "failed", safeCode: "tool_cancelled", text: null };
                if (isStart(request) &&
                    request.approvalGranted &&
                    processSnapshots.get(request.toolCallId) !== (await processIdentity(request)))
                    return { status: "failed", safeCode: "process_precondition_changed", text: null };
                const result = await delegate.execute(normalized);
                processSnapshots.delete(request.toolCallId);
                return result;
            }
            catch (error) {
                const safeCode = error instanceof Error ? error.message : "read_failed";
                return { status: "failed", safeCode, text: null };
            }
        },
    };
}
