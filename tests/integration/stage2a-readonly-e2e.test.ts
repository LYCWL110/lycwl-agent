import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import { InMemoryEventLog } from "../../src/application/coordinator/event-log.ts";
import { RuntimeCoordinator } from "../../src/application/coordinator/runtime-coordinator.ts";
import {
  createReadOnlyWorkspaceTools,
  UNAVAILABLE_CODE,
} from "../../src/bootstrap/read-only-tools.ts";
import type { ApprovalGate, ApprovalRequest } from "../../src/ports/approval-gate.ts";
import { JsonDigest, ScriptedProvider, SequenceIds } from "../fakes/deterministic-services.ts";

let root = "";

before(async () => {
  root = await mkdtemp(path.join(tmpdir(), "lycwl-e2e-"));
  await mkdir(path.join(root, "src"), { recursive: true });
  await writeFile(path.join(root, "src", "a.ts"), "const alpha = 1;\nconst beta = 2;\n");
  await writeFile(path.join(root, "README.md"), "# Demo\n");
  await writeFile(path.join(root, ".env"), "SECRET=supersecret\n");
});

after(async () => {
  if (root.length > 0) await rm(root, { recursive: true, force: true });
});

class RecordingApproval implements ApprovalGate {
  readonly requests: ApprovalRequest[] = [];
  readonly #decision: "approved" | "denied";

  constructor(decision: "approved" | "denied") {
    this.#decision = decision;
  }

  async decide(request: ApprovalRequest): Promise<"approved" | "denied"> {
    this.requests.push(request);
    return this.#decision;
  }
}

function build(
  responses: readonly {
    kind: "completed";
    toolCalls: readonly { providerToolCallId: string; toolName: string; arguments: unknown }[];
    text: string | null;
  }[],
  approval: "approved" | "denied" = "approved",
) {
  const ids = new SequenceIds("e2e");
  const digests = new JsonDigest();
  const eventLog = new InMemoryEventLog(ids, digests);
  const gate = new RecordingApproval(approval);
  const tools = createReadOnlyWorkspaceTools({ workspaceRoot: root, approvals: gate, ids });
  const coordinator = new RuntimeCoordinator({
    provider: new ScriptedProvider(responses),
    tools,
    approvals: gate,
    eventLog,
    ids,
    nowUtc: () => "2026-11-02T00:00:00.000Z",
    sleep: async () => undefined,
  });
  return { coordinator, gate };
}

function toolFinished(result: {
  events: readonly {
    payload: { kind: string; status?: string; safeCode?: string | null; text?: string | null };
  }[];
}) {
  return result.events.find((event) => event.payload.kind === "tool_execution_finished");
}

describe("Stage 2A read-only tools end to end", () => {
  it("reads a real workspace file through the Runtime", async () => {
    const { coordinator } = build([
      {
        kind: "completed",
        toolCalls: [
          {
            providerToolCallId: "p1",
            toolName: "read_file",
            arguments: { path: ["src", "a.ts"].join(path.sep) },
          },
        ],
        text: null,
      },
      { kind: "completed", toolCalls: [], text: "read it" },
    ]);

    const result = await coordinator.run("read the file");
    assert.equal(result.status, "completed");

    const finished = toolFinished(result);
    assert.equal(finished?.payload.kind, "tool_execution_finished");
    if (finished?.payload.kind !== "tool_execution_finished") return;
    assert.equal(finished.payload.status, "succeeded");
    assert.match(finished.payload.text ?? "", /const alpha = 1;/);
    assert.match(finished.payload.text ?? "", /const beta = 2;/);
  });

  it("requires approval for .env and reads nothing when denied", async () => {
    const { coordinator, gate } = build(
      [
        {
          kind: "completed",
          toolCalls: [
            {
              providerToolCallId: "p1",
              toolName: "read_file",
              arguments: { path: ".env" },
            },
          ],
          text: null,
        },
        { kind: "completed", toolCalls: [], text: "reported" },
      ],
      "denied",
    );

    const result = await coordinator.run("read the secret");
    assert.equal(result.status, "completed");
    assert.equal(gate.requests.length, 1);
    assert.match(gate.requests[0]?.safePreview ?? "", /sensitive|protected/i);

    const finished = toolFinished(result);
    if (finished?.payload.kind !== "tool_execution_finished") return;
    assert.equal(finished.payload.status, "failed");
    assert.equal(finished.payload.safeCode, "approval_denied");
  });

  it("reads .env after approval", async () => {
    const { coordinator, gate } = build(
      [
        {
          kind: "completed",
          toolCalls: [
            {
              providerToolCallId: "p1",
              toolName: "read_file",
              arguments: { path: ".env" },
            },
          ],
          text: null,
        },
        { kind: "completed", toolCalls: [], text: "done" },
      ],
      "approved",
    );

    const result = await coordinator.run("read the secret");
    assert.equal(gate.requests.length, 1);
    const finished = toolFinished(result);
    if (finished?.payload.kind !== "tool_execution_finished") return;
    assert.equal(finished.payload.status, "succeeded");
  });

  it("lists a real directory", async () => {
    const { coordinator } = build([
      {
        kind: "completed",
        toolCalls: [{ providerToolCallId: "p1", toolName: "list_dir", arguments: { path: "src" } }],
        text: null,
      },
      { kind: "completed", toolCalls: [], text: "listed" },
    ]);

    const result = await coordinator.run("list src");
    const finished = toolFinished(result);
    if (finished?.payload.kind !== "tool_execution_finished") return;
    assert.equal(finished.payload.status, "succeeded");
    assert.match(finished.payload.text ?? "", /src\/a\.ts/);
  });

  it("globs real files", async () => {
    const { coordinator } = build([
      {
        kind: "completed",
        toolCalls: [
          { providerToolCallId: "p1", toolName: "glob", arguments: { pattern: "**/*.ts" } },
        ],
        text: null,
      },
      { kind: "completed", toolCalls: [], text: "globbed" },
    ]);

    const result = await coordinator.run("find ts files");
    const finished = toolFinished(result);
    if (finished?.payload.kind !== "tool_execution_finished") return;
    assert.equal(finished.payload.status, "succeeded");
    assert.match(finished.payload.text ?? "", /src\/a\.ts/);
  });

  it("greps real file contents", async () => {
    const { coordinator } = build([
      {
        kind: "completed",
        toolCalls: [
          { providerToolCallId: "p1", toolName: "grep", arguments: { pattern: "alpha" } },
        ],
        text: null,
      },
      { kind: "completed", toolCalls: [], text: "grepped" },
    ]);

    const result = await coordinator.run("find alpha");
    const finished = toolFinished(result);
    if (finished?.payload.kind !== "tool_execution_finished") return;
    assert.equal(finished.payload.status, "succeeded");
    assert.match(finished.payload.text ?? "", /src\/a\.ts:1:const alpha = 1;/);
  });

  it("fails closed for every out-of-scope tool", async () => {
    for (const toolName of [
      "create_file",
      "edit_file",
      "apply_patch",
      "delete_path",
      "rename_path",
      "shell",
      "background_start",
      "lsp_diagnostics",
      "web_fetch",
    ]) {
      const { coordinator } = build([
        {
          kind: "completed",
          toolCalls: [
            { providerToolCallId: "p1", toolName, arguments: { path: "x", command: "x" } },
          ],
          text: null,
        },
        { kind: "completed", toolCalls: [], text: "done" },
      ]);

      const result = await coordinator.run("attempt a disabled tool");
      const finished = toolFinished(result);
      if (finished?.payload.kind !== "tool_execution_finished") continue;
      assert.equal(finished.payload.status, "failed", `${toolName} must fail`);
      assert.equal(
        finished.payload.safeCode === UNAVAILABLE_CODE ||
          finished.payload.safeCode === "unknown_tool",
        true,
        `${toolName} produced ${String(finished.payload.safeCode)}`,
      );
    }
  });
});
