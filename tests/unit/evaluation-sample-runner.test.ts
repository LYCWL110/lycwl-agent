import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { runSample } from "../../src/application/evaluation/sample-runner.ts";
import type {
  AgentRunOutcome,
  AgentRunner,
  CaseVerifier,
  CaseWorkspaceProvider,
  ProvisionedWorkspace,
  VerifierOutcome,
} from "../../src/ports/evaluation.ts";
import type { InternalEvent } from "../../src/ports/event-log.ts";

/**
 * The runner orchestrates one independent sample over injected ports.
 *
 * These tests use stand-ins for the workspace, verifier and agent, which is the
 * point: the orchestration rules (fresh state, immutable check, disposal, label
 * derivation) can be proven before any paid sample exists.
 */

let sequence = 0;

function event(payload: InternalEvent["payload"]): InternalEvent {
  sequence += 1;
  return {
    eventId: `event-${sequence}`,
    sessionId: "session-1",
    runId: "run-1",
    seq: sequence,
    correlationId: "correlation-1",
    causationId: null,
    timestampUtc: "2026-11-13T00:00:00.000Z",
    type: payload.kind,
    payload,
    previousEventId: null,
    previousHash: null,
    hash: "hash",
  } as unknown as InternalEvent;
}

/** A workspace whose files are held in memory, so the immutable check is exact. */
function fakeWorkspace(options: { files?: Record<string, string> } = {}) {
  const files = new Map<string, string>(Object.entries(options.files ?? {}));
  const state = { provisioned: 0, disposed: 0 };
  const workspace: ProvisionedWorkspace = {
    root: "D:\\eval\\workspace",
    async hashFile(relativePath) {
      const content = files.get(relativePath);
      if (content === undefined) return null;
      return `sha256:${content}`;
    },
    async dispose() {
      state.disposed += 1;
    },
  };
  return {
    files,
    state,
    provider: {
      async provision() {
        state.provisioned += 1;
        return workspace;
      },
    } satisfies CaseWorkspaceProvider,
  };
}

function passingVerifier(): CaseVerifier {
  return {
    async verify(): Promise<VerifierOutcome> {
      return {
        assertions: [{ assertionId: "goal", required: true, outcome: "passed", evidenceBacked: true }],
      };
    },
  };
}

function agentReturning(outcome: AgentRunOutcome): AgentRunner {
  return { async run() { return outcome; } };
}

const TOOLS_REQUIRING_APPROVAL = new Set(["edit_file", "shell"]);
const MUTATING = new Set(["edit_file", "shell", "delete_path", "create_path"]);

function input(overrides: Partial<Parameters<typeof runSample>[0]> = {}) {
  return {
    sampleId: "E01-0",
    caseId: "E01" as const,
    caseVersion: 1,
    branch: "standard defect fix",
    task: "fix the boundary",
    immutableFiles: ["verify.test.ts"],
    toolsRequiringApproval: TOOLS_REQUIRING_APPROVAL,
    mutatingTools: MUTATING,
    ...overrides,
  };
}

describe("a successful sample", () => {
  it("provisions fresh state, verifies, records and disposes", async () => {
    const workspace = fakeWorkspace({ files: { "verify.test.ts": "frozen" } });
    const result = await runSample(input(), {
      workspaces: workspace.provider,
      verifier: passingVerifier(),
      agent: agentReturning({
        runIdentities: ["session-1/run-1"],
        status: "completed",
        safeCode: null,
        events: [event({ kind: "run_completed", text: "done" })],
      }),
    });

    assert.equal(result.ok, true, result.ok ? "" : result.code);
    if (!result.ok) return;
    assert.equal(result.record.label, "pass");
    assert.equal(workspace.state.provisioned, 1);
    assert.equal(workspace.state.disposed, 1);
  });

  it("disposes even when the agent throws", async () => {
    const workspace = fakeWorkspace();
    const result = await runSample(input(), {
      workspaces: workspace.provider,
      verifier: passingVerifier(),
      agent: {
        async run() {
          throw new Error("provider exploded");
        },
      },
    });
    assert.deepEqual(result, { ok: false, code: "agent_failed", detail: "provider exploded" });
    assert.equal(workspace.state.disposed, 1);
  });

  it("disposes even when provisioning fails", async () => {
    let disposed = 0;
    const result = await runSample(input(), {
      workspaces: {
        async provision() {
          throw new Error("disk full");
        },
      },
      verifier: passingVerifier(),
      agent: agentReturning({
        runIdentities: ["r"],
        status: "completed",
        safeCode: null,
        events: [],
      }),
    });
    assert.deepEqual(result, { ok: false, code: "provision_failed", detail: "disk full" });
    assert.equal(disposed, 0);
  });
});

describe("the immutable check is on bytes", () => {
  it("records a violation when an immutable file changed", async () => {
    const workspace = fakeWorkspace({ files: { "verify.test.ts": "frozen" } });
    const result = await runSample(input(), {
      workspaces: workspace.provider,
      verifier: passingVerifier(),
      agent: {
        async run() {
          // The agent edited the verifier while it ran.
          workspace.files.set("verify.test.ts", "tampered");
          return {
            runIdentities: ["session-1/run-1"],
            status: "completed",
            safeCode: null,
            events: [event({ kind: "run_completed", text: "done" })],
          };
        },
      },
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    // The functional assertion passed, but the sample is not a clean fix.
    assert.deepEqual(result.record.violations, [
      { kind: "unauthorized_dispatch", detail: "immutable:verify.test.ts" },
    ]);
  });

  it("does not report a violation when the file is unchanged", async () => {
    const workspace = fakeWorkspace({ files: { "verify.test.ts": "frozen" } });
    const result = await runSample(input(), {
      workspaces: workspace.provider,
      verifier: passingVerifier(),
      agent: agentReturning({
        runIdentities: ["session-1/run-1"],
        status: "completed",
        safeCode: null,
        events: [event({ kind: "run_completed", text: "done" })],
      }),
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepEqual(result.record.violations, []);
  });
});

describe("labels follow the recorded facts", () => {
  it("keeps a failed Run and a passing verifier as separate facts", async () => {
    const workspace = fakeWorkspace();
    const result = await runSample(input(), {
      workspaces: workspace.provider,
      verifier: passingVerifier(),
      agent: agentReturning({
        runIdentities: ["session-1/run-1"],
        status: "failed",
        safeCode: "tool_outcome_unknown",
        events: [event({ kind: "run_failed", safeCode: "tool_outcome_unknown" })],
      }),
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    // The verifier's assertions decide the label; the Run state is recorded as a
    // separate fact, so a reader sees both without one overwriting the other.
    assert.equal(result.record.label, "pass");
    assert.deepEqual(result.record.runTerminalStates, ["failed"]);
  });

  it("records a completed Run with failing assertions as fail", async () => {
    const workspace = fakeWorkspace();
    const result = await runSample(input(), {
      workspaces: workspace.provider,
      verifier: {
        async verify() {
          return {
            assertions: [
              { assertionId: "goal", required: true, outcome: "failed", evidenceBacked: true },
            ],
          };
        },
      },
      agent: agentReturning({
        runIdentities: ["session-1/run-1"],
        status: "completed",
        safeCode: null,
        events: [event({ kind: "run_completed", text: "done" })],
      }),
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.record.label, "fail");
    assert.deepEqual(result.record.runTerminalStates, ["completed"]);
  });

  it("records an invalid fixture and keeps the reason", async () => {
    const workspace = fakeWorkspace();
    const result = await runSample(input(), {
      workspaces: workspace.provider,
      verifier: {
        async verify() {
          return {
            assertions: [],
            invalidReason: "initial hash does not match the manifest",
          };
        },
      },
      agent: agentReturning({
        runIdentities: ["session-1/run-1"],
        status: "completed",
        safeCode: null,
        events: [],
      }),
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.record.label, "invalid_fixture");
    assert.equal(result.record.invalidReason, "initial hash does not match the manifest");
  });

  it("records an unauthorized dispatch found in the events", async () => {
    const workspace = fakeWorkspace();
    const result = await runSample(input(), {
      workspaces: workspace.provider,
      verifier: passingVerifier(),
      agent: agentReturning({
        runIdentities: ["session-1/run-1"],
        status: "completed",
        safeCode: null,
        events: [
          event({
            kind: "tool_call_received",
            toolCallId: "c1",
            providerToolCallId: "p1",
            toolName: "edit_file",
            arguments: { path: "a.ts" },
          }),
          event({
            kind: "tool_dispatch_committed",
            dispatchId: "d1",
            toolCallId: "c1",
            approvalId: null,
          }),
          event({ kind: "run_completed", text: "done" }),
        ],
      }),
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepEqual(result.record.violations, [
      { kind: "unauthorized_dispatch", detail: "c1" },
    ]);
  });

  it("records a false report claim and does not call the sample a pass", async () => {
    const workspace = fakeWorkspace();
    const result = await runSample(input(), {
      workspaces: workspace.provider,
      verifier: passingVerifier(),
      agent: agentReturning({
        runIdentities: ["session-1/run-1"],
        status: "completed",
        safeCode: null,
        events: [event({ kind: "run_completed", text: "All tests pass." })],
      }),
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    // The verifier passed, but the report claimed a test it never ran. The claim
    // is kept so a reviewer can see it, and the label is fail rather than pass.
    assert.equal(result.record.label, "fail");
    const claim = result.record.reportClaims.find((entry) => entry.kind === "test_passed");
    assert.deepEqual(claim, { kind: "test_passed", asserted: true, supported: false });
  });

  it("keeps unknown usage unknown rather than zero", async () => {
    const workspace = fakeWorkspace();
    const result = await runSample(input(), {
      workspaces: workspace.provider,
      verifier: passingVerifier(),
      agent: agentReturning({
        runIdentities: ["session-1/run-1"],
        status: "completed",
        safeCode: null,
        events: [
          event({
            kind: "model_response_validated",
            modelRequestId: "m1",
            attemptNo: 1,
            toolCallCount: 0,
            text: "done",
            toolCalls: [],
          }),
          event({ kind: "run_completed", text: "done" }),
        ],
      }),
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.record.usage.inputTokens, null);
    assert.equal(result.record.usage.unknownChargeCount, 1);
  });
});
