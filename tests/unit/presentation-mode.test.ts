import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { presentationFromArgs } from "../../src/bootstrap/presentation-mode.ts";

describe("presentationFromArgs", () => {
  it("starts the terminal UI when no front end is named", () => {
    assert.equal(presentationFromArgs([]), "terminal");
    assert.equal(presentationFromArgs(["--read-only"]), "terminal");
    assert.equal(presentationFromArgs(["--resume", "session-id"]), "terminal");
  });

  it("selects the browser from the web subcommand", () => {
    assert.equal(presentationFromArgs(["web"]), "web");
    assert.equal(presentationFromArgs(["web", "--read-only"]), "web");
    assert.equal(presentationFromArgs(["web", "--web-port", "8787"]), "web");
  });

  it("keeps the historical flags", () => {
    assert.equal(presentationFromArgs(["--web"]), "web");
    assert.equal(presentationFromArgs(["--cli"]), "terminal");
  });

  it("only treats a leading web token as the subcommand", () => {
    assert.equal(presentationFromArgs(["--resume", "web"]), "terminal");
  });
});
