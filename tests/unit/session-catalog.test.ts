import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { createSessionCatalog } from "../../src/adapters/windows/session-catalog.ts";
import {
  firstInputFromHead,
  readSidecarTitle,
  serializeSidecar,
  sessionLabel,
  validateSessionTitle,
} from "../../src/domain/session/session-catalog.ts";

/**
 * Real directories, real files.
 *
 * The catalog's whole job is filesystem behaviour, so mocking the filesystem would
 * test the mock. The layout written here is the one the event log and checkpoint
 * store already use.
 */

function session(
  root: string,
  id: string,
  options: { input?: string; title?: string; at?: string } = {},
): string {
  const directory = path.join(root, "sessions", "sessions", id);
  mkdirSync(directory, { recursive: true });
  const event = {
    timestampUtc: options.at ?? "2026-01-01T00:00:00.000Z",
    payload: { kind: "run_started", input: options.input ?? "do the thing" },
  };
  writeFileSync(path.join(directory, "events.jsonl"), `${JSON.stringify(event)}\n`, "utf8");
  if (options.title !== undefined) {
    writeFileSync(
      path.join(directory, "session.json"),
      serializeSidecar(options.title, "2026-01-01T00:00:00.000Z"),
      "utf8",
    );
  }
  return directory;
}

function catalog(dataDirectory: string) {
  return createSessionCatalog({ dataDirectory });
}

describe("validateSessionTitle", () => {
  it("accepts an ordinary title", () => {
    assert.deepEqual(validateSessionTitle("  Fix the parser  "), {
      ok: true,
      title: "Fix the parser",
    });
  });

  it("rejects an empty title", () => {
    assert.equal(validateSessionTitle("   ").ok, false);
  });

  it("rejects a title containing a newline", () => {
    // A newline would break the single row it is rendered in.
    assert.equal(validateSessionTitle("line one\nline two").ok, false);
  });

  it("rejects an over-long title", () => {
    assert.equal(validateSessionTitle("x".repeat(81)).ok, false);
  });
});

describe("sessionLabel", () => {
  const base = {
    sessionId: "abc",
    title: null,
    firstInput: null,
    bytes: 1,
    modifiedAtUtc: "2026-01-01T00:00:00.000Z",
  };

  it("prefers the title", () => {
    assert.equal(sessionLabel({ ...base, title: "Named", firstInput: "task" }), "Named");
  });

  it("falls back to the first task", () => {
    assert.equal(sessionLabel({ ...base, firstInput: "fix the bug" }), "fix the bug");
  });

  it("collapses whitespace in a multi-line task", () => {
    assert.equal(sessionLabel({ ...base, firstInput: "fix\n\nthe   bug" }), "fix the bug");
  });

  it("truncates a long task", () => {
    const label = sessionLabel({ ...base, firstInput: "x".repeat(200) });
    assert.equal(label.length, 60);
    assert.equal(label.endsWith("…"), true);
  });

  it("falls back to the id", () => {
    assert.equal(sessionLabel(base), "abc");
  });
});

describe("firstInputFromHead", () => {
  it("finds the first run_started", () => {
    const head = [
      JSON.stringify({ payload: { kind: "run_started", input: "first" } }),
      JSON.stringify({ payload: { kind: "run_started", input: "second" } }),
    ].join("\n");
    assert.equal(firstInputFromHead(head), "first");
  });

  it("ignores a truncated final line", () => {
    const head = `${JSON.stringify({ payload: { kind: "run_started", input: "ok" } })}\n{"payl`;
    assert.equal(firstInputFromHead(head), "ok");
  });

  it("returns null when there is no run_started", () => {
    assert.equal(
      firstInputFromHead(`${JSON.stringify({ payload: { kind: "run_completed" } })}\n`),
      null,
    );
  });

  it("returns null for empty input", () => {
    assert.equal(firstInputFromHead(""), null);
  });
});

describe("readSidecarTitle", () => {
  it("reads a title", () => {
    assert.equal(readSidecarTitle(serializeSidecar("Named", "2026-01-01T00:00:00.000Z")), "Named");
  });

  it("treats a damaged sidecar as no title", () => {
    assert.equal(readSidecarTitle("{ not json"), null);
  });

  it("treats an invalid title as no title", () => {
    assert.equal(readSidecarTitle(JSON.stringify({ title: "" })), null);
  });
});

describe("session catalog", () => {
  it("returns an empty catalog when nothing exists", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "sessions-"));
    assert.deepEqual(await catalog(root).list(), { ok: true, sessions: [] });
  });

  it("lists a session with its derived label", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "sessions-"));
    session(root, "aaa", { input: "fix the parser" });
    const listed = await catalog(root).list();
    assert.equal(listed.ok, true);
    const sessions = listed.ok ? listed.sessions : [];
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0]?.sessionId, "aaa");
    assert.equal(sessions[0]?.firstInput, "fix the parser");
    assert.equal(sessions[0]?.title, null);
  });

  it("skips a directory with no log, and an empty log", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "sessions-"));
    const empty = path.join(root, "sessions", "sessions", "empty");
    mkdirSync(empty, { recursive: true });
    writeFileSync(path.join(empty, "events.jsonl"), "", "utf8");
    mkdirSync(path.join(root, "sessions", "sessions", "nolog"), { recursive: true });
    session(root, "real");

    const listed = await catalog(root).list();
    const ids = listed.ok ? listed.sessions.map((entry) => entry.sessionId) : [];
    assert.deepEqual(ids, ["real"]);
  });

  it("skips a directory whose name is not a valid session id", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "sessions-"));
    session(root, "good");
    const bad = path.join(root, "sessions", "sessions", "bad name");
    mkdirSync(bad, { recursive: true });
    writeFileSync(path.join(bad, "events.jsonl"), "{}\n", "utf8");

    const listed = await catalog(root).list();
    const ids = listed.ok ? listed.sessions.map((entry) => entry.sessionId) : [];
    assert.deepEqual(ids, ["good"]);
  });

  it("orders newest first by recorded activity", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "sessions-"));
    session(root, "older", { at: "2026-01-01T00:00:00.000Z" });
    session(root, "newer", { at: "2026-05-05T00:00:00.000Z" });

    const listed = await catalog(root).list();
    const ids = listed.ok ? listed.sessions.map((entry) => entry.sessionId) : [];
    assert.deepEqual(ids, ["newer", "older"]);
  });

  it("orders by event time even when file mtimes disagree", async () => {
    // The real hazard: copying or restoring a data directory rewrites every mtime,
    // so a copy made today would make every session look like today's work. The
    // recorded event time is what actually happened.
    const root = mkdtempSync(path.join(tmpdir(), "sessions-"));
    const older = session(root, "older", { at: "2026-01-01T00:00:00.000Z" });
    const newer = session(root, "newer", { at: "2026-05-05T00:00:00.000Z" });
    const { utimesSync } = await import("node:fs");
    const now = new Date();
    utimesSync(path.join(older, "events.jsonl"), now, now);
    const past = new Date("2020-01-01T00:00:00.000Z");
    utimesSync(path.join(newer, "events.jsonl"), past, past);

    const listed = await catalog(root).list();
    const ids = listed.ok ? listed.sessions.map((entry) => entry.sessionId) : [];
    assert.deepEqual(ids, ["newer", "older"]);
  });

  it("reports the newest event time, not the file time", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "sessions-"));
    const directory = session(root, "aaa", { at: "2026-02-03T04:05:06.000Z" });
    const lines = [
      JSON.stringify({
        timestampUtc: "2026-02-03T04:05:06.000Z",
        payload: { kind: "run_started", input: "x" },
      }),
      JSON.stringify({
        timestampUtc: "2026-09-09T10:11:12.000Z",
        payload: { kind: "run_completed" },
      }),
    ];
    writeFileSync(path.join(directory, "events.jsonl"), `${lines.join("\n")}\n`, "utf8");

    const listed = await catalog(root).list();
    assert.equal(listed.ok ? listed.sessions[0]?.modifiedAtUtc : null, "2026-09-09T10:11:12.000Z");
  });

  it("falls back to the file time when no event has a timestamp", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "sessions-"));
    const directory = path.join(root, "sessions", "sessions", "legacy");
    mkdirSync(directory, { recursive: true });
    writeFileSync(
      path.join(directory, "events.jsonl"),
      `${JSON.stringify({ payload: { kind: "run_started", input: "old format" } })}\n`,
      "utf8",
    );
    const listed = await catalog(root).list();
    const entry = listed.ok ? listed.sessions[0] : undefined;
    assert.equal(entry?.sessionId, "legacy");
    // Any parseable ISO time is acceptable; what matters is that one is present.
    assert.equal(Number.isFinite(Date.parse(entry?.modifiedAtUtc ?? "")), true);
  });

  it("sorts a session with no readable time last", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "sessions-"));
    session(root, "known", { at: "2026-01-01T00:00:00.000Z" });
    const unknown = path.join(root, "sessions", "sessions", "unknown");
    mkdirSync(unknown, { recursive: true });
    writeFileSync(
      path.join(unknown, "events.jsonl"),
      `${JSON.stringify({ payload: { kind: "run_started", input: "no time" } })}\n`,
      "utf8",
    );
    const { utimesSync } = await import("node:fs");
    // Give it a very old mtime so the fallback cannot accidentally sort it first.
    const ancient = new Date("1990-01-01T00:00:00.000Z");
    utimesSync(path.join(unknown, "events.jsonl"), ancient, ancient);

    const listed = await catalog(root).list();
    const ids = listed.ok ? listed.sessions.map((entry) => entry.sessionId) : [];
    assert.deepEqual(ids, ["known", "unknown"]);
  });

  it("renames a session", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "sessions-"));
    const directory = session(root, "aaa");
    const renamed = await catalog(root).rename("aaa", "My session");
    assert.deepEqual(renamed, { ok: true });
    assert.equal(
      readFileSync(path.join(directory, "session.json"), "utf8").includes("My session"),
      true,
    );

    const listed = await catalog(root).list();
    assert.equal(listed.ok ? listed.sessions[0]?.title : null, "My session");
  });

  it("refuses an invalid title without writing", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "sessions-"));
    const directory = session(root, "aaa");
    const renamed = await catalog(root).rename("aaa", "bad\ntitle");
    assert.deepEqual(renamed, { ok: false, code: "invalid_title" });
    assert.equal(existsSync(path.join(directory, "session.json")), false);
  });

  it("reports an unknown session on rename", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "sessions-"));
    assert.deepEqual(await catalog(root).rename("absent", "x"), {
      ok: false,
      code: "session_not_found",
    });
  });

  it("refuses a path-traversal session id", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "sessions-"));
    session(root, "aaa");
    for (const id of ["..", "../aaa", "a/b", "con"]) {
      const renamed = await catalog(root).rename(id, "x");
      assert.deepEqual(renamed, { ok: false, code: "invalid_session_id" }, id);
    }
  });

  it("deletes a session and everything in its directory", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "sessions-"));
    const directory = session(root, "aaa");
    mkdirSync(path.join(directory, "attachments"), { recursive: true });
    writeFileSync(path.join(directory, "attachments", "blob"), "x", "utf8");

    assert.deepEqual(await catalog(root).remove("aaa"), { ok: true });
    assert.equal(existsSync(directory), false);
    const listed = await catalog(root).list();
    assert.deepEqual(listed.ok ? listed.sessions : null, []);
  });

  it("refuses to delete a session that is in use", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "sessions-"));
    const directory = session(root, "aaa");
    // Hold the ownership lease exactly as a live runtime does.
    const { acquireExclusiveFileLease } = await import("../../src/adapters/platform-file-lease.ts");
    const lease = await acquireExclusiveFileLease(path.join(directory, "session.lock"), {
      timeoutMs: 0,
    });
    try {
      assert.deepEqual(await catalog(root).remove("aaa"), { ok: false, code: "session_in_use" });
      assert.equal(existsSync(path.join(directory, "events.jsonl")), true);
    } finally {
      lease.release();
    }
    // Once released, the delete succeeds.
    assert.deepEqual(await catalog(root).remove("aaa"), { ok: true });
  });

  it("reports an unknown session on delete", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "sessions-"));
    assert.deepEqual(await catalog(root).remove("absent"), {
      ok: false,
      code: "session_not_found",
    });
  });

  it("reads only the head of a large log", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "sessions-"));
    const directory = path.join(root, "sessions", "sessions", "big");
    mkdirSync(directory, { recursive: true });
    // A first task, then a lot of noise, so a full read would be wasteful.
    const lines = [JSON.stringify({ payload: { kind: "run_started", input: "the first task" } })];
    for (let index = 0; index < 5000; index += 1) {
      lines.push(JSON.stringify({ payload: { kind: "run_completed", padding: "x".repeat(80) } }));
    }
    writeFileSync(path.join(directory, "events.jsonl"), `${lines.join("\n")}\n`, "utf8");

    const listed = await catalog(root).list();
    assert.equal(listed.ok ? listed.sessions[0]?.firstInput : null, "the first task");
  });
});
