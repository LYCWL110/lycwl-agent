import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { createSessionCatalog } from "../../src/adapters/windows/session-catalog.ts";
import { sessionLabel } from "../../src/domain/session/session-catalog.ts";
import { createTuiController } from "../../src/tui/controller.ts";

/**
 * The wiring between the catalog, the controller and the panel.
 *
 * The controller is built with a stub coordinator because these paths never touch
 * the Runtime: they read the list, rename a title, and delete a directory.
 */

function writeSession(root: string, id: string, input: string): void {
  const directory = path.join(root, "sessions", "sessions", id);
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    path.join(directory, "events.jsonl"),
    `${JSON.stringify({ payload: { kind: "run_started", input } })}\n`,
    "utf8",
  );
}

function controllerFor(dataDirectory: string, sessionId: string) {
  const catalog = createSessionCatalog({ dataDirectory });
  return createTuiController({
    // Every field these tests exercise is served by the catalog, not the coordinator.
    coordinator: {
      currentRunProjection: () => null,
      pendingApprovalView: () => null,
      pendingDisclosureView: () => null,
      pendingQuestionView: () => null,
      configurationWaitView: () => null,
    } as never,
    sessionId,
    sessionCatalog: {
      list: async () => {
        const listed = await catalog.list();
        if (!listed.ok) return listed;
        return {
          ok: true as const,
          sessions: listed.sessions.map((entry) => ({
            sessionId: entry.sessionId,
            label: sessionLabel(entry),
            title: entry.title,
            modifiedAtUtc: entry.modifiedAtUtc,
            bytes: entry.bytes,
          })),
        };
      },
      rename: (id, title) => catalog.rename(id, title),
      remove: (id) => catalog.remove(id),
    },
  });
}

describe("session list wiring", () => {
  it("lists the sessions under the data directory", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "sessions-wire-"));
    writeSession(root, "aaa", "first task");
    writeSession(root, "bbb", "second task");
    const controller = controllerFor(root, "aaa");

    await controller.submit("/sessions");
    const view = controller.view();
    assert.equal(view.localPanel, "sessions");
    assert.equal(view.sessionList?.length, 2);
    assert.deepEqual(view.sessionList?.map((entry) => entry.sessionId).sort(), ["aaa", "bbb"]);
    // The current session is marked, and only that one.
    assert.deepEqual(
      view.sessionList?.filter((entry) => entry.current).map((entry) => entry.sessionId),
      ["aaa"],
    );
  });

  it("marks a title after a rename and shows it as the label", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "sessions-wire-"));
    writeSession(root, "aaa", "the original task");
    const controller = controllerFor(root, "other");

    await controller.submit("/sessions");
    await controller.renameSession("aaa", "Renamed session");
    const entry = controller.view().sessionList?.[0];
    assert.equal(entry?.title, "Renamed session");
    assert.equal(entry?.label, "Renamed session");
  });

  it("falls back to the first task when the title is cleared", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "sessions-wire-"));
    writeSession(root, "aaa", "the original task");
    const controller = controllerFor(root, "other");

    await controller.submit("/sessions");
    await controller.renameSession("aaa", "Temp");
    assert.equal(controller.view().sessionList?.[0]?.label, "Temp");
    await controller.renameSession("aaa", null);
    assert.equal(controller.view().sessionList?.[0]?.label, "the original task");
  });

  it("removes the directory and drops the row", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "sessions-wire-"));
    writeSession(root, "aaa", "one");
    writeSession(root, "bbb", "two");
    const controller = controllerFor(root, "other");

    await controller.submit("/sessions");
    await controller.deleteSession("aaa");
    const view = controller.view();
    assert.deepEqual(
      view.sessionList?.map((entry) => entry.sessionId),
      ["bbb"],
    );
    assert.equal(existsSync(path.join(root, "sessions", "sessions", "aaa")), false);
  });

  it("reports an in-use session as an error and keeps the row", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "sessions-wire-"));
    writeSession(root, "aaa", "one");
    const { acquireExclusiveFileLease } = await import(
      "../../src/adapters/windows/exclusive-file-lease.ts"
    );
    const lease = await acquireExclusiveFileLease(
      path.join(root, "sessions", "sessions", "aaa", "session.lock"),
      { timeoutMs: 0 },
    );
    const controller = controllerFor(root, "aaa");
    try {
      await controller.submit("/sessions");
      await controller.deleteSession("aaa");
      const view = controller.view();
      assert.equal(view.sessionListError, "session_in_use");
      assert.equal(view.sessionList?.length, 1);
    } finally {
      lease.release();
    }
  });

  it("reports an unreadable catalog rather than an empty list", async () => {
    const controller = createTuiController({
      coordinator: {
        currentRunProjection: () => null,
        pendingApprovalView: () => null,
        pendingDisclosureView: () => null,
        pendingQuestionView: () => null,
        configurationWaitView: () => null,
      } as never,
      sessionId: "x",
      sessionCatalog: {
        list: async () => ({ ok: false as const, code: "unreadable" }),
        rename: async () => ({ ok: false as const, code: "unreadable" }),
        remove: async () => ({ ok: false as const, code: "unreadable" }),
      },
    });
    await controller.submit("/sessions");
    const view = controller.view();
    assert.equal(view.sessionListError, "unreadable");
    assert.equal(view.sessionList, null);
  });
});
