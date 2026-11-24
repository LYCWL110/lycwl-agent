import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { permissionModeFromArgs } from "../../src/bootstrap/permission-mode.ts";

describe("launch permission mode", () => {
  it("defaults to full permissions", () => {
    assert.equal(permissionModeFromArgs([]), "full");
  });

  it("opts out with --read-only", () => {
    assert.equal(permissionModeFromArgs(["--read-only"]), "read-only");
  });

  it("ignores the historical --write and --shell flags", () => {
    assert.equal(permissionModeFromArgs(["--write"]), "full");
    assert.equal(permissionModeFromArgs(["--shell"]), "full");
    assert.equal(permissionModeFromArgs(["--write", "--skills"]), "full");
  });

  it("keeps an explicit --read-only over historical flags", () => {
    assert.equal(permissionModeFromArgs(["--write", "--read-only", "--shell"]), "read-only");
  });

  it("ignores unrelated launch arguments", () => {
    assert.equal(permissionModeFromArgs(["--resume", "session-id", "--skills"]), "full");
  });
});
