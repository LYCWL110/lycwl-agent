import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { selectSessionLaunch } from "../../src/bootstrap/session-launch.ts";

describe("launch conversation selection", () => {
  it("creates a different conversation for each ordinary launch", () => {
    const first = selectSessionLaunch([]);
    const second = selectSessionLaunch([]);
    assert.ok(first.ok && second.ok);
    if (!first.ok || !second.ok) return;
    assert.equal(first.mode, "new");
    assert.equal(second.mode, "new");
    assert.notEqual(first.sessionId, second.sessionId);
  });

  it("keeps the explicitly requested conversation without creating another ID", () => {
    assert.deepEqual(
      selectSessionLaunch(["--write", "--resume", "ws-legacy123"], () => {
        throw new Error("must not create a new ID");
      }),
      { ok: true, mode: "resume", sessionId: "ws-legacy123" },
    );
  });

  for (const args of [
    ["--resume"],
    ["--resume", "--write"],
    ["--resume", "../other"],
    ["--resume", "D:\\other"],
    ["--resume", "CON"],
    ["--resume", "first", "--resume", "second"],
    ["--resume", "a".repeat(81)],
  ]) {
    it(`rejects an unsafe or ambiguous resume argument: ${JSON.stringify(args)}`, () => {
      assert.equal(selectSessionLaunch(args).ok, false);
    });
  }
});
