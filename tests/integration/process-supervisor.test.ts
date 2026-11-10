import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createProcessSupervisor } from "../../src/adapters/windows/process-supervisor.ts";

const supervisor = createProcessSupervisor();
const CWD = process.cwd();
/**
 * The supervisor no longer inherits the parent environment, so each test passes
 * an explicit one. This is also the shape the C09 filter produces.
 */
const ENV: Readonly<Record<string, string>> = {
  PATH: process.env["PATH"] ?? "",
  SYSTEMROOT: process.env["SYSTEMROOT"] ?? "",
  COMSPEC: process.env["COMSPEC"] ?? "",
};

describe("G02 process supervisor", () => {
  it("runs a command to completion and reports output", async () => {
    const result = await supervisor.runToCompletion({
      command: "echo hello",
      cwd: CWD,
      environment: ENV,
      timeoutMs: 15_000,
    });

    assert.equal(result.kind, "completed");
    if (result.kind !== "completed") return;
    assert.equal(result.exitCode, 0);
    assert.match(result.stdout, /hello/i);
    assert.equal(result.timedOut, false);
  });

  it("reports a non-zero exit without hiding output", async () => {
    const result = await supervisor.runToCompletion({
      command: "Write-Output 'before'; exit 3",
      cwd: CWD,
      environment: ENV,
      timeoutMs: 15_000,
    });

    assert.equal(result.kind, "completed");
    if (result.kind !== "completed") return;
    assert.equal(result.exitCode, 3);
    assert.match(result.stdout, /before/i);
  });

  it("captures stderr separately", async () => {
    const result = await supervisor.runToCompletion({
      command: "Write-Error 'problem'",
      cwd: CWD,
      environment: ENV,
      timeoutMs: 15_000,
    });

    assert.equal(result.kind, "completed");
    if (result.kind !== "completed") return;
    assert.match(result.stderr, /problem/i);
  });

  it("terminates the tree on timeout and reports partial output", async () => {
    const result = await supervisor.runToCompletion({
      command: "Write-Output 'started'; Start-Sleep -Seconds 30",
      cwd: CWD,
      environment: ENV,
      timeoutMs: 1_500,
    });

    assert.equal(result.kind, "completed");
    if (result.kind !== "completed") return;
    assert.equal(result.timedOut, true);
    assert.match(result.stdout, /started/i);
  });

  it("fails explicitly for a missing working directory", async () => {
    const result = await supervisor.runToCompletion({
      command: "echo x",
      cwd: "D:\\definitely-not-a-real-directory-xyz",
      environment: ENV,
      timeoutMs: 5_000,
    });

    assert.equal(result.kind, "failed");
    if (result.kind !== "failed") return;
    assert.equal(result.code, "process_create_failed");
  });
});

describe("G02 race runs", () => {
  it("runs 100 timeout races without leaking or hanging", async () => {
    const results: boolean[] = [];
    for (let batch = 0; batch < 10; batch += 1) {
      const races: Promise<boolean>[] = [];
      for (let index = 0; index < 10; index += 1)
        races.push(
          supervisor
            .runToCompletion({
              command: "Start-Sleep -Seconds 20",
              cwd: CWD,
              environment: ENV,
              // Alternate between an aggressive and a slightly slower timeout.
              timeoutMs: 200 + (index % 4) * 100,
            })
            .then((result) => result.kind === "completed" && result.timedOut),
        );
      results.push(...(await Promise.all(races)));
    }
    assert.equal(results.length, 100);
    assert.equal(
      results.every((timedOut) => timedOut === true),
      true,
    );
  });

  it("runs 100 fast completions under supervision", async () => {
    const results: boolean[] = [];
    for (let batch = 0; batch < 10; batch += 1) {
      const runs: Promise<boolean>[] = [];
      for (let index = 0; index < 10; index += 1)
        runs.push(
          supervisor
            .runToCompletion({
              command: `echo run-${index}`,
              cwd: CWD,
              environment: ENV,
              timeoutMs: 15_000,
            })
            .then(
              (result) => result.kind === "completed" && result.exitCode === 0 && !result.timedOut,
            ),
        );
      results.push(...(await Promise.all(runs)));
    }
    assert.equal(
      results.every((ok) => ok === true),
      true,
    );
  });
});
