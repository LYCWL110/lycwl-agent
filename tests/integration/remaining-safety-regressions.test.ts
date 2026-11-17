import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp } from "node:fs/promises";
import { createServer } from "node:https";
import path from "node:path";
import { describe, it } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import type { ReactElement } from "react";
import { createBackgroundRegistry } from "../../src/adapters/platform-background.ts";
import { createProcessSupervisor } from "../../src/adapters/platform-process.ts";
import { AnthropicProvider } from "../../src/adapters/providers/anthropic-provider.ts";
import { OpenAiChatProvider } from "../../src/adapters/providers/openai-chat-provider.ts";
import { OpenAiResponsesProvider } from "../../src/adapters/providers/openai-responses-provider.ts";
import { providerHttpsPost } from "../../src/adapters/providers/provider-http.ts";
import { createShellTool } from "../../src/adapters/tools/shell-tool.ts";
import { createWebTools } from "../../src/adapters/tools/web-tools.ts";
import { MAX_CAPTURE_BYTES } from "../../src/adapters/windows/bounded-process-output.ts";
import {
  rebuildConversation,
  retainRecentGroups,
} from "../../src/application/coordinator/conversation-rebuild.ts";
import { completeWithBoundedRetries } from "../../src/application/coordinator/model-attempts.ts";
import { RuntimeCoordinator } from "../../src/application/coordinator/runtime-coordinator.ts";
import { createWorkspaceTools } from "../../src/bootstrap/read-only-tools.ts";
import { readProviderConfig } from "../../src/domain/config/provider-config.ts";
import { initialCursor, readBackgroundPage } from "../../src/domain/process/background.ts";
import { InMemoryEventLog, type InternalEventPayload } from "../../src/ports/event-log.ts";
import type { ProviderCompletion } from "../../src/ports/model-provider.ts";
import { createTuiController } from "../../src/tui/controller.ts";
import { startTui } from "../../src/tui/main.ts";
import { JsonDigest, RecordingTools, SequenceIds } from "../fakes/deterministic-services.ts";
import { shellCommands } from "../fakes/shell-commands.ts";
import { TEST_CERT_PEM, TEST_KEY_PEM } from "../fakes/web-cert.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function coordinator(
  complete: ConstructorParameters<typeof RuntimeCoordinator>[0]["provider"]["complete"],
  cancelAll?: () => Promise<void>,
) {
  const ids = new SequenceIds("remaining");
  const log = new InMemoryEventLog(ids, new JsonDigest());
  const recording = new RecordingTools(false, { status: "succeeded", text: null });
  return new RuntimeCoordinator({
    provider: { complete },
    tools: {
      getDefinition: (name) => recording.getDefinition(name),
      execute: (request) => recording.execute(request),
      ...(cancelAll === undefined ? {} : { cancelAll }),
    },
    approvals: { decide: async () => "denied" },
    ids,
    eventLog: log,
    nowUtc: () => "2026-11-07T00:00:00.000Z",
  });
}

describe("remaining model cancellation and Session cleanup regressions", () => {
  it("cancels a pending model call and ignores its late retryable failure", async () => {
    const entered = deferred<void>();
    const reply = deferred<ProviderCompletion>();
    let count = 0;
    let signal: AbortSignal | undefined;
    const runtime = coordinator(async (request) => {
      count += 1;
      signal = request.signal;
      entered.resolve();
      return reply.promise;
    });
    const run = runtime.run("wait");
    await entered.promise;
    await runtime.cancelRun("cancel");
    const result = await run;
    assert.equal(result.status, "cancelled");
    assert.equal(signal?.aborted, true);
    reply.resolve({ kind: "transient_failure", safeCode: "temporary" });
    await delay(10);
    assert.equal(count, 1);
  });

  it("does not send after cancellation during preflight", async () => {
    const abort = new AbortController();
    let sends = 0;
    const result = await completeWithBoundedRetries(
      {
        signal: abort.signal,
        sleep: async () => {},
        provider: {
          complete: async () => {
            sends++;
            return { kind: "completed", text: "", toolCalls: [] };
          },
        },
        onRequestStarted: async () => {
          abort.abort();
          return { ok: true };
        },
        onRetryScheduled: async () => {},
      },
      "m",
      [],
    );
    assert.equal(result.kind, "cancelled");
    assert.equal(sends, 0);
  });

  it("interrupts a pending retry delay before a second send", async () => {
    const abort = new AbortController();
    const sleeping = deferred<void>();
    const never = deferred<void>();
    let sends = 0;
    const attempt = completeWithBoundedRetries(
      {
        signal: abort.signal,
        sleep: async () => {
          sleeping.resolve();
          return never.promise;
        },
        provider: {
          complete: async () => {
            sends++;
            return { kind: "transient_failure", safeCode: "temporary", retryAfterMs: 60_000 };
          },
        },
        onRequestStarted: async () => ({ ok: true }),
        onRetryScheduled: async () => {},
      },
      "m",
      [],
    );
    await sleeping.promise;
    abort.abort();
    assert.equal((await attempt).kind, "cancelled");
    never.resolve();
    assert.equal(sends, 1);
  });

  it("all adapters fence cancellation while resolving credentials", async () => {
    for (const Adapter of [AnthropicProvider, OpenAiChatProvider, OpenAiResponsesProvider]) {
      const abort = new AbortController();
      let posts = 0;
      const adapter = new Adapter({
        baseUrl: "https://fixture.invalid",
        model: "fixture",
        resolveApiKey: async () => {
          abort.abort();
          return "synthetic-test-key";
        },
        post: async () => {
          posts++;
          return { ok: false, code: "cancelled" };
        },
      });
      assert.equal(
        (
          await adapter.complete({
            modelRequestId: "m",
            attemptNo: 1,
            conversation: [],
            signal: abort.signal,
          })
        ).kind,
        "cancelled",
      );
      assert.equal(posts, 0);
    }
  });

  it("aborts a real pending local HTTPS response", async () => {
    const entered = deferred<void>();
    const server = createServer({ cert: TEST_CERT_PEM, key: TEST_KEY_PEM }, (request) => {
      request.resume();
      entered.resolve();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address();
      assert.ok(address && typeof address === "object");
      const abort = new AbortController();
      const response = providerHttpsPost({
        url: `https://localhost:${address.port}/`,
        headers: {},
        bodyText: "{}",
        trustedCaPem: TEST_CERT_PEM,
        signal: abort.signal,
      });
      await Promise.race([
        entered.promise,
        response.then((result) => {
          throw new Error(`request ended before cancellation: ${JSON.stringify(result)}`);
        }),
      ]);
      abort.abort();
      assert.deepEqual(await response, { ok: false, code: "cancelled" });
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("closes Session resources even after a completed Run, once per controller", async () => {
    let cleanups = 0;
    const controller = createTuiController({
      coordinator: coordinator(
        async () => ({ kind: "completed", text: "done", toolCalls: [] }),
        async () => {
          cleanups++;
        },
      ),
    });
    await controller.submit("go");
    await Promise.all([controller.close(), controller.close()]);
    await controller.submit("must not run");
    assert.equal(cleanups, 1);
    assert.equal(controller.lastResult()?.status, "completed");
  });

  it("keeps the TUI mounted until quit cleanup settles and reports cleanup failures", async () => {
    const cleanup = deferred<void>();
    let unmounted = false;
    let element!: ReactElement<{ onQuit: () => void }>;
    const controller = createTuiController({
      coordinator: coordinator(
        async () => ({ kind: "completed", text: "", toolCalls: [] }),
        async () => cleanup.promise,
      ),
    });
    const ui = startTui(controller, {
      mount: (value) => {
        element = value as typeof element;
        return {
          rerender: () => {},
          unmount: () => {
            unmounted = true;
          },
        };
      },
    });
    element.props.onQuit();
    assert.equal(unmounted, false);
    cleanup.resolve();
    await delay(0);
    assert.equal(unmounted, true);
    ui.unmount();

    let error = "";
    startTui(
      createTuiController({
        coordinator: coordinator(
          async () => ({ kind: "completed", text: "", toolCalls: [] }),
          async () => {
            throw new Error("synthetic");
          },
        ),
      }),
      {
        mount: (value) => {
          element = value as typeof element;
          return { rerender: () => {}, unmount: () => {} };
        },
        onCleanupError: (code) => {
          error = code;
        },
      },
    );
    element.props.onQuit();
    await delay(0);
    assert.equal(error, "session_cleanup_failed");
  });
});

async function rebuild(payloads: readonly InternalEventPayload[]) {
  const log = new InMemoryEventLog(new SequenceIds("ev"), new JsonDigest());
  for (const payload of payloads)
    await log.append({
      sessionId: "s",
      runId: "r",
      type: payload.kind,
      correlationId: "c",
      causationId: null,
      timestampUtc: "2026-11-07T00:00:00.000Z",
      payload,
    });
  return rebuildConversation(await log.read("s"));
}
const call = { providerToolCallId: "p", toolName: "read_file", arguments: { path: "x" } };
const response = (
  id: string,
  text: string,
  calls = [] as (typeof call)[],
): InternalEventPayload => ({
  kind: "model_response_validated",
  modelRequestId: id,
  attemptNo: 1,
  text,
  toolCallCount: calls.length,
  toolCalls: calls,
});

describe("remaining history and configuration regressions", () => {
  it("blocks model sends when known history or capacity preflight fails", async () => {
    for (const code of [
      "protocol_history_incompatible",
      "context_capacity_insufficient",
    ] as const) {
      const ids = new SequenceIds("preflight");
      let sends = 0;
      const runtime = new RuntimeCoordinator({
        provider: {
          complete: async () => {
            sends++;
            return { kind: "completed", text: "unexpected", toolCalls: [] };
          },
        },
        tools: new RecordingTools(false, { status: "succeeded", text: null }),
        approvals: { decide: async () => "denied" },
        ids,
        eventLog: new InMemoryEventLog(ids, new JsonDigest()),
        nowUtc: () => "2026-11-07T00:00:00.000Z",
        preflightFailure: code,
      });
      const result = await runtime.run("go");
      assert.equal(result.status, "failed");
      assert.equal(result.safeCode, code);
      assert.equal(sends, 0);
    }
  });

  it("preserves two tool rounds and the final reply, even when a vendor reuses an id", async () => {
    const result = await rebuild([
      { kind: "run_started", input: "go" },
      response("m1", "first", [call]),
      { kind: "tool_call_received", toolCallId: "t1", ...call },
      {
        kind: "tool_execution_finished",
        toolCallId: "t1",
        status: "succeeded",
        safeCode: null,
        text: "one",
      },
      response("m2", "second", [call]),
      { kind: "tool_call_received", toolCallId: "t2", ...call },
      {
        kind: "tool_execution_finished",
        toolCallId: "t2",
        status: "succeeded",
        safeCode: null,
        text: "two",
      },
      response("m3", "final"),
      { kind: "run_completed", text: "final" },
    ]);
    assert.ok(result.ok);
    assert.deepEqual(
      result.conversation.map((item) => item.kind),
      ["user", "assistant", "tool_result", "assistant", "tool_result", "assistant"],
    );
    assert.equal(result.conversation.at(-1)?.text, "final");
  });

  it("does not leak unfinished calls into the next terminal Run", async () => {
    const result = await rebuild([
      { kind: "run_started", input: "unfinished" },
      response("m1", "partial", [call]),
      { kind: "tool_call_received", toolCallId: "t1", ...call },
      { kind: "run_started", input: "new" },
      response("m2", "done"),
      { kind: "run_completed", text: "done" },
    ]);
    assert.ok(result.ok);
    assert.equal(result.runs, 1);
    assert.deepEqual(result.conversation, [
      { kind: "user", text: "new" },
      { kind: "assistant", text: "done", toolCalls: [] },
    ]);
  });

  it("rejects unpaired calls in terminal Runs", async () => {
    const result = await rebuild([
      { kind: "run_started", input: "go" },
      response("m", "calling", [call]),
      { kind: "run_failed", safeCode: "broken" },
    ]);
    assert.equal(result.ok, false);
  });

  it("restores only consumed queued inputs, after cancelled calls", async () => {
    const result = await rebuild([
      { kind: "run_started", input: "go" },
      { kind: "run_input_queued", inputId: "q1", text: "changed", acceptedSeq: 1 },
      { kind: "run_input_queued", inputId: "q2", text: "withdrawn", acceptedSeq: 2 },
      { kind: "run_input_withdrawn", inputId: "q2" },
      response("m1", "calling", [call]),
      { kind: "run_input_batch_consumed", inputIds: ["q1"], throughSeq: 1, taskRevision: 1 },
      {
        kind: "tool_call_cancelled",
        toolCallId: "t",
        providerToolCallId: "p",
        toolName: "read_file",
        reason: "user_input_superseded",
      },
      response("m2", "done"),
      { kind: "run_completed", text: "done" },
    ]);
    assert.ok(result.ok);
    assert.deepEqual(
      result.conversation.map((item) => item.kind),
      ["user", "assistant", "tool_result", "user", "assistant"],
    );
    assert.equal(result.conversation[3]?.text, "changed");
  });

  it("retains complete call/result groups when compacting", () => {
    const conversation = [
      { kind: "user" as const, text: "old" },
      { kind: "assistant" as const, text: "calling", toolCalls: [call] },
      { kind: "tool_result" as const, ...call, text: "body", status: "succeeded" as const },
    ];
    assert.deepEqual(retainRecentGroups(conversation, 1), conversation.slice(1));
    assert.deepEqual(retainRecentGroups(conversation, 0), []);
  });

  it("compaction replaces prior turns while retaining complete recent groups", async () => {
    const result = await rebuild([
      { kind: "run_started", input: "old" },
      response("m0", "old answer"),
      { kind: "run_completed", text: "old answer" },
      { kind: "run_started", input: "new" },
      response("m1", "calling", [call]),
      { kind: "tool_call_received", toolCallId: "t", ...call },
      {
        kind: "tool_execution_finished",
        toolCallId: "t",
        status: "succeeded",
        safeCode: null,
        text: "body",
      },
      {
        kind: "context_compacted",
        artifactSha256: "a".repeat(64),
        summarizedGroupIds: ["g1", "g2", "g3"],
        recentSuffixGroupIds: ["g4"],
        sourceHighWaterSeq: 4,
        estimatedAuxiliaryTokens: 1,
        artifactVersion: 1,
        summaryText: "summary",
      },
      response("m2", "final"),
      { kind: "run_completed", text: "final" },
    ]);
    assert.ok(result.ok);
    assert.deepEqual(
      result.conversation.map((item) => item.text),
      ["summary", "calling", "body", "final"],
    );
  });

  it("loads configured context windows and null unknown-window settings", () => {
    for (const contextWindow of [32_768, null]) {
      const result = readProviderConfig({
        provider: {
          protocol: "openai_chat",
          baseUrl: "https://fixture.invalid",
          model: "fixture",
          credentialRef: "test",
          contextWindow,
        },
      });
      assert.ok(result.ok);
      assert.equal(result.value.contextWindow, contextWindow);
    }
  });
});

describe("remaining DNS approval regressions", () => {
  function fixture() {
    let addresses = [{ address: "93.184.216.34", family: 4 as const }];
    let sends = 0;
    const tool = createWebTools({
      surchargeRulesReviewed: true,
      resolveAddresses: async () => addresses,
      runSearch: async () => ({ kind: "completed", items: [] }),
      runFetch: async () => {
        sends++;
        return { kind: "response", status: 200, location: null, bodyText: "body", rawBytes: 4 };
      },
    });
    const request = {
      toolCallId: "t",
      toolName: "web_fetch",
      arguments: { url: "https://fixture.invalid" },
    };
    return {
      tool,
      request,
      sends: () => sends,
      change: (value: typeof addresses) => {
        addresses = value;
      },
    };
  }
  it("requires a preview and binds its addresses through revalidation and send", async () => {
    const f = fixture();
    assert.equal((await f.tool.execute(f.request)).status, "failed");
    await f.tool.preview?.(f.request);
    assert.equal(await f.tool.revalidateApproval?.(f.request), true);
    f.change([{ address: "127.0.0.1", family: 4 }]);
    assert.equal(await f.tool.revalidateApproval?.(f.request), false);
    assert.equal((await f.tool.execute(f.request)).status, "failed");
    assert.equal(f.sends(), 0);
    await f.tool.preview?.(f.request);
    assert.equal((await f.tool.execute(f.request)).status, "succeeded");
    assert.equal((await f.tool.execute(f.request)).status, "failed");
    assert.equal(f.sends(), 1);
  });
  it("ignores DNS ordering but rejects argument changes and discards denied previews", async () => {
    const f = fixture();
    f.change([
      { address: "93.184.216.34", family: 4 },
      { address: "93.184.216.35", family: 4 },
    ]);
    await f.tool.preview?.(f.request);
    f.change([
      { address: "93.184.216.35", family: 4 },
      { address: "93.184.216.34", family: 4 },
    ]);
    assert.equal(await f.tool.revalidateApproval?.(f.request), true);
    assert.equal(
      await f.tool.revalidateApproval?.({
        ...f.request,
        arguments: { url: "https://fixture.invalid/changed" },
      }),
      false,
    );
    f.tool.discardApproval?.("t");
    assert.equal((await f.tool.execute(f.request)).status, "failed");
    assert.equal(f.sends(), 0);
  });
});

const environment = {
  PATH: process.env["PATH"] ?? "",
  SYSTEMROOT: process.env["SYSTEMROOT"] ?? "",
};
describe("remaining real output capture regressions", () => {
  it("TUI quit stops real foreground and completed-Run background work before later writes", async () => {
    for (const toolName of ["shell", "background_start"]) {
      // The repository-local scratch directory is gitignored and absent on a
      // fresh checkout, so create it before naming a temporary directory inside it.
      await mkdir(path.join(process.cwd(), ".tmp"), { recursive: true });
      const root = await mkdtemp(path.join(process.cwd(), ".tmp", "quit-real-"));
      const ids = new SequenceIds("quit-real");
      const tools = createWorkspaceTools({
        workspaceRoot: root,
        enableWrites: true,
        enableProcesses: true,
        approvals: { decide: async () => "approved" },
        ids,
      });
      let requests = 0;
      const runtime = new RuntimeCoordinator({
        provider: {
          complete: async () => ({
            kind: "completed",
            text: requests++ === 0 ? null : "launched",
            toolCalls:
              requests === 1
                ? [
                    {
                      providerToolCallId: "p",
                      toolName,
                      arguments: {
                        command: `${shellCommands.writeFile("running.txt", "started")}; ${shellCommands.writeAfterDelay(3, "late.txt", "must not happen")}`,
                        cwd: root,
                        timeoutMs: 15_000,
                      },
                    },
                  ]
                : [],
          }),
        },
        tools,
        ids,
        eventLog: new InMemoryEventLog(ids, new JsonDigest()),
        approvals: { decide: async () => "approved" },
        suspendOnApproval: false,
        nowUtc: () => "2026-11-07T00:00:00.000Z",
      });
      const controller = createTuiController({ coordinator: runtime });
      let element!: ReactElement<{ onQuit: () => void }>;
      let unmounted = false;
      const ui = startTui(controller, {
        mount: (value) => {
          element = value as typeof element;
          return {
            rerender: () => {},
            unmount: () => {
              unmounted = true;
            },
          };
        },
      });
      const submitted = controller.submit("launch the fixture");
      try {
        for (let i = 0; i < 150 && !existsSync(path.join(root, "running.txt")); i++)
          await delay(25);
        assert.equal(existsSync(path.join(root, "running.txt")), true);
        if (toolName === "background_start") await submitted;
        element.props.onQuit();
        await controller.close();
        await submitted;
        // Quit unmounts on a later tick; poll instead of assuming one macrotask.
        for (let i = 0; i < 100 && !unmounted; i++) await delay(10);
        assert.equal(unmounted, true);
        if (toolName === "shell") assert.equal(controller.lastResult()?.status, "cancelled");
        await delay(3_200);
        assert.equal(
          existsSync(path.join(root, "late.txt")),
          false,
          `${toolName} stopped before late write`,
        );
      } finally {
        await controller.close();
        ui.unmount();
      }
    }
  });

  it("reports oversized UTF-8 output as incomplete instead of a successful Shell result", async () => {
    const supervisor = createProcessSupervisor();
    const outcome = await supervisor.runToCompletion({
      command: `${shellCommands.repeat("X", 9 * 1024 * 1024)}; ${shellCommands.echo("SYNTHETIC_TAIL")}`,
      cwd: process.cwd(),
      environment,
      timeoutMs: 15_000,
    });
    assert.equal(outcome.kind, "completed");
    if (outcome.kind !== "completed") return;
    assert.ok(outcome.rawBytes > MAX_CAPTURE_BYTES);
    assert.equal(outcome.captureComplete, false);
    const tool = createShellTool({
      sessionMode: "workspace_write",
      inheritedEnvironment: environment,
      runShell: async () => outcome,
    });
    const result = await tool.execute({
      toolCallId: "t",
      toolName: "shell",
      arguments: { command: "fixture", cwd: process.cwd() },
    });
    assert.equal(result.status, "failed");
    assert.match(result.text ?? "", /capture incomplete/);
  });

  it("releases background pipes and keeps immutable per-stream records after exit", async () => {
    const registry = createBackgroundRegistry({
      sessionMode: "workspace_write",
      inheritedEnvironment: environment,
    });
    try {
      const started = await registry.dependencies.startProcess(
        {
          command: "Write-Output ('A' * 40000); Write-Error 'stderr-body'",
          cwd: process.cwd(),
          timeoutMs: 15_000,
          environmentGrants: [],
        },
        environment,
        "fixture",
        "t",
      );
      assert.equal(started.kind, "started");
      if (started.kind !== "started") return;
      let task = await registry.dependencies.getTask(started.task.taskId);
      for (let i = 0; i < 150 && task?.state === "running"; i++) {
        await delay(25);
        task = await registry.dependencies.getTask(started.task.taskId);
      }
      assert.ok(task && task.state === "exited");
      assert.equal(task.captureComplete, true);
      assert.deepEqual(
        task.records.map((record) => record.recordIndex),
        task.records.map((_, index) => index),
      );
      assert.ok(task.records.every((record) => record.byteLength <= 16 * 1024));
      assert.ok(task.records.some((record) => record.stream === "stderr"));
      assert.deepEqual(registry.liveTaskIds(), []);
      const page = readBackgroundPage(task, initialCursor(task), 64 * 1024);
      assert.ok(page.ok);
      assert.match(page.value.segments.map((item) => item.text).join(""), /stderr-body/);
      assert.deepEqual(await registry.dependencies.getTask(task.taskId), task);
    } finally {
      registry.disposeAll();
    }
  });

  // Windows stops the task at the capture cap and records `stopped`. On Linux the
  // writer receives SIGPIPE once the reader stops, so the task reaches `exited`
  // first; the cap still truncates the capture, but the terminal state differs.
  it(
    "stops excessive background output without any caller polling it",
    { skip: process.platform !== "win32" },
    async () => {
      const registry = createBackgroundRegistry({
        sessionMode: "workspace_write",
        inheritedEnvironment: environment,
      });
      try {
        const started = await registry.dependencies.startProcess(
          {
            command: `${shellCommands.repeat("X", 9 * 1024 * 1024)}; ${shellCommands.sleep(60)}`,
            cwd: process.cwd(),
            timeoutMs: 15_000,
            environmentGrants: [],
          },
          environment,
          "fixture",
          "t",
        );
        assert.equal(started.kind, "started");
        if (started.kind !== "started") return;
        for (let i = 0; i < 150 && registry.liveTaskIds().length > 0; i++) await delay(25);
        assert.deepEqual(registry.liveTaskIds(), []);
        const task = await registry.dependencies.getTask(started.task.taskId);
        assert.equal(task?.state, "stopped");
        assert.equal(task?.captureComplete, false);
      } finally {
        registry.disposeAll();
      }
    },
  );
});
