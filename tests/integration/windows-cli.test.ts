import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { copyFile, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { promisify } from "node:util";

const execute = promisify(execFile);
const repository = path.resolve(import.meta.dirname, "../..");

describe("Windows packaged launcher", { skip: process.platform !== "win32" }, () => {
  it("uses the shipped dist and forwards arguments and exit codes", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "lycwl cli "));
    try {
      await copyFile(path.join(repository, "lycwl.cmd"), path.join(directory, "lycwl.cmd"));
      await symlink(path.join(repository, "dist"), path.join(directory, "dist"), "junction");
      const launch = (args: string) =>
        execute("cmd.exe", ["/d", "/c", `lycwl.cmd ${args}`], {
          cwd: directory,
          env: { ...process.env, LOCALAPPDATA: directory },
        });
      const help = await launch("--read-only --help");
      assert.match(help.stdout, /Windows user permissions/);
      assert.match(help.stdout, /lycwl --search-key/);
      const setup = await launch("--setup");
      assert.ok(setup.stdout.includes(path.join(directory, "lycwl-agent", "config")));
      assert.match(setup.stdout, /search:\s+not configured/);
      await assert.rejects(launch('--resume "invalid session"'), (error: NodeJS.ErrnoException) => {
        assert.equal(error.code, 1);
        assert.match(String(error), /Use --resume <session-id>/);
        return true;
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
