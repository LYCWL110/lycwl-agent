import { randomUUID } from "node:crypto";

export type SessionLaunch =
  | Readonly<{ ok: true; sessionId: string; mode: "new" | "resume" }>
  | Readonly<{ ok: false; code: "invalid_resume"; message: string }>;

/** A workspace is not a conversation; only explicit resume selects old history. */
export function selectSessionLaunch(
  args: readonly string[],
  createId: () => string = randomUUID,
): SessionLaunch {
  const index = args.indexOf("--resume");
  if (index === -1) return { ok: true, sessionId: createId(), mode: "new" };
  const id = args[index + 1];
  if (
    args.lastIndexOf("--resume") !== index ||
    id === undefined ||
    !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/u.test(id) ||
    /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])$/iu.test(id)
  ) {
    return {
      ok: false,
      code: "invalid_resume",
      message: "Use --resume <session-id> with the ID printed by an earlier launch.",
    };
  }
  return { ok: true, sessionId: id, mode: "resume" };
}
