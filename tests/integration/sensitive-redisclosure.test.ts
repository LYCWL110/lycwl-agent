import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { createFileVault } from "../../src/adapters/windows/file-credential-vault.ts";
import type { RuntimeCoordinator } from "../../src/application/coordinator/runtime-coordinator.ts";
import { selectRuntime } from "../../src/bootstrap/runtime-selection.ts";
import { createTuiController } from "../../src/tui/controller.ts";

const SECRET = "SYNTHETIC_ENV_NOT_A_PROVIDER_KEY";
const reply = (read = false) => ({
  ok: true as const,
  status: 200,
  headers: {},
  wireBytes: 0,
  bodyText: JSON.stringify({
    choices: [
      {
        message: {
          content: read ? null : "ack",
          ...(read
            ? {
                tool_calls: [
                  {
                    id: "read",
                    type: "function",
                    function: { name: "read_file", arguments: '{"path":".env"}' },
                  },
                ],
              }
            : {}),
        },
      },
    ],
  }),
});

async function waitFor(check: () => boolean) {
  const deadline = Date.now() + 5_000;
  while (!check()) {
    assert.ok(Date.now() < deadline, "projection did not become available");
    await delay(5);
  }
}

async function fixture(
  body: (f: {
    workspace: string;
    data: string;
    owners: RuntimeCoordinator[];
    open: (input: {
      account?: string;
      endpoint?: string;
      post: NonNullable<Parameters<typeof selectRuntime>[0]["post"]>;
    }) => Promise<Extract<Awaited<ReturnType<typeof selectRuntime>>, { kind: "real" }>>;
  }) => Promise<void>,
) {
  const root = await mkdtemp(path.join(tmpdir(), "lycwl-redisclosure-"));
  const workspace = path.join(root, "workspace");
  const data = path.join(root, "data");
  const owners: RuntimeCoordinator[] = [];
  try {
    await mkdir(workspace);
    await writeFile(path.join(workspace, ".env"), SECRET);
    const vault = createFileVault({ directory: data });
    for (const account of ["one", "two"])
      assert.ok(
        (
          await vault.write({
            reference: account,
            purpose: "provider_api_key",
            secret: `synthetic-account-${account}`,
          })
        ).ok,
      );
    await body({
      workspace,
      data,
      owners,
      open: async ({ account = "one", endpoint = "https://fixture.invalid/v1", post }) => {
        const selected = await selectRuntime({
          workspaceRoot: workspace,
          dataDirectory: data,
          sessionId: "session-1",
          hasSettings: true,
          settings: {
            provider: {
              protocol: "openai_chat",
              baseUrl: endpoint,
              model: "fixture",
              credentialRef: account,
              contextWindow: 128000,
            },
          },
          post,
        });
        assert.equal(selected.kind, "real");
        if (selected.kind !== "real") throw new Error("fixture unavailable");
        owners.push(selected.coordinator);
        return selected;
      },
    });
  } finally {
    for (const owner of owners) await owner.closeSession("test-close");
    await rm(root, { recursive: true, force: true });
  }
}

async function seed(f: Parameters<Parameters<typeof fixture>[0]>[0]) {
  let sends = 0;
  const selected = await f.open({ post: async () => reply(++sends === 1) });
  const running = selected.coordinator.run("read synthetic environment");
  await waitFor(() => selected.coordinator.pendingApprovalView() !== null);
  const pending = selected.coordinator.pendingApprovalView();
  assert.ok(pending);
  assert.ok(
    (
      await selected.coordinator.replyApproval({
        ...pending,
        commandId: "approve-read",
        decision: "approved",
      })
    ).ok,
  );
  const result = await running;
  assert.equal(result.status, "completed");
  assert.equal(sends, 2);
  assert.ok(result.events.some(({ payload }) => payload.kind === "sensitive_source_recorded"));
  await selected.coordinator.closeSession("seed-close");
}

describe("production sensitive redisclosure", () => {
  it("requires a new preview after key rotation while disclosure consent is pending", () =>
    fixture(async (f) => {
      await seed(f);
      let sends = 0;
      const next = await f.open({
        account: "two",
        post: async () => {
          sends++;
          return reply();
        },
      });
      const running = next.coordinator.run("continue with another account");
      await waitFor(() => next.coordinator.pendingDisclosureView() !== null);
      const previous = next.coordinator.pendingDisclosureView();
      assert.ok(previous);
      const vault = createFileVault({ directory: f.data });
      assert.ok(
        (
          await vault.write({
            reference: "two",
            purpose: "provider_api_key",
            secret: "synthetic-account-two-rotated",
          })
        ).ok,
      );
      assert.ok(
        (
          await next.coordinator.replySensitiveDisclosure({
            ...previous,
            commandId: "old-identity",
            decision: "approved",
          })
        ).ok,
      );
      await waitFor(() => {
        const current = next.coordinator.pendingDisclosureView();
        return current !== null && current.requestVersion > previous.requestVersion;
      });
      const current = next.coordinator.pendingDisclosureView();
      assert.ok(current);
      assert.notEqual(current.requestFingerprint, previous.requestFingerprint);
      assert.equal(sends, 0);
      assert.equal(
        (
          await next.coordinator.replySensitiveDisclosure({
            ...previous,
            commandId: "stale",
            decision: "approved",
          })
        ).ok,
        false,
      );
      await next.coordinator.replySensitiveDisclosure({
        ...current,
        commandId: "new-identity",
        decision: "denied",
      });
      assert.equal((await running).safeCode, "sensitive_disclosure_denied");
      assert.equal(sends, 0);
    }));

  it("does not reuse consent after queued task input changes the request", () =>
    fixture(async (f) => {
      await seed(f);
      let sends = 0;
      const next = await f.open({
        account: "two",
        post: async () => {
          sends++;
          return reply();
        },
      });
      const running = next.coordinator.run("continue");
      await waitFor(() => next.coordinator.pendingDisclosureView() !== null);
      const pending = next.coordinator.pendingDisclosureView();
      assert.ok(pending);
      assert.ok((await next.coordinator.queueInput("changed task")).ok);
      await next.coordinator.replySensitiveDisclosure({
        ...pending,
        commandId: "consent-before-change",
        decision: "approved",
      });
      assert.equal((await running).safeCode, "sensitive_disclosure_context_changed");
      assert.equal(sends, 0);
    }));

  for (const change of ["account", "endpoint"] as const) {
    it(`requires a separate consent after ${change} changes and denial sends nothing`, () =>
      fixture(async (f) => {
        await seed(f);
        let sends = 0;
        const next = await f.open({
          ...(change === "account" ? { account: "two" } : { endpoint: "https://other.invalid/v1" }),
          post: async () => {
            sends++;
            return reply();
          },
        });
        const controller = createTuiController({
          coordinator: next.coordinator,
          initialEvents: next.historyEvents,
        });
        const running = controller.submit("continue");
        await waitFor(() => controller.view().pendingDisclosure != null);
        assert.equal(sends, 0);
        assert.match(controller.view().pendingDisclosure?.safePreview ?? "", /\.env/u);
        await controller.deny();
        await running;
        assert.equal(sends, 0);
        assert.equal(controller.lastResult()?.safeCode, "sensitive_disclosure_denied");
        await controller.close();
      }));
  }

  it("preserves same-destination consent but scopes new-identity consent to one logical request", () =>
    fixture(async (f) => {
      await seed(f);
      let sends = 0;
      const same = await f.open({
        post: async () => {
          sends++;
          return reply();
        },
      });
      assert.equal((await same.coordinator.run("continue same account")).status, "completed");
      assert.equal(sends, 1);
      await same.coordinator.closeSession("same-close");
      const next = await f.open({
        account: "two",
        post: async (request) => {
          sends++;
          assert.match(request.bodyText, new RegExp(SECRET));
          return reply();
        },
      });
      const controller = createTuiController({ coordinator: next.coordinator });
      for (let round = 0; round < 2; round++) {
        const running = controller.submit(`continue ${round}`);
        await waitFor(() => next.coordinator.pendingDisclosureView() !== null);
        const pending = next.coordinator.pendingDisclosureView();
        assert.ok(pending);
        assert.equal(
          (
            await next.coordinator.replySensitiveDisclosure({
              ...pending,
              requestFingerprint: "stale",
              commandId: "stale",
              decision: "approved",
            })
          ).ok,
          false,
        );
        await controller.approve();
        await running;
        assert.equal(controller.lastResult()?.status, "completed");
      }
      assert.equal(sends, 3);
      await controller.close();
    }));

  it("cancels the disclosure wait without sending or losing the durable source", () =>
    fixture(async (f) => {
      await seed(f);
      let sends = 0;
      const next = await f.open({
        account: "two",
        post: async () => {
          sends++;
          return reply();
        },
      });
      const running = next.coordinator.run("continue");
      await waitFor(() => next.coordinator.pendingDisclosureView() !== null);
      await next.coordinator.cancelRun("cancel-disclosure");
      const result = await running;
      assert.equal(result.status, "cancelled");
      assert.equal(sends, 0);
      assert.ok(
        result.events.some(
          ({ payload }) =>
            payload.kind === "sensitive_disclosure_decided" && payload.decision === "cancelled",
        ),
      );
      const stored = await readFile(
        path.join(f.data, "sessions", "sessions", "session-1", "events.jsonl"),
        "utf8",
      );
      assert.match(stored, /sensitive_source_recorded/u);
    }));
});
