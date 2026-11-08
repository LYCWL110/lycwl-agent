import { mkdir } from "node:fs/promises";
import path from "node:path";
import { CloseHandle, CreateFileW, GetLastError } from "./koffi-bindings.ts";

export type ExclusiveFileLease = Readonly<{ release: () => void }>;

/**
 * The open HANDLE owns the lock, not the lock file's existence. Windows releases
 * it on process death; deleting a stale pathname could split live owners.
 */
export async function acquireExclusiveFileLease(
  filePath: string,
  options: Readonly<{
    timeoutMs?: number;
    now?: () => number;
    sleep?: (ms: number) => Promise<void>;
  }> = {},
): Promise<ExclusiveFileLease> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const deadline = now() + (options.timeoutMs ?? 2_000);
  for (;;) {
    const handle: unknown = CreateFileW(filePath, 0xc0000000, 0, null, 4, 0x80, null);
    if (handle !== null && handle !== -1n && handle !== 0xffffffffffffffffn) {
      let released = false;
      return {
        release: () => {
          if (released) return;
          if (!CloseHandle(handle)) throw new Error("lock_release_failed");
          released = true;
        },
      };
    }
    const code: number = GetLastError();
    if (code !== 32 && code !== 33) throw new Error("lock_unavailable");
    if (now() >= deadline) throw new Error("lock_busy");
    await sleep(25);
  }
}
