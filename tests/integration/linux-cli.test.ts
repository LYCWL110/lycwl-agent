import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access, mkdir, mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { promisify } from "node:util";

const execute = promisify(execFile);
const repository = path.resolve(import.meta.dirname, "../..");

describe("Linux lycwl command", { skip: process.platform !== "linux" }, () => {
  let directory = "";
  let workspace = "";
  let environment: NodeJS.ProcessEnv;

  before(async () => {
    directory = await mkdtemp(path.join(tmpdir(), "lycwl-cli-"));
    workspace = path.join(directory, "workspace with spaces");
    const bin = path.join(directory, "bin");
    await mkdir(workspace);
    await mkdir(bin);
    const manifest = JSON.parse(await readFile(path.join(repository, "package.json"), "utf8"));
    assert.equal(manifest.bin.lycwl, "./dist/bootstrap/main.js");
    const entry = path.resolve(repository, manifest.bin.lycwl);
    await access(entry, constants.X_OK);
    await symlink(entry, path.join(bin, "lycwl"));
    await symlink(process.execPath, path.join(bin, "node"));
    environment = {
      ...process.env,
      PATH: `${bin}${path.delimiter}${process.env["PATH"] ?? ""}`,
      XDG_CONFIG_HOME: path.join(directory, "config with spaces"),
      XDG_STATE_HOME: path.join(directory, "state with spaces"),
    };
  });

  after(async () => {
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  it("resolves lycwl on PATH and forwards options from a different workspace", async () => {
    const version = await execute("lycwl", ["--version"], {
      cwd: workspace,
      env: environment,
      timeout: 10_000,
    });
    assert.equal(version.stdout.trim(), "lycwl-agent 0.1.0");
    const help = await execute("lycwl", ["--read-only", "--skills", "--help"], {
      cwd: workspace,
      env: environment,
      timeout: 10_000,
    });
    assert.match(help.stdout, /lycwl --read-only/);
    assert.match(help.stdout, /lycwl web\s+start the browser UI/);
    assert.match(help.stdout, /Writes, shell and web are enabled by default/);
    assert.match(help.stdout, /lycwl --resume ID/);
    assert.match(help.stdout, /lycwl --search-key/);
    assert.match(help.stdout, /Linux user permissions/);
  });

  it("uses Linux configuration paths with spaces through lycwl --setup", async () => {
    const result = await execute("lycwl", ["--setup"], {
      cwd: workspace,
      env: environment,
      timeout: 10_000,
    });
    assert.ok(
      result.stdout.includes(
        path.join(directory, "config with spaces", "lycwl-agent", "settings.jsonc"),
      ),
    );
    assert.match(result.stdout, /status: config_missing/);
    await assert.rejects(access(path.join(directory, "config with spaces")), { code: "ENOENT" });
  });

  it("preserves the invalid resume error and exit status", async () => {
    await assert.rejects(
      execute("lycwl", ["--resume", "bad session id"], {
        cwd: workspace,
        env: environment,
        timeout: 10_000,
      }),
      (error) => {
        const failure = error as Error & { code: number; stderr: string };
        assert.equal(failure.code, 1);
        assert.match(failure.stderr, /Use --resume <session-id>/);
        return true;
      },
    );
  });

  it("requires a terminal in both permission modes", async () => {
    for (const args of [[], ["--read-only"]]) {
      await assert.rejects(
        execute("lycwl", args, { cwd: workspace, env: environment, timeout: 10_000 }),
        (error) => {
          const failure = error as Error & { code: number; stderr: string };
          assert.equal(failure.code, 1);
          assert.match(failure.stderr, /lycwl requires an interactive terminal/);
          return true;
        },
      );
    }
  });
});
