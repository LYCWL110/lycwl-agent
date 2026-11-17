import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { it } from "node:test";
import { acquireExclusiveFileLease } from "../../src/adapters/platform-file-lease.ts";

it("excludes a second process and releases native Session ownership on process death", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "lycwl-native-lease-"));
  const file = path.join(root, "owner.lock");
  const source = `
    import { acquireExclusiveFileLease } from ${JSON.stringify(
      new URL("../../src/adapters/platform-file-lease.ts", import.meta.url).href,
    )};
    await acquireExclusiveFileLease(${JSON.stringify(file)}, { timeoutMs: 0 });
    process.stdout.write("owned");
    setInterval(() => {}, 1000);
  `;
  const child = spawn(process.execPath, ["--input-type=module", "-e", source], {
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      SystemRoot: process.env["SystemRoot"] ?? "C:\\Windows",
      TEMP: tmpdir(),
    },
  });
  try {
    await Promise.race([
      once(child.stdout, "data").then(([data]) => assert.equal(String(data), "owned")),
      once(child, "exit").then(() => {
        throw new Error("owner exited before acquiring lease");
      }),
    ]);
    await assert.rejects(acquireExclusiveFileLease(file, { timeoutMs: 0 }), /lock_busy/u);
    const exited = once(child, "exit");
    child.kill();
    await exited;
    const recovered = await acquireExclusiveFileLease(file, { timeoutMs: 0 });
    recovered.release();
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit");
      child.kill();
      await exited;
    }
    await rm(root, { recursive: true, force: true });
  }
});
