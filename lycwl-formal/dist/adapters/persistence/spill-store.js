import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
/** A tool call id is a UUID-like token; reject anything with path meaning. */
function safeSegment(value) {
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/u.test(value))
        return null;
    if (value === "." || value === "..")
        return null;
    return value;
}
export function createSpillStore(options) {
    const directory = path.join(options.sessionDirectory, "spill");
    return {
        async spill(input) {
            const segment = safeSegment(input.toolCallId);
            if (segment === null)
                return { reference: null, readable: false };
            const filePath = path.join(directory, `${segment}.txt`);
            try {
                await mkdir(directory, { recursive: true });
                // `wx` fails when the file exists, which is what makes this immutable.
                await writeFile(filePath, input.text, { encoding: "utf8", flag: "wx" });
            }
            catch {
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
