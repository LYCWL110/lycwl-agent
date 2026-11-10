import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";
import {
  createWriteTools,
  type WriteTargetFacts,
  type WriteToolDependencies,
} from "../../src/adapters/tools/write-tools.ts";
import { InMemoryEventLog } from "../../src/application/coordinator/event-log.ts";
import { RuntimeCoordinator } from "../../src/application/coordinator/runtime-coordinator.ts";
import type { ApprovalGate, ApprovalRequest } from "../../src/ports/approval-gate.ts";
import { JsonDigest, ScriptedProvider, SequenceIds } from "../fakes/deterministic-services.ts";

class InlineApproval implements ApprovalGate {
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

function sha(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function writeDeps(approval: "approved" | "denied") {
  const files = new Map<string, Buffer>();
  const writes: string[] = [];
  const gate = new InlineApproval(approval);
  const dependencies: WriteToolDependencies = {
    approvals: gate,
    inspectTarget: async (path): Promise<WriteTargetFacts> => {
      const bytes = files.get(path);
      return bytes === undefined
        ? { exists: false, sha256: null }
        : { exists: true, sha256: sha(bytes) };
    },
    readBytes: async (path) => {
      const bytes = files.get(path);
      if (bytes === undefined) throw new Error("not found");
      return bytes;
    },
    writeBytes: async (path, bytes) => {
      writes.push(path);
      files.set(path, Buffer.from(bytes));
    },
  };
  return { dependencies, gate, writes };
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
  deps: WriteToolDependencies,
) {
  const ids = new SequenceIds("test");
  const digests = new JsonDigest();
  const eventLog = new InMemoryEventLog(ids, digests);
  const coordinator = new RuntimeCoordinator({
    provider: new ScriptedProvider(responses),
    tools: createWriteTools(deps),
    approvals: deps.approvals,
    eventLog,
    ids,
    nowUtc: () => "2026-11-02T00:00:00.000Z",
    sleep: async () => undefined,
  });
  return { eventLog, coordinator };
}

const CREATE_CALL = {
  providerToolCallId: "provider-call-1",
  toolName: "create_file",
  arguments: { path: "notes.txt", content: "hello\n" },
};

describe("write tools through the Runtime", () => {
  it("shows the operation preview in the approval event and then writes", async () => {
    const { dependencies, gate, writes } = writeDeps("approved");
    const { coordinator } = coordinatorWith(
      [
        { kind: "completed", toolCalls: [CREATE_CALL], text: null },
        { kind: "completed", toolCalls: [], text: "done" },
      ],
      dependencies,
    );

    const result = await coordinator.run("create a note");

    assert.equal(result.status, "completed");
    assert.equal(gate.requests.length, 1);
    assert.match(gate.requests[0]?.safePreview ?? "", /path=notes\.txt/);
    assert.equal(writes.length, 1);

    const requested = result.events.find((event) => event.payload.kind === "approval_requested");
    assert.equal(requested?.payload.kind, "approval_requested");
    if (requested?.payload.kind !== "approval_requested") return;
    assert.match(requested.payload.safePreview, /create_file/);
    assert.match(requested.payload.safePreview, /effect=replaces file bytes on disk/);
  });

  it("does not write when the approval is denied", async () => {
    const { dependencies, writes } = writeDeps("denied");
    const { coordinator } = coordinatorWith(
      [
        { kind: "completed", toolCalls: [CREATE_CALL], text: null },
        { kind: "completed", toolCalls: [], text: "continued" },
      ],
      dependencies,
    );

    const result = await coordinator.run("denied write");

    assert.equal(result.status, "completed");
    assert.equal(writes.length, 0);
    const denied = result.events.find((event) => event.payload.kind === "tool_execution_denied");
    assert.notEqual(denied, undefined);
  });

  it("reports the write failure to the model without a fake success", async () => {
    const { dependencies } = writeDeps("approved");
    const failing: WriteToolDependencies = {
      ...dependencies,
      writeBytes: async () => {
        throw new Error("disk error");
      },
    };
    const { coordinator } = coordinatorWith(
      [
        { kind: "completed", toolCalls: [CREATE_CALL], text: null },
        { kind: "completed", toolCalls: [], text: "reported" },
      ],
      failing,
    );

    const result = await coordinator.run("failing write");

    assert.equal(result.status, "failed");
    assert.equal(result.safeCode, "tool_outcome_unknown");
  });
});
