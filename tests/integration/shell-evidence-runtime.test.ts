import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, unlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { createFileVault } from "../../src/adapters/windows/file-credential-vault.ts";
import { selectRuntime } from "../../src/bootstrap/runtime-selection.ts";

async function waitFor(check: () => boolean) {
  const deadline = Date.now() + 10_000;
  while (!check()) {
    assert.ok(Date.now() < deadline);
    await delay(5);
  }
}

describe("production Shell evidence and reports", () => {
  it("retains complete raw output beyond the model cap and records missing evidence on reopen", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "lycwl-shell-evidence-"));
    const owners: { closeSession: (command: string) => Promise<void> }[] = [];
    try {
      const data = path.join(root, "data");
      const vault = createFileVault({ directory: data });
      assert.ok(
        (
          await vault.write({
            reference: "fixture",
            purpose: "provider_api_key",
            secret: "SYNTHETIC_PROVIDER_CREDENTIAL_NOT_OUTPUT",
          })
        ).ok,
      );
      let sends = 0;
      const open = async () => {
        const selected = await selectRuntime({
          workspaceRoot: root,
          dataDirectory: data,
          sessionId: "evidence-session",
          enableWrites: true,
          enableProcesses: true,
          hasSettings: true,
          settings: {
            provider: {
              protocol: "openai_chat",
              baseUrl: "https://fixture.invalid",
              model: "fixture",
              credentialRef: "fixture",
              contextWindow: 128000,
            },
          },
          post: async () => ({
            ok: true,
            status: 200,
            headers: {},
            wireBytes: 0,
            bodyText: JSON.stringify({
              choices: [
                {
                  message:
                    ++sends === 1
                      ? {
                          content: null,
                          tool_calls: [
                            {
                              id: "shell-call",
                              type: "function",
                              function: {
                                name: "shell",
                                arguments: JSON.stringify({
                                  command:
                                    "[Console]::Out.Write(('x' * 30000)); [Console]::Error.Write('problem')",
                                  cwd: ".",
                                }),
                              },
                            },
                          ],
                        }
                      : { content: "done" },
                },
              ],
            }),
          }),
        });
        assert.equal(selected.kind, "real");
        if (selected.kind !== "real") throw new Error("fixture unavailable");
        owners.push(selected.coordinator);
        return selected;
      };
      const selected = await open();
      const running = selected.coordinator.run("capture synthetic output");
      await waitFor(() => selected.coordinator.pendingApprovalView() !== null);
      const approval = selected.coordinator.pendingApprovalView();
      assert.ok(approval);
      assert.ok(
        (
          await selected.coordinator.replyApproval({
            ...approval,
            commandId: "approve-shell",
            decision: "approved",
          })
        ).ok,
      );
      const result = await running;
      assert.equal(result.status, "completed", result.safeCode ?? "");
      const execution = result.events.find(
        ({ payload }) => payload.kind === "tool_execution_finished" && payload.toolName === "shell",
      )?.payload;
      assert.ok(execution?.kind === "tool_execution_finished");
      assert.equal(execution.status, "succeeded");
      assert.ok(execution.text?.includes("[truncated: model budget]"));
      assert.equal(execution.evidence?.rawComplete, true);
      const attachment = execution.evidence.attachments[0];
      assert.ok(attachment);
      const file = path.join(
        data,
        "sessions",
        "sessions",
        "evidence-session",
        "attachments",
        attachment.ref.attachmentId,
      );
      assert.equal((await readFile(file)).length, 30000);
      const report = result.events.at(-1)?.payload;
      assert.ok(report?.kind === "task_report_snapshot");
      assert.equal(report.protocolRunState, "completed");
      assert.equal(report.report.verification.status, "unverified");
      assert.deepEqual(report.report.tests, []);
      assert.equal(report.report.usage.unknownChargeCount, 2);
      await selected.coordinator.closeSession("close-first");
      await unlink(file);
      const reopened = await open();
      assert.ok(reopened.warnings.some((warning) => warning.includes("evidence")));
      assert.ok(
        reopened.historyEvents.some(({ payload }) => payload.kind === "evidence_unavailable"),
      );
      const recovered = reopened.historyEvents.at(-1)?.payload;
      assert.ok(recovered?.kind === "task_report_snapshot");
      assert.equal(recovered.protocolRunState, "completed");
      assert.equal(recovered.report.verification.status, "blocked");
      assert.equal(recovered.report.evidenceAvailable, false);
      await reopened.coordinator.closeSession("close-second");
      const again = await open();
      assert.equal(
        again.historyEvents.length,
        reopened.historyEvents.length,
        "missing evidence is not appended repeatedly",
      );
    } finally {
      for (const owner of owners) await owner.closeSession("cleanup");
      await rm(root, { recursive: true, force: true });
    }
  });
});
