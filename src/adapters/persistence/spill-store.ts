import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import type { SpillStore } from "../../ports/spill-store.ts";

/**
 * Spill storage (ADR-0074).
 *
 * A spilled tool output is written under the Session's own directory, so deleting
 * the Session removes it and nothing leaks into a shared location. The file name is
 * derived from the tool call id, which is already a single safe token.
 *
 * Writes are immutable: a spill file is written once and never replaced. Two
 * attempts for the same call id would indicate a duplicate execution, and silently
 * overwriting would destroy the first result.
 */

export type SpillStoreOptions = Readonly<{
  /** The Session directory; spill files live in `spill/` under it. */
  sessionDirectory: string;
  /**
   * The workspace root, used to decide whether the spill path can be shown as a
   * workspace-relative reference. A path outside the workspace is not readable by
   * `read_file` without approval, so the preview must say so rather than promise it.
   */
  workspaceRoot: string;
}>;

/** A tool call id is a UUID-like token; reject anything with path meaning. */
function safeSegment(value: string): string | null {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/u.test(value)) return null;
  if (value === "." || value === "..") return null;
  return value;
}

export function createSpillStore(options: SpillStoreOptions): SpillStore {
  const directory = path.join(options.sessionDirectory, "spill");

  return {
    async spill(input) {
      const segment = safeSegment(input.toolCallId);
      if (segment === null) return { reference: null, readable: false };

      const filePath = path.join(directory, `${segment}.txt`);
      try {
        await mkdir(directory, { recursive: true });
        // `wx` fails when the file exists, which is what makes this immutable.
        await writeFile(filePath, input.text, { encoding: "utf8", flag: "wx" });
      } catch {
        // Storage failure keeps the text inline rather than losing it.
        return { reference: null, readable: false };
      }

      // A reference is only useful if the model can read it. Inside the workspace
      // that is a relative path; outside, the absolute path is still reported so a
      // human can find it, but the preview must not claim `read_file` will work
      // without approval.
      const relative = path.relative(options.workspaceRoot, filePath);
      const inside = !relative.startsWith("..") && !path.isAbsolute(relative);
      return {
        reference: inside ? relative.split(path.sep).join("/") : filePath,
        readable: inside,
      };
    },
  };
}
