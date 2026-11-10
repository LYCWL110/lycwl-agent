import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { createSkillLoader } from "../../src/adapters/windows/skill-loader.ts";
import { InMemoryEventLog } from "../../src/application/coordinator/event-log.ts";
import { RuntimeCoordinator } from "../../src/application/coordinator/runtime-coordinator.ts";
import type {
  ModelProvider,
  ProviderCompletion,
  ProviderRequest,
} from "../../src/ports/model-provider.ts";
import type { ToolDefinition, ToolExecutor } from "../../src/ports/tool-executor.ts";
import { EMPTY_VIEW, interpretComposer } from "../../src/tui/view-model.ts";
import { JsonDigest, SequenceIds } from "../fakes/deterministic-services.ts";

/**
 * `/skill <id>` activates a workspace Skill by starting a Run.
 *
 * The body arrives as a user message with a provenance header, before the task text,
 * so the model reads the procedure and the task in that order. The command itself
 * grants nothing: no approval, no mode change.
 */

let root = "";

before(async () => {
  root = await mkdtemp(path.join(tmpdir(), "lycwl-skill-cmd-"));
});

after(async () => {
  if (root.length > 0) await rm(root, { recursive: true, force: true });
});

async function workspaceWithSkill(name: string, id: string, body: string): Promise<string> {
  const directory = path.join(root, name);
  await mkdir(path.join(directory, ".agents", "skills", id), { recursive: true });
  await writeFile(
    path.join(directory, ".agents", "skills", id, "SKILL.md"),
    `---\nname: ${id}\ndescription: a test skill\n---\n\n${body}\n`,
    "utf8",
  );
  return directory;
}

const noTools: ToolExecutor = {
  getDefinition: (): ToolDefinition | null => null,
  async execute() {
    return { status: "succeeded" as const, text: null };
  },
};

class EchoProvider implements ModelProvider {
  readonly requests: ProviderRequest[] = [];
  async complete(request: ProviderRequest): Promise<ProviderCompletion> {
    this.requests.push(request);
    return { kind: "completed", toolCalls: [], text: "done" };
  }
}

describe("/skill command parsing", () => {
  it("accepts a valid skill id and marks it on the run intent", () => {
    const intent = interpretComposer(EMPTY_VIEW, "/skill pptx");
    assert.equal(intent.kind, "start_run");
    if (intent.kind !== "start_run") return;
    assert.equal(intent.skillId, "pptx");
    assert.equal(intent.text, "/skill pptx");
  });

  it("rejects a missing id", () => {
    const intent = interpretComposer(EMPTY_VIEW, "/skill");
    assert.equal(intent.kind, "reject");
    if (intent.kind !== "reject") return;
    assert.equal(intent.reason, "invalid_command");
  });

  it("rejects an id that is not a valid skill directory name", () => {
    for (const text of ["/skill Bad_Name", "/skill ../escape", "/skill a b"]) {
      const intent = interpretComposer(EMPTY_VIEW, text);
      assert.equal(intent.kind, "reject", text);
    }
  });

  it("is refused while a Run is active", () => {
    const intent = interpretComposer(
      { ...EMPTY_VIEW, runStatus: "active", queueingInput: true },
      "/skill pptx",
    );
    assert.equal(intent.kind, "reject");
    if (intent.kind !== "reject") return;
    assert.equal(intent.reason, "run_active");
  });
});

describe("/skill run injection", () => {
  it("puts the skill body before the task as a user message", async () => {
    const workspace = await workspaceWithSkill("inject", "pptx", "Step 1: read the source.");
    const loader = createSkillLoader({ workspaceRoot: workspace });
    const provider = new EchoProvider();
    const ids = new SequenceIds("id");

    const coordinator = new RuntimeCoordinator({
      provider,
      tools: noTools,
      approvals: { decide: async () => "approved" },
      eventLog: new InMemoryEventLog(ids, new JsonDigest()),
      ids,
      nowUtc: () => "2026-11-08T00:00:00.000Z",
      suspendOnApproval: false,
      loadSkill: async ({ skillId }) => {
        const loaded = await loader.load({ skillId });
        return loaded.ok
          ? { ok: true as const, block: loaded.block, skillId: loaded.skillId }
          : { ok: false as const, code: loaded.code };
      },
    });

    const result = await coordinator.run("/skill pptx", { skillId: "pptx" });
    assert.equal(result.status, "completed");

    const conversation = provider.requests[0]?.conversation ?? [];
    const texts = conversation.map((item) => (item.kind === "user" ? item.text : ""));
    const skillIndex = texts.findIndex((text) => text.includes("[skill-activation]"));
    const taskIndex = texts.findIndex((text) => text.includes("/skill pptx"));
    assert.ok(skillIndex >= 0, "the skill body must be present");
    assert.ok(taskIndex > skillIndex, "the task must follow the skill body");
    assert.match(texts[skillIndex] ?? "", /trust=untrusted project material/);
    assert.match(texts[skillIndex] ?? "", /Step 1: read the source\./);
  });

  it("refuses before starting when the skill does not exist", async () => {
    const workspace = await workspaceWithSkill("missing", "real", "body");
    const loader = createSkillLoader({ workspaceRoot: workspace });
    const provider = new EchoProvider();
    const ids = new SequenceIds("id");

    const coordinator = new RuntimeCoordinator({
      provider,
      tools: noTools,
      approvals: { decide: async () => "approved" },
      eventLog: new InMemoryEventLog(ids, new JsonDigest()),
      ids,
      nowUtc: () => "2026-11-08T00:00:00.000Z",
      suspendOnApproval: false,
      loadSkill: async ({ skillId }) => {
        const loaded = await loader.load({ skillId });
        return loaded.ok
          ? { ok: true as const, block: loaded.block, skillId: loaded.skillId }
          : { ok: false as const, code: loaded.code };
      },
    });

    await assert.rejects(
      () => coordinator.run("/skill absent", { skillId: "absent" }),
      /skill_not_found/,
    );
    // No model request was made.
    assert.equal(provider.requests.length, 0);
  });

  it("refuses when no skill loader is wired", async () => {
    const provider = new EchoProvider();
    const ids = new SequenceIds("id");
    const coordinator = new RuntimeCoordinator({
      provider,
      tools: noTools,
      approvals: { decide: async () => "approved" },
      eventLog: new InMemoryEventLog(ids, new JsonDigest()),
      ids,
      nowUtc: () => "2026-11-08T00:00:00.000Z",
      suspendOnApproval: false,
    });

    await assert.rejects(
      () => coordinator.run("/skill pptx", { skillId: "pptx" }),
      /skill_tool_unavailable/,
    );
    assert.equal(provider.requests.length, 0);
  });

  it("does not inject anything for an ordinary Run", async () => {
    const provider = new EchoProvider();
    const ids = new SequenceIds("id");
    const coordinator = new RuntimeCoordinator({
      provider,
      tools: noTools,
      approvals: { decide: async () => "approved" },
      eventLog: new InMemoryEventLog(ids, new JsonDigest()),
      ids,
      nowUtc: () => "2026-11-08T00:00:00.000Z",
      suspendOnApproval: false,
      loadSkill: async () => ({ ok: true, block: "[skill-activation]", skillId: "x" }),
    });

    await coordinator.run("plain task");
    const conversation = provider.requests[0]?.conversation ?? [];
    assert.equal(
      conversation.some((item) => item.kind === "user" && item.text.includes("[skill-activation]")),
      false,
    );
  });
});
