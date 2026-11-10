import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { describe, it } from "node:test";
import {
  createReadFileTool,
  type ReadFileToolDependencies,
} from "../../src/adapters/tools/read-file-tool.ts";
import { InMemoryEventLog } from "../../src/application/coordinator/event-log.ts";
import { replayRun } from "../../src/application/coordinator/replay.ts";
import { RuntimeCoordinator } from "../../src/application/coordinator/runtime-coordinator.ts";
import type { ApprovalGate, ApprovalRequest } from "../../src/ports/approval-gate.ts";
import type { FileSnapshotFacts } from "../../src/services/files/consistent-snapshot.ts";
import { JsonDigest, ScriptedProvider, SequenceIds } from "../fakes/deterministic-services.ts";

const READ_CALL = {
  providerToolCallId: "provider-call-1",
  toolName: "read_file",
  arguments: { path: "src\\note.txt" },
} as const;

function facts(size: number): FileSnapshotFacts {
  return { identity: "file-1", size, lastWriteTimeNs: 1n, isFile: true, isSymbolicLink: false };
}

class ApprovingGate implements ApprovalGate {
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

function readFileDeps(
  content: string,
  options: { approval?: "approved" | "denied"; path?: string } = {},
): ReadFileToolDependencies & { reads: () => number } {
  let reads = 0;
  let nextId = 1;
  const bytes = Buffer.from(content, "utf8");
  return {
    workspaceRoot: "D:\\repo",
    approvals: new ApprovingGate(options.approval ?? "approved"),
    ids: { create: () => `id-${nextId++}` },
    inspectTarget: async (requestedPath) => ({
      snapshot: facts(bytes.byteLength),
      target: {
        requestedPath,
        resolvedPath: options.path ?? `D:\\repo\\${requestedPath}`,
        isDirectory: false,
        isSymbolicLink: false,
      },
    }),
    readBytes: async () => {
      reads += 1;
      return bytes;
    },
    reads: () => reads,
  };
}

function coordinatorWith(
  responses: readonly {
    kind: "completed";
    toolCalls: readonly {
      providerToolCallId: string;
      toolName: string;
      arguments: unknown;
    }[];
    text: string | null;
  }[],
  tools: ReturnType<typeof createReadFileTool>,
  approval: "approved" | "denied" = "approved",
) {
  const ids = new SequenceIds("test");
  const digests = new JsonDigest();
  const eventLog = new InMemoryEventLog(ids, digests);
  const coordinator = new RuntimeCoordinator({
    provider: new ScriptedProvider(responses),
    tools,
    approvals: new ApprovingGate(approval),
    eventLog,
    ids,
    nowUtc: () => "2026-11-02T00:00:00.000Z",
    sleep: async () => undefined,
  });
  return { digests, eventLog, coordinator };
}

describe("read_file through the Runtime", () => {
  it("dispatches a workspace read and returns real file facts to the model", async () => {
    const deps = readFileDeps("alpha\nbeta\n");
    const tool = createReadFileTool(deps);
    const { coordinator, eventLog, digests } = coordinatorWith(
      [
        { kind: "completed", toolCalls: [READ_CALL], text: null },
        { kind: "completed", toolCalls: [], text: "read it" },
      ],
      tool,
    );

    const result = await coordinator.run("read the note");

    assert.equal(result.status, "completed");
    assert.equal(deps.reads(), 1);
    const finished = result.events.find(
      (event) => event.payload.kind === "tool_execution_finished",
    );
    assert.equal(finished?.payload.kind, "tool_execution_finished");
    if (finished?.payload.kind !== "tool_execution_finished") return;
    assert.equal(finished.payload.status, "succeeded");
    assert.match(finished.payload.text ?? "", /lines 1-2/);
    assert.match(finished.payload.text ?? "", /alpha\nbeta\n$/);
    assert.equal(
      result.events.some((event) => event.payload.kind === "tool_dispatch_committed"),
      true,
    );

    const replayed = await replayRun(
      await eventLog.read(result.events[0]?.sessionId ?? ""),
      digests,
    );
    assert.equal(replayed.ok, true);
    if (!replayed.ok) return;
    assert.equal(replayed.value.state, "completed");
  });

  it("returns a read failure to the model without executing anything else", async () => {
    const deps = readFileDeps("SECRET\n", { approval: "denied" });
    const tool = createReadFileTool(deps);
    const { coordinator } = coordinatorWith(
      [
        {
          kind: "completed",
          toolCalls: [{ ...READ_CALL, arguments: { path: ".env" } }],
          text: null,
        },
        { kind: "completed", toolCalls: [], text: "reported" },
      ],
      tool,
      "denied",
    );

    const result = await coordinator.run("read a secret");

    assert.equal(result.status, "completed");
    assert.equal(deps.reads(), 0);
    assert.ok(result.events.some((event) => event.payload.kind === "tool_execution_denied"));
    assert.equal(
      result.events.some((event) => event.payload.kind === "tool_execution_started"),
      false,
    );
  });

  it("treats read_file as an approval-free tool at the runtime layer", async () => {
    const deps = readFileDeps("x\n");
    const tool = createReadFileTool(deps);
    const { coordinator } = coordinatorWith(
      [
        { kind: "completed", toolCalls: [READ_CALL], text: null },
        { kind: "completed", toolCalls: [], text: "done" },
      ],
      tool,
    );

    const result = await coordinator.run("ordinary read");

    assert.equal(result.status, "completed");
    assert.equal(
      result.events.some((event) => event.payload.kind === "approval_requested"),
      false,
    );
    const dispatch = result.events.find(
      (event) => event.payload.kind === "tool_dispatch_committed",
    );
    assert.equal(dispatch?.payload.kind, "tool_dispatch_committed");
    if (dispatch?.payload.kind !== "tool_dispatch_committed") return;
    assert.equal(dispatch.payload.approvalId, null);
  });
});
