import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import { createMemoryStore } from "../../src/adapters/persistence/memory-store.ts";
import { InMemoryEventLog } from "../../src/application/coordinator/event-log.ts";
import { RuntimeCoordinator } from "../../src/application/coordinator/runtime-coordinator.ts";
import { createTuiController } from "../../src/tui/controller.ts";
import {
  JsonDigest,
  RecordingTools,
  ScriptedProvider,
  SequenceIds,
} from "../fakes/deterministic-services.ts";

let directory = "";

before(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "lycwl-memory-commands-"));
});

after(async () => {
  if (directory.length > 0) await rm(directory, { recursive: true, force: true });
});

describe("memory commands", () => {
  it("saves, lists, replaces and forgets explicit feedback", async () => {
    const store = createMemoryStore({ directory, nowUtc: () => "2026-11-26T00:00:00.000Z" });
    const ids = new SequenceIds("memory-command");
    const coordinator = new RuntimeCoordinator({
      provider: new ScriptedProvider([{ kind: "completed", text: "unused", toolCalls: [] }]),
      tools: new RecordingTools(false, { status: "succeeded", text: null }),
      approvals: { decide: async () => "denied" },
      eventLog: new InMemoryEventLog(ids, new JsonDigest()),
      ids,
      nowUtc: () => "2026-11-26T00:00:00.000Z",
    });
    const controller = createTuiController({
      coordinator,
      memory: store,
      workspaceRoot: "/workspace/project",
    });

    await controller.submit("/remember Show the failing evidence first");
    assert.match(controller.view().commandNotice ?? "", /remembered/);
    const loaded = await store.load();
    assert.ok(loaded.ok);
    if (!loaded.ok) return;
    assert.equal(loaded.entries.length, 1);
    const id = loaded.entries[0]?.id;
    assert.ok(id);

    await controller.submit("/memory");
    assert.equal(controller.view().localPanel, "memory");
    assert.equal(controller.view().memoryEntries?.length, 1);

    await controller.submit(`/remember --replace ${id.slice(0, 8)} Use the shorter evidence list`);
    const replaced = await store.load();
    assert.ok(replaced.ok);
    if (replaced.ok) {
      assert.equal(replaced.entries[0]?.content, "Use the shorter evidence list");
      assert.equal(replaced.entries[0]?.type, "feedback");
    }

    await controller.submit(`/forget ${id.slice(0, 8)}`);
    const removed = await store.load();
    assert.ok(removed.ok);
    if (removed.ok) assert.deepEqual(removed.entries, []);
    controller.closePanel();
    await coordinator.closeSession("close");
  });
});
