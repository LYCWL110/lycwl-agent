import { closeSync, constants, openSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import koffi from "koffi";
const flock = koffi.load(null).func("int flock(int fd, int operation)");
const LOCK_EX = 2;
const LOCK_NB = 4;
export async function acquireExclusiveFileLease(filePath, options = {}) {
    await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
    const now = options.now ?? Date.now;
    const sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    const deadline = now() + (options.timeoutMs ?? 2_000);
    const fd = openSync(filePath, constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
    let retained = false;
    try {
        for (;;) {
            if (flock(fd, LOCK_EX | LOCK_NB) === 0) {
                retained = true;
                let released = false;
                return {
                    release() {
                        if (released)
                            return;
                        closeSync(fd);
                        released = true;
                    },
                };
            }
            if (koffi.errno() !== koffi.os.errno["EAGAIN"])
                throw new Error("lock_unavailable");
            if (now() >= deadline)
                throw new Error("lock_busy");
            await sleep(25);
        }
    }
    finally {
        if (!retained)
            closeSync(fd);
    }
}
