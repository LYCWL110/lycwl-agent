import { randomUUID } from "node:crypto";
import { lstat } from "node:fs/promises";
import path from "node:path";
import { isSessionId } from "../domain/identity/session-id.js";
/** A workspace is not a conversation; only explicit resume selects old history. */
export function selectSessionLaunch(args, createId = randomUUID) {
    const index = args.indexOf("--resume");
    if (index === -1)
        return { ok: true, sessionId: createId(), mode: "new" };
    const id = args[index + 1];
    if (args.lastIndexOf("--resume") !== index || id === undefined || !isSessionId(id)) {
        return {
            ok: false,
            code: "invalid_resume",
            message: "Use --resume <session-id> with the ID printed by an earlier launch.",
        };
    }
    return { ok: true, sessionId: id, mode: "resume" };
}
/** Inspect the existing log layout without loading transcript text or creating records. */
export async function canResumeSession(dataDirectory, sessionId) {
    if (!isSessionId(sessionId))
        return false;
    try {
        let directory = dataDirectory;
        for (const segment of ["sessions", "sessions", sessionId]) {
            directory = path.join(directory, segment);
            const info = await lstat(directory);
            if (!info.isDirectory() || info.isSymbolicLink())
                return false;
        }
        const info = await lstat(path.join(directory, "events.jsonl"));
        return info.isFile() && !info.isSymbolicLink() && info.size > 0;
    }
    catch (error) {
        if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT")
            return false;
        throw error;
    }
}
