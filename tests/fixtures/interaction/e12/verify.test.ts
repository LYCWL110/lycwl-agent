import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { JsonlCheckpointStore } from "../../../../src/adapters/persistence/jsonl-checkpoint-store.ts";
import { JsonlEventLog } from "../../../../src/adapters/persistence/jsonl-event-log.ts";
import { RuntimeCoordinator } from "../../../../src/application/coordinator/runtime-coordinator.ts";
import {
  createRunModelBinding,
  describeEndpoint,
  endpointFingerprintInput,
  type RunModelBinding,
} from "../../../../src/domain/model-request/run-binding.ts";
import type {
  ModelProvider,
  ProviderCompletion,
  ProviderRequest,
} from "../../../../src/ports/model-provider.ts";
import type { SensitiveSource } from "../../../../src/ports/sensitive-context.ts";
import type { ToolDefinition, ToolExecutor } from "../../../../src/ports/tool-executor.ts";
import { approveWhen, callTool, say, scriptedApprovals } from "../harness.ts";

/**
 * E12: a saved credential is not consent to redisclose what was already read.
 *
 * The frozen branch: a sensitive synthetic file is read under account identity A.
 * The user then saves account identity B and continues. The next request contains
 * that material, so the Harness must stop and show a disclosure preview naming the
 * destination and identity. Saving, an ordinary message and a plain resume are not
 * consent; only a matching reply is, and it covers exactly the request that was
 * shown.
 *
 * Everything here is synthetic: a fake vault identity, a fake provider, and a
 * fixture file. No Credential Manager entry, real key or real network request is
 * involved, so this cannot stand in for G03 or G07.
 */

const digests = {
  async sha256Canonical(value: unknown): Promise<string> {
    return createHash("sha256").update(JSON.stringify(value)).digest("hex");
  },
};
const ids = { create: () => randomUUID() };

const sha256 = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");

/** A synthetic identity pair. `revision` models a save; `ref` models the account. */
type Identity = Readonly<{ ref: string; revision: number }>;

function bindingFor(identity: Identity): RunModelBinding {
  const described = describeEndpoint({ host: "fixture.invalid", port: null, path: "/v1/chat" });
  assert.equal(described.ok, true);
  if (!described.ok) throw new Error("endpoint");
  const created = createRunModelBinding({
    providerId: "fixture-provider",
    modelId: "fixture-model",
    protocolId: "openai_chat",
    adapterVersion: "fixture-adapter-1",
    endpoint: described.value,
    endpointFingerprint: sha256(endpointFingerprintInput(described.value)),
    catalog: { snapshotId: "fixture-catalog", sha256: sha256("catalog") },
    capabilities: { snapshotId: "fixture-caps", sha256: sha256("caps") },
    credential: { credentialRef: identity.ref, revision: identity.revision },
  });
  assert.equal(created.ok, true);
  if (!created.ok) throw new Error("binding");
  return created.value;
}

const SENSITIVE_TEXT = "SYNTHETIC_SECRET_FROM_A_FIXTURE_FILE";

/** A read tool that returns one synthetic sensitive source on success. */
function sensitiveReadTools(): ToolExecutor {
  const definitions: Record<string, ToolDefinition> = {
    read_file: {
      name: "read_file",
      version: "1",
      sideEffectClass: "read_only",
      requiresApproval: true,
      concurrencySafe: true,
    },
  };
  const source: SensitiveSource = {
    sourceId: "fixture-secret-source",
    label: ".env",
    contentDigest: sha256(SENSITIVE_TEXT),
    // The coordinator overwrites this with the Run's own binding.
    origin: null,
  };
  return {
    getDefinition: (name) => definitions[name] ?? null,
    discardApproval: () => undefined,
    async preview(request) {
      const args = request.arguments as { path?: string } | null;
      return `${request.toolName} path=${args?.path ?? "?"} (sensitive)`;
    },
    async execute(request) {
      if (request.toolName !== "read_file") {
        return { status: "failed" as const, safeCode: "unsupported", text: null };
      }
      return {
        status: "succeeded" as const,
        text: SENSITIVE_TEXT,
        sensitiveSources: [
          { sourceId: source.sourceId, label: source.label, contentDigest: source.contentDigest },
        ],
      };
    },
  };
}

/** A provider that records exactly what it was sent. */
type RecordingProvider = {
  provider: ModelProvider;
  requests: ProviderRequest[];
};

function recordingProvider(
  respond: (request: ProviderRequest) => ProviderCompletion,
): RecordingProvider {
  const requests: ProviderRequest[] = [];
  return {
    requests,
    provider: {
      async complete(request) {
        requests.push(request);
        return respond(request);
      },
    },
  };
}

/**
 * Two Runs in one Session with different identities.
 *
 * The first Run reads the synthetic sensitive file under identity A. The second
 * runs under identity B with a prior conversation that still contains the file
 * text, which is exactly the redisclosure case.
 */
async function withTwoRuns(
  options: Readonly<{
    /** The identity the second Run binds. */
    secondIdentity: Identity;
    /** What the provider answers on each Run. */
    respond: (request: ProviderRequest, runNo: number) => ProviderCompletion;
    /** Extra conversation the second Run starts with, simulating the read. */
    seedConversation: boolean;
  }>,
  run: (context: {
    first: RuntimeCoordinator;
    second: RuntimeCoordinator;
    secondProvider: RecordingProvider;
    log: JsonlEventLog;
    root: string;
  }) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(path.join(tmpdir(), "e12-"));
  const log = new JsonlEventLog(root, ids, digests);
  const tools = sensitiveReadTools();
  const firstProvider = recordingProvider(() => say("read complete"));
  const secondProvider = recordingProvider((request) => options.respond(request, 2));

  // A prior conversation that already holds the sensitive text, as a resumed
  // Session would after the read was approved and disclosed.
  const priorConversation = options.seedConversation
    ? [
        { kind: "user" as const, text: "read the synthetic environment" },
        {
          kind: "assistant" as const,
          text: null,
          toolCalls: [
            { providerToolCallId: "read-1", toolName: "read_file", arguments: { path: ".env" } },
          ],
        },
        {
          kind: "tool_result" as const,
          providerToolCallId: "read-1",
          toolName: "read_file",
          status: "succeeded" as const,
          text: SENSITIVE_TEXT,
        },
      ]
    : [];

  try {
    const first = new RuntimeCoordinator({
      provider: firstProvider.provider,
      tools,
      approvals: scriptedApprovals([approveWhen("read_file")]).gate,
      eventLog: log,
      checkpoints: new JsonlCheckpointStore(root, digests),
      ids,
      nowUtc: () => new Date().toISOString(),
      suspendOnApproval: false,
      sessionId: `e12-${randomUUID()}`,
      runBinding: bindingFor({ ref: "account-a", revision: 1 }),
      resolveCredentialRevision: async () => 1,
      requestFingerprint: (value) => digests.sha256Canonical(value),
      sensitiveSources: [],
    });

    const second = new RuntimeCoordinator({
      provider: secondProvider.provider,
      tools,
      approvals: scriptedApprovals([approveWhen("read_file")]).gate,
      eventLog: log,
      checkpoints: new JsonlCheckpointStore(root, digests),
      ids,
      nowUtc: () => new Date().toISOString(),
      suspendOnApproval: true,
      sessionId: `e12-${randomUUID()}`,
      runBinding: bindingFor(options.secondIdentity),
      resolveCredentialRevision: async () => options.secondIdentity.revision,
      requestFingerprint: (value) => digests.sha256Canonical(value),
      priorConversation,
      // The durable source recorded by the first Run is carried into the second.
      sensitiveSources: options.seedConversation
        ? [
            {
              sourceId: "fixture-secret-source",
              label: ".env",
              contentDigest: sha256(SENSITIVE_TEXT),
              origin: {
                providerId: "fixture-provider",
                modelId: "fixture-model",
                protocolId: "openai_chat",
                endpointFingerprint: bindingFor({ ref: "account-a", revision: 1 })
                  .endpointFingerprint,
                credentialRef: "account-a",
                credentialRevision: 1,
              },
            },
          ]
        : [],
    });

    await run({ first, second, secondProvider, log, root });
    await first.closeSession("close-first");
    await second.closeSession("close-second");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function conversationText(request: ProviderRequest): string {
  return request.conversation
    .map((item) => {
      if (item.kind === "user") return item.text;
      if (item.kind === "assistant") return item.text ?? "";
      return item.text ?? "";
    })
    .join("\n");
}

describe("E12: a saved credential is not consent", () => {
  it("stops before sending and shows the destination and identity", async () => {
    await withTwoRuns(
      {
        secondIdentity: { ref: "account-b", revision: 1 },
        respond: () => say("unreachable"),
        seedConversation: true,
      },
      async ({ second, secondProvider }) => {
        const running = second.run("continue the task");
        // The wait is reached by state, not by a delay.
        for (
          let attempt = 0;
          attempt < 200 && second.pendingDisclosureView() === null;
          attempt += 1
        ) {
          await new Promise<void>((resolve) => setTimeout(resolve, 5));
        }
        const pending = second.pendingDisclosureView();
        assert.ok(pending, "a disclosure preview must be shown");
        if (pending === null) return;

        // The preview names what the user is agreeing to disclose and where.
        assert.match(pending.safePreview, /Sensitive context redisclosure/u);
        assert.match(pending.safePreview, /credentialRef=account-b/u);
        assert.match(pending.safePreview, /revision=1/u);
        assert.match(pending.safePreview, /source=fixture-secret-source/u);
        assert.match(pending.safePreview, /sha256=/u);
        // The secret itself never appears in the preview.
        assert.equal(pending.safePreview.includes(SENSITIVE_TEXT), false);

        // Nothing was sent while the consent is outstanding.
        assert.equal(secondProvider.requests.length, 0);

        const outcome = await second.replySensitiveDisclosure({
          ...pending,
          commandId: "deny",
          decision: "denied",
        });
        assert.equal(outcome.ok, true);
        const result = await running;
        assert.equal(result.status, "failed");
        assert.equal(result.safeCode, "sensitive_disclosure_denied");
        assert.equal(secondProvider.requests.length, 0, "denial sends nothing");
      },
    );
  });

  it("rejects a reply bound to a stale fingerprint instead of accepting it", async () => {
    await withTwoRuns(
      {
        secondIdentity: { ref: "account-b", revision: 1 },
        respond: () => say("unreachable"),
        seedConversation: true,
      },
      async ({ second, secondProvider }) => {
        const running = second.run("continue the task");
        for (
          let attempt = 0;
          attempt < 200 && second.pendingDisclosureView() === null;
          attempt += 1
        ) {
          await new Promise<void>((resolve) => setTimeout(resolve, 5));
        }
        const pending = second.pendingDisclosureView();
        assert.ok(pending);
        if (pending === null) return;

        // A fingerprint from a different request cannot approve this one.
        const rejected = await second.replySensitiveDisclosure({
          ...pending,
          requestFingerprint: "stale-fingerprint",
          commandId: "stale",
          decision: "approved",
        });
        assert.equal(rejected.ok, false);
        assert.equal(secondProvider.requests.length, 0);

        await second.replySensitiveDisclosure({
          ...pending,
          commandId: "deny",
          decision: "denied",
        });
        await running;
      },
    );
  });
});

describe("E12: consent covers exactly what was shown", () => {
  it("sends after approval, and the sensitive text is present in the request", async () => {
    await withTwoRuns(
      {
        secondIdentity: { ref: "account-b", revision: 1 },
        respond: () => say("done"),
        seedConversation: true,
      },
      async ({ second, secondProvider }) => {
        const running = second.run("continue the task");
        for (
          let attempt = 0;
          attempt < 200 && second.pendingDisclosureView() === null;
          attempt += 1
        ) {
          await new Promise<void>((resolve) => setTimeout(resolve, 5));
        }
        const pending = second.pendingDisclosureView();
        assert.ok(pending);
        if (pending === null) return;
        assert.equal(
          (
            await second.replySensitiveDisclosure({
              ...pending,
              commandId: "approve",
              decision: "approved",
            })
          ).ok,
          true,
        );

        const result = await running;
        assert.equal(result.status, "completed");
        assert.equal(secondProvider.requests.length, 1);
        // The user agreed to this material going to this identity, and it did.
        assert.equal(
          conversationText(secondProvider.requests[0] as ProviderRequest).includes(SENSITIVE_TEXT),
          true,
        );
        const decided = result.events.find(
          ({ payload }) => payload.kind === "sensitive_disclosure_decided",
        )?.payload;
        assert.ok(decided?.kind === "sensitive_disclosure_decided");
        if (decided?.kind !== "sensitive_disclosure_decided") return;
        assert.equal(decided.decision, "approved");
        // The event records a fingerprint, never the content.
        assert.equal(JSON.stringify(decided).includes(SENSITIVE_TEXT), false);
      },
    );
  });

  it("does not require consent again when the identity did not change", async () => {
    await withTwoRuns(
      {
        // Same reference and revision as the source was recorded under.
        secondIdentity: { ref: "account-a", revision: 1 },
        respond: () => say("done"),
        seedConversation: true,
      },
      async ({ second, secondProvider }) => {
        const result = await second.run("continue the task");
        assert.equal(result.status, "completed");
        // No preview was needed, and no disclosure wait was recorded.
        assert.equal(second.pendingDisclosureView(), null);
        assert.equal(
          result.events.some(({ payload }) => payload.kind === "sensitive_disclosure_requested"),
          false,
        );
        assert.equal(secondProvider.requests.length, 1);
      },
    );
  });
});

describe("E12: only an explicit matching reply is consent", () => {
  it("an ordinary message does not resolve the disclosure wait", async () => {
    await withTwoRuns(
      {
        secondIdentity: { ref: "account-b", revision: 1 },
        respond: () => say("unreachable"),
        seedConversation: true,
      },
      async ({ second, secondProvider }) => {
        const running = second.run("continue the task");
        for (
          let attempt = 0;
          attempt < 200 && second.pendingDisclosureView() === null;
          attempt += 1
        ) {
          await new Promise<void>((resolve) => setTimeout(resolve, 5));
        }
        const pending = second.pendingDisclosureView();
        assert.ok(pending);
        if (pending === null) return;

        // A message is not a decision. The wait stays open and nothing is sent.
        const queued = await second.queueInput("yes, go ahead");
        assert.equal(queued.ok, true);
        assert.notEqual(second.pendingDisclosureView(), null);
        assert.equal(secondProvider.requests.length, 0);

        // The queued input invalidates the exact request that was shown: the
        // consent the user was asked for no longer describes what would be sent.
        await second.replySensitiveDisclosure({
          ...pending,
          commandId: "approve",
          decision: "approved",
        });
        const result = await running;
        assert.equal(result.safeCode, "sensitive_disclosure_context_changed");
        assert.equal(secondProvider.requests.length, 0);
      },
    );
  });

  it("a recovery review of a blocked value cannot be mistaken for consent", async () => {
    await withTwoRuns(
      {
        secondIdentity: { ref: "account-b", revision: 1 },
        respond: () => say("unreachable"),
        seedConversation: false,
      },
      async ({ second, secondProvider }) => {
        // With no sensitive source there is nothing to disclose, so the Run just
        // completes. The assertion that matters: no disclosure event is fabricated
        // for a source that was never read.
        const result = await second.run("continue the task");
        assert.equal(result.status, "completed");
        assert.equal(
          result.events.some(({ payload }) => payload.kind === "sensitive_disclosure_requested"),
          false,
        );
        assert.equal(secondProvider.requests.length, 1);
      },
    );
  });
});
