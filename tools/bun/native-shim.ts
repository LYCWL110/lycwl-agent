import target from "lycwl:native";
import { createHash } from "node:crypto";
import { lstat, mkdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * Makes the bundled Koffi native module loadable.
 *
 * `bun build --compile` can embed a `.node` file, but `require` cannot load one
 * from the `/$bunfs` virtual filesystem. Koffi looks for its binary under
 * `process.resourcesPath`, so the embedded bytes are written to a real directory
 * first and that path is pointed at the copy.
 *
 * This runs as a module side effect rather than an exported function because
 * import order is the only thing that guarantees it happens before
 * `koffi.load`; `entry.ts` imports this module first for that reason.
 *
 * Running from source is a no-op: Koffi resolves its own native module there.
 */

type EmbeddedFile = Readonly<{
  name: string;
  arrayBuffer: () => Promise<ArrayBuffer>;
}>;

const runtime = globalThis as { Bun?: { embeddedFiles?: readonly EmbeddedFile[] } };
const embeddedFiles = runtime.Bun?.embeddedFiles;

if (embeddedFiles !== undefined) {
  const name = path.basename(target.file);
  const embedded = embeddedFiles.find((file) => file.name === name);
  if (embedded === undefined) {
    throw new Error(`the compiled binary is missing its native module: ${name}`);
  }

  const bytes = Buffer.from(await embedded.arrayBuffer());
  // The digest keys the directory, so an upgraded binary never reuses a native
  // module left behind by an older one.
  const digest = createHash("sha256").update(bytes).digest("hex").slice(0, 16);
  const user = process.platform === "win32" ? "win" : String(process.getuid?.() ?? "user");
  const base = path.join(tmpdir(), `lycwl-agent-native-${user}`);
  await mkdir(base, { recursive: true, mode: 0o700 });
  await assertOwned(base);

  const directory = path.join(base, `${target.triplet}-${digest}`);
  const file = path.join(directory, "koffi", target.triplet, "koffi.node");
  if (!(await hasBytes(file, bytes.length))) {
    await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    // Write then rename: a concurrent process must never observe a partially
    // written module, and it may be loading this path at the same time.
    const temporary = `${file}.${process.pid}.tmp`;
    await writeFile(temporary, bytes, { mode: 0o600 });
    try {
      await rename(temporary, file);
    } catch (error) {
      if (!(await hasBytes(file, bytes.length))) throw error;
      await rm(temporary, { force: true });
    }
  }

  (process as unknown as { resourcesPath?: string }).resourcesPath = directory;
}

/**
 * Refuses a shared directory that another user could have planted.
 *
 * `tmpdir()` is world-writable on POSIX, so an attacker could pre-create this
 * path and control what gets loaded. The name is scoped to the current uid and
 * the directory must actually be one.
 */
async function assertOwned(directory: string): Promise<void> {
  const info = await lstat(directory);
  if (!info.isDirectory()) {
    throw new Error(`native module path is not a directory: ${directory}`);
  }
  const uid = process.getuid?.();
  if (uid !== undefined && info.uid !== uid) {
    throw new Error(`native module path belongs to another user: ${directory}`);
  }
}

async function hasBytes(file: string, size: number): Promise<boolean> {
  try {
    return (await stat(file)).size === size;
  } catch {
    return false;
  }
}
