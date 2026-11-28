import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { WebSessionListEntry, WebSessionRuntime } from "../../src/web/protocol.ts";
import {
  createWebSessionHost,
  WebSessionError,
  type WebSessionHost,
} from "../../src/web/session-host.ts";
import {
  createFakeCatalog,
  createFakeController,
  createFakeOpener,
  createFakeRuntime,
  type FakeCatalogEntry,
} from "../fakes/web-session.ts";

/**
 * The host owns the one live Session just like the terminal does.
 *
 * The ordering rule is the important one: the replacement runtime is opened
 * first, and only then is the previous controller closed. A switch that fails
 * must leave the current conversation exactly as it was.
 */

const LIST: readonly FakeCatalogEntry[] = [
  {
    sessionId: "session-b",
    label: "fix the parser",
    title: null,
    modifiedAtUtc: "2026-11-28T03:00:00.000Z",
    bytes: 4096,
  },
  {
    sessionId: "session-c",
    label: "write the tests",
    title: null,
    modifiedAtUtc: "2026-11-27T03:00:00.000Z",
    bytes: 2048,
  },
];

type Fixture = Readonly<{
  host: WebSessionHost;
  initial: WebSessionRuntime;
  initialController: ReturnType<typeof createFakeController>;
  opener: ReturnType<typeof createFakeOpener>;
  catalog: ReturnType<typeof createFakeCatalog>;
}>;

function fixture(
  options: Readonly<{
    clock?: { now: () => number };
    openSession?: (sessionId: string | null) => WebSessionRuntime | Promise<WebSessionRuntime>;
  }> = {},
): Fixture {
  const initialController = createFakeController();
  const initial = createFakeRuntime({
    sessionId: "session-a",
    controller: initialController.controller,
  });
  const opener = createFakeOpener(
    options.openSession === undefined ? {} : { open: options.openSession },
  );
  const catalog = createFakeCatalog(LIST);
  const host = createWebSessionHost({
    initial,
    openSession: opener.opener,
    catalog: catalog.catalog,
    ...(options.clock === undefined ? {} : { now: options.clock.now }),
  });
  return { host, initial, initialController, opener, catalog };
}

function isWebSessionError(code: string): (error: unknown) => boolean {
  return (error) => {
    assert.equal(error instanceof WebSessionError, true);
    assert.equal((error as WebSessionError).code, code);
    return true;
  };
}

describe("createWebSessionHost: switching sessions", () => {
  it("opens a new Session for null and closes the previous controller", async () => {
    const { host, initialController, opener } = fixture();
    const opened = await host.switchSession(null);
    assert.deepEqual(opener.calls, [null]);
    assert.equal(opened.sessionId, "session-new-001");
    assert.equal(host.current(), opened);
    assert.equal(initialController.calls.close, 1);
  });

  it("opens the replacement before closing the current session", async () => {
    let fixtureRef: Fixture | null = null;
    const observed: {
      current: string | null;
      switching: boolean;
      previousClosed: number;
    } = { current: null, switching: false, previousClosed: -1 };
    const built = fixture({
      openSession: async (sessionId) => {
        const fixtureNow = fixtureRef;
        assert.notEqual(fixtureNow, null);
        if (fixtureNow === null) throw new Error("fixture missing");
        observed.current = fixtureNow.host.current().sessionId;
        observed.switching = fixtureNow.host.isSwitching();
        observed.previousClosed = fixtureNow.initialController.calls.close;
        return createFakeRuntime({ sessionId: sessionId ?? "session-new" });
      },
    });
    fixtureRef = built;
    await built.host.switchSession("session-b");
    // At open time the old session is still current and still open.
    assert.deepEqual(observed, {
      current: "session-a",
      switching: true,
      previousClosed: 0,
    });
    assert.equal(built.host.current().sessionId, "session-b");
    assert.equal(built.initialController.calls.close, 1);
    assert.equal(built.host.isSwitching(), false);
  });

  it("treats a switch to the current id as a no-op", async () => {
    const { host, initial, initialController, opener } = fixture();
    const returned = await host.switchSession("session-a");
    assert.equal(returned, initial);
    assert.equal(host.current(), initial);
    assert.deepEqual(opener.calls, []);
    assert.equal(initialController.calls.close, 0);
  });

  it("leaves the current session usable when the opener fails", async () => {
    const { host, initial, initialController, opener } = fixture();
    opener.failNext("session-b", new Error("provider configuration is broken"));
    await assert.rejects(host.switchSession("session-b"), isWebSessionError("session_open_failed"));
    assert.equal(host.current(), initial);
    assert.equal(initialController.calls.close, 0);
    assert.equal(host.isSwitching(), false);
    // The failed switch must not poison the queue: the next one still works.
    const recovered = await host.switchSession(null);
    assert.equal(host.current(), recovered);
  });

  it("propagates not_found from the opener instead of hiding it", async () => {
    const { host, initial, opener } = fixture();
    opener.failNext(
      "session-missing",
      Object.assign(new Error("unknown session session-missing"), { code: "not_found" }),
    );
    await assert.rejects(host.switchSession("session-missing"), isWebSessionError("not_found"));
    assert.equal(host.current(), initial);
  });

  it("refuses to switch after close", async () => {
    const { host } = fixture();
    await host.close();
    await assert.rejects(host.switchSession("session-b"), isWebSessionError("unavailable"));
  });
});

describe("createWebSessionHost: the session catalog", () => {
  it("lists sessions with only the current row marked, and caches within the TTL", async () => {
    let clock = 1_000_000;
    const { host, catalog } = fixture({ clock: { now: () => clock } });

    const first = await host.listSessions();
    assert.equal(catalog.listCalls, 1);
    assert.deepEqual(
      first.map((entry: WebSessionListEntry) => [entry.sessionId, entry.current]),
      [
        ["session-b", false],
        ["session-c", false],
      ],
    );

    // Still inside the 1s TTL: no second read, even though the directory changed.
    catalog.entries.push({ ...LIST[0]!, sessionId: "session-d" });
    clock += 50;
    const cached = await host.listSessions();
    assert.equal(catalog.listCalls, 1);
    assert.deepEqual(cached, first);

    // Past the TTL the list is re-read and the new row appears.
    clock += 2_000;
    const refreshed = await host.listSessions();
    assert.equal(catalog.listCalls, 2);
    assert.deepEqual(
      refreshed.map((entry) => entry.sessionId),
      ["session-b", "session-c", "session-d"],
    );
  });

  it("marks the current session after a switch", async () => {
    const { host } = fixture();
    await host.switchSession("session-b");
    const listed = await host.listSessions();
    assert.deepEqual(
      listed.map((entry) => [entry.sessionId, entry.current]),
      [
        ["session-b", true],
        ["session-c", false],
      ],
    );
  });

  it("delegates rename and refreshes the listed title", async () => {
    const { host, catalog } = fixture();
    await host.renameSession("session-b", "Parser fix");
    assert.deepEqual(catalog.renamed, [{ sessionId: "session-b", title: "Parser fix" }]);
    const listed = await host.listSessions();
    assert.equal(listed.find((entry) => entry.sessionId === "session-b")?.title, "Parser fix");
  });

  it("delegates delete", async () => {
    const { host, catalog } = fixture();
    await host.deleteSession("session-c");
    assert.deepEqual(catalog.removed, ["session-c"]);
    const listed = await host.listSessions();
    assert.deepEqual(
      listed.map((entry) => entry.sessionId),
      ["session-b"],
    );
  });

  it("refuses to delete the current session as a conflict", async () => {
    const { host, catalog } = fixture();
    await assert.rejects(host.deleteSession("session-a"), isWebSessionError("conflict"));
    assert.deepEqual(catalog.removed, []);
  });

  it("maps a catalog failure to a WebSessionError code", async () => {
    const { host, catalog } = fixture();
    catalog.failNext("disk_unreadable");
    await assert.rejects(host.renameSession("session-b", "x"), isWebSessionError("catalog_failed"));
  });

  it("maps a rename of a missing session to not_found", async () => {
    const { host, catalog } = fixture();
    catalog.failNext("not_found");
    await assert.rejects(
      host.renameSession("session-missing", "x"),
      isWebSessionError("not_found"),
    );
  });
});

describe("createWebSessionHost: close", () => {
  it("closes the current controller exactly once, even when repeated", async () => {
    const { host, initialController } = fixture();
    await host.close();
    await host.close();
    assert.equal(initialController.calls.close, 1);
  });

  it("closes the runtime that is current after a switch", async () => {
    const nextController = createFakeController();
    const { host, initialController } = fixture({
      openSession: async () =>
        createFakeRuntime({ sessionId: "session-b", controller: nextController.controller }),
    });
    await host.switchSession("session-b");
    await host.close();
    assert.equal(initialController.calls.close, 1);
    assert.equal(nextController.calls.close, 1);
  });
});
