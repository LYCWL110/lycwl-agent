import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { createBackgroundTools } from "../../src/adapters/tools/background-tools.ts";
import { createBackgroundRegistry } from "../../src/adapters/windows/background-registry.ts";
import { createFileVault } from "../../src/adapters/windows/file-credential-vault.ts";
import {
  createProcessSupervisor,
  MAX_CAPTURE_BYTES,
} from "../../src/adapters/windows/process-supervisor.ts";
import { selectRuntime } from "../../src/bootstrap/runtime-selection.ts";
import type { OwnedKeyRegistry } from "../../src/domain/security/owned-key-guard.ts";

const KEY = "SYNTHETIC_PIPE_PROTECTION_20261107";
const registry: OwnedKeyRegistry = {
  keys: [{ keyId: "fixture", value: KEY, state: "retired", revision: 1 }],
};
const environment = {
  PATH: process.env["PATH"] ?? "",
  SYSTEMROOT: process.env["SYSTEMROOT"] ?? "",
};
const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;
const run = (command: string, ownedKeys = registry) =>
  createProcessSupervisor({ ownedKeys }).runToCompletion({
    command,
    cwd: process.cwd(),
    environment,
    timeoutMs: 15000,
  });

describe("guarded real Windows process pipes", () => {
  it("prevents a delayed background start after cancellation or Session cleanup", async () => {
    for (const cancel of ["signal", "cleanup"] as const) {
      let release!: () => void;
      const pending = new Promise<void>((resolve) => {
        release = resolve;
      });
      const controller = new AbortController();
      const background = createBackgroundRegistry({
        sessionMode: "workspace_write",
        inheritedEnvironment: environment,
        ownedKeys: registry,
        refreshOwnedKeys: () => pending,
      });
      const starting = background.dependencies.startProcess(
        {
          command: "Start-Sleep -Seconds 60",
          cwd: process.cwd(),
          timeoutMs: 15000,
          environmentGrants: [],
        },
        environment,
        "fixture",
        "t",
        controller.signal,
      );
      if (cancel === "signal") controller.abort();
      else background.disposeAll();
      release();
      const outcome = await starting;
      assert.deepEqual(outcome, { kind: "unknown", safeCode: "background_start_cancelled" });
      assert.deepEqual(background.liveTaskIds(), []);
      background.disposeAll();
    }
  });

  it("preserves Unicode, quoting, stream identity and native stdin EOF", async () => {
    const text = 'double " quote C:\\fixture\\ \u4e2d\u6587 \ud83d\ude00';
    const result = await run(
      `[Console]::Out.WriteLine(${quote(text)}); [Console]::Error.WriteLine('error-body'); ` +
        "[Console]::Out.WriteLine([Console]::In.ReadToEnd().Length)",
    );
    assert.equal(result.kind, "completed");
    if (result.kind !== "completed") return;
    assert.equal(result.stdout, `${text}\r\n0\r\n`);
    assert.equal(result.stderr, "error-body\r\n");
    assert.equal(result.captureComplete, true);
    assert.equal(result.rawBytes, Buffer.byteLength(result.stdout + result.stderr));
  });

  for (const stream of ["Out", "Error"]) {
    it(`blocks a split key on Console.${stream} before any capture file exists`, async () => {
      const before = new Set(
        (await readdir(tmpdir())).filter((name) => /^lycwl-(out|err)-/.test(name)),
      );
      const result = await run(
        `[Console]::${stream}.Write(${quote(KEY.slice(0, 13))}); ` +
          "Start-Sleep -Milliseconds 150; " +
          `[Console]::${stream}.Write(${quote(KEY.slice(13))}); Start-Sleep -Seconds 20`,
      );
      assert.equal(result.kind, "completed");
      if (result.kind !== "completed") return;
      assert.equal(result.deliveryBlocked, "owned_key_detected");
      assert.equal(result.stdout + result.stderr, "");
      assert.equal(result.timedOut, false);
      assert.equal(result.captureComplete, false);
      const after = (await readdir(tmpdir())).filter((name) => /^lycwl-(out|err)-/.test(name));
      assert.deepEqual(
        after.filter((name) => !before.has(name)),
        [],
      );
    });
  }

  it("blocks invalid native bytes without a replacement-character fallback", async () => {
    const result = await run("[Console]::OpenStandardOutput().Write([byte[]](0xff), 0, 1)");
    assert.equal(result.kind, "completed");
    if (result.kind !== "completed") return;
    assert.equal(result.deliveryBlocked, "guard_failure");
    assert.equal(result.stdout + result.stderr, "");
  });

  it("enforces the exact combined cap and the first excess byte on pipes", async () => {
    for (const extra of [0, 1]) {
      const result = await run(
        `[Console]::Out.Write('A' * ${MAX_CAPTURE_BYTES / 2}); ` +
          `[Console]::Error.Write('B' * ${MAX_CAPTURE_BYTES / 2 + extra})`,
        { keys: [] },
      );
      assert.equal(result.kind, "completed");
      if (result.kind !== "completed") return;
      assert.equal(result.rawBytes, MAX_CAPTURE_BYTES + extra);
      assert.equal(result.outputLimitExceeded, extra === 1);
      assert.equal(result.captureComplete, extra === 0);
      assert.ok(Buffer.byteLength(result.stdout + result.stderr) <= MAX_CAPTURE_BYTES);
    }
  });

  it("withholds a pending background key prefix and stops after the second chunk", async () => {
    const background = createBackgroundRegistry({
      sessionMode: "workspace_write",
      inheritedEnvironment: environment,
      ownedKeys: registry,
    });
    try {
      const started = await background.dependencies.startProcess(
        {
          command:
            `[Console]::Out.Write(${quote(KEY.slice(0, 13))}); ` +
            "Start-Sleep -Milliseconds 700; " +
            `[Console]::Out.Write(${quote(KEY.slice(13))}); Start-Sleep -Seconds 20`,
          cwd: process.cwd(),
          timeoutMs: 10000,
          environmentGrants: [],
        },
        environment,
        "fixture",
      );
      assert.equal(started.kind, "started");
      if (started.kind !== "started") return;
      for (let i = 0; i < 300 && background.liveTaskIds().length; i++) {
        const task = await background.dependencies.getTask(started.task.taskId);
        assert.equal(task?.records.map((record) => record.text).join(""), "");
        await delay(10);
      }
      assert.deepEqual(background.liveTaskIds(), []);
      const task = await background.dependencies.getTask(started.task.taskId);
      assert.equal(task?.deliveryBlocked, "owned_key_detected");
      const output = await createBackgroundTools(background.dependencies).execute({
        toolCallId: "output",
        toolName: "background_output",
        arguments: { taskId: started.task.taskId },
      });
      assert.equal(output.deliveryBlocked, "owned_key_detected");
      assert.equal(output.text, null);
    } finally {
      background.disposeAll();
    }
  });

  it("checks a completed task again after credential rotation", async () => {
    let keys: OwnedKeyRegistry["keys"] = [];
    const background = createBackgroundRegistry({
      sessionMode: "workspace_write",
      inheritedEnvironment: environment,
      ownedKeys: {
        get keys() {
          return keys;
        },
      },
    });
    try {
      const started = await background.dependencies.startProcess(
        {
          command: `[Console]::Out.Write(${quote(KEY)})`,
          cwd: process.cwd(),
          timeoutMs: 10000,
          environmentGrants: [],
        },
        environment,
        "fixture",
      );
      assert.equal(started.kind, "started");
      if (started.kind !== "started") return;
      for (let i = 0; i < 300 && background.liveTaskIds().length; i++) await delay(10);
      keys = registry.keys;
      assert.equal(
        (await background.dependencies.getTask(started.task.taskId))?.deliveryBlocked,
        "owned_key_detected",
      );
    } finally {
      background.disposeAll();
    }
  });
});

describe("production pipe protection and durable events", () => {
  it("wires background capture protection into the production Runtime", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "lycwl-background-pipe-"));
    const workspace = path.join(root, "workspace");
    const dataDirectory = path.join(root, "data");
    try {
      await mkdir(workspace);
      const vault = createFileVault({ directory: dataDirectory });
      assert.equal(
        (
          await vault.write({
            reference: "fixture-key",
            purpose: "provider_api_key",
            secret: KEY,
          })
        ).ok,
        true,
      );
      await writeFile(path.join(workspace, "source.txt"), KEY);
      let sends = 0;
      const selected = await selectRuntime({
        workspaceRoot: workspace,
        dataDirectory,
        enableProcesses: true,
        enableWrites: true,
        settings: {
          provider: {
            protocol: "openai_chat",
            model: "fixture",
            baseUrl: "https://fixture.invalid",
            credentialRef: "fixture-key",
            contextWindow: 128000,
          },
        },
        hasSettings: true,
        sessionId: "background-fixture",
        post: async (request) => {
          sends++;
          assert.equal(request.bodyText.includes(KEY), false);
          if (sends > 1) await delay(250);
          assert.ok(sends < 32, "background protection was not observed within the Run budget");
          return {
            ok: true,
            status: 200,
            headers: {},
            wireBytes: 0,
            bodyText: JSON.stringify({
              choices: [
                {
                  finish_reason: "tool_calls",
                  message: {
                    content: null,
                    tool_calls: [
                      {
                        id: `call-${sends}`,
                        type: "function",
                        function: {
                          name: sends === 1 ? "background_start" : "background_output",
                          arguments: JSON.stringify(
                            sends === 1
                              ? {
                                  command:
                                    "Get-Content -Raw -Encoding UTF8 'source.txt'; Start-Sleep -Seconds 20",
                                  cwd: workspace,
                                }
                              : { taskId: "task-1" },
                          ),
                        },
                      },
                    ],
                  },
                },
              ],
            }),
          };
        },
      });
      assert.equal(selected.kind, "real");
      if (selected.kind !== "real") return;
      try {
        const pendingRun = selected.coordinator.run("inspect background fixture");
        const deadline = Date.now() + 5000;
        while (selected.coordinator.pendingApprovalView() === null) {
          assert.ok(Date.now() < deadline, "approval_timeout");
          await delay(5);
        }
        const pending = selected.coordinator.pendingApprovalView();
        assert.ok(pending);
        await selected.coordinator.replyApproval({
          ...pending,
          commandId: "approve-background",
          decision: "approved",
        });
        const result = await pendingRun;
        assert.equal(result.status, "waiting");
        assert.equal(result.safeCode, "protected_delivery_blocked");
        assert.ok(sends >= 2);
        // The blocked capture stops the Run before any further call is dispatched,
        // so the last finished tool is the launch, not a follow-up read. What must
        // hold is that no event carries the key and that the block was recorded.
        assert.ok(
          result.events.some((event) => event.payload.kind === "tool_result_delivery_blocked"),
          "the delivery block must be recorded",
        );
        for (const event of result.events) {
          if (event.payload.kind !== "tool_execution_finished") continue;
          assert.equal(event.payload.text === null || !event.payload.text.includes(KEY), true);
        }
        assert.equal(JSON.stringify(result.events).includes(KEY), false);
      } finally {
        await selected.coordinator.closeSession("close-background");
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  for (const representation of [
    "raw",
    "base64",
    "url",
    "utf16le",
    "utf16be",
    "utf16-valid-utf8",
  ] as const) {
    it(`wires ${representation} protection into approved Shell and persists only safe facts`, async () => {
      const root = await mkdtemp(path.join(tmpdir(), "lycwl-guarded-pipe-"));
      const workspace = path.join(root, "workspace");
      const dataDirectory = path.join(root, "data");
      try {
        await mkdir(workspace);
        const secret = representation === "utf16-valid-utf8" ? "\uadc2" : `${KEY}_"&\u4e2d`;
        const vault = createFileVault({ directory: dataDirectory });
        assert.equal(
          (
            await vault.write({
              reference: "fixture-key",
              purpose: "provider_api_key",
              secret,
            })
          ).ok,
          true,
        );
        const bytes =
          representation === "raw"
            ? Buffer.from(secret)
            : representation === "base64"
              ? Buffer.from(Buffer.from(secret).toString("base64"))
              : representation === "url"
                ? Buffer.from(encodeURIComponent(secret))
                : representation === "utf16le" || representation === "utf16-valid-utf8"
                  ? Buffer.from(secret, "utf16le")
                  : Buffer.from(secret, "utf16le").swap16();
        const source = path.join(workspace, "source.bin");
        await writeFile(source, bytes);
        let sends = 0;
        const command = `[Console]::OpenStandardOutput().Write([IO.File]::ReadAllBytes(${quote(source)}), 0, ${bytes.length})`;
        const selected = await selectRuntime({
          workspaceRoot: workspace,
          dataDirectory,
          enableProcesses: true,
          enableWrites: true,
          settings: {
            provider: {
              protocol: "openai_chat",
              model: "fixture",
              baseUrl: "https://fixture.invalid",
              credentialRef: "fixture-key",
              contextWindow: 128000,
            },
          },
          hasSettings: true,
          sessionId: "pipe-fixture",
          post: async () => {
            sends++;
            return {
              ok: true,
              status: 200,
              headers: {},
              wireBytes: 0,
              bodyText: JSON.stringify({
                choices: [
                  {
                    finish_reason: "tool_calls",
                    message: {
                      content: null,
                      tool_calls: [
                        {
                          id: "shell-call",
                          type: "function",
                          function: {
                            name: "shell",
                            arguments: JSON.stringify({ command, cwd: workspace }),
                          },
                        },
                      ],
                    },
                  },
                ],
              }),
            };
          },
        });
        assert.equal(selected.kind, "real");
        if (selected.kind !== "real") return;
        try {
          const pendingRun = selected.coordinator.run("inspect synthetic fixture");
          const deadline = Date.now() + 5000;
          while (selected.coordinator.pendingApprovalView() === null) {
            assert.ok(Date.now() < deadline, "approval_timeout");
            await delay(5);
          }
          const pending = selected.coordinator.pendingApprovalView();
          assert.ok(pending);
          assert.equal(
            (
              await selected.coordinator.replyApproval({
                ...pending,
                commandId: "fixture-approval",
                decision: "approved",
              })
            ).ok,
            true,
          );
          const result = await pendingRun;
          assert.equal(result.status, "waiting");
          assert.equal(result.safeCode, "protected_delivery_blocked");
          assert.equal(sends, 1);
          const finished = result.events.find(
            (event) => event.payload.kind === "tool_execution_finished",
          );
          assert.ok(finished?.payload.kind === "tool_execution_finished");
          assert.equal(finished.payload.text, null);
          assert.ok(
            result.events.some((event) => event.payload.kind === "tool_result_delivery_blocked"),
          );
          if (representation === "utf16-valid-utf8")
            assert.ok(
              result.events.some(
                (event) =>
                  event.payload.kind === "tool_result_delivery_blocked" &&
                  event.payload.reason === "owned_key_detected",
              ),
            );
          const stored = await readFile(
            path.join(dataDirectory, "sessions", "sessions", "pipe-fixture", "events.jsonl"),
            "utf8",
          );
          assert.equal(stored.includes(secret), false);
          assert.equal(stored.includes(bytes.toString("utf8")), false);
        } finally {
          await selected.coordinator.closeSession("fixture-close");
        }
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
  }
});
