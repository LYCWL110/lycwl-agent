import { createInterface } from "node:readline";
/**
 * Terminal approval for decisions that must be made before the TUI exists.
 *
 * Only MCP server startup uses this. Tool calls are approved inside the TUI, where
 * the Run is already suspended and the prompt is bound to a tool call id. A server
 * must be approved before its process is spawned, which is before the TUI mounts, so
 * it needs a channel that does not depend on the TUI.
 *
 * The default is denial: anything other than an explicit `y` refuses. An empty
 * answer, a closed stdin or a non-interactive terminal all deny, so a script that
 * happens to run `lycwl` cannot approve a server by accident.
 */
export function createTerminalApproval(options) {
    return {
        async decide(request) {
            options.write(`${request.safePreview}\n`);
            const answer = await (options.ask ?? askTerminal)("approve this server? [y/N] ");
            if (answer === null) {
                options.write("no answer; the server was not started\n");
                return "denied";
            }
            const normalized = answer.trim().toLowerCase();
            if (normalized === "y" || normalized === "yes") {
                options.write("approved for this launch only\n");
                return "approved";
            }
            options.write("denied; the server was not started\n");
            return "denied";
        },
    };
}
function askTerminal(question) {
    if (!process.stdin.isTTY)
        return Promise.resolve(null);
    return new Promise((resolve) => {
        const readline = createInterface({ input: process.stdin, output: process.stdout });
        let settled = false;
        readline.question(question, (answer) => {
            settled = true;
            readline.close();
            resolve(answer);
        });
        readline.once("close", () => {
            if (!settled)
                resolve(null);
        });
    });
}
/**
 * Read `mcp.servers` from a parsed settings document.
 *
 * Only this key is consulted. A project file cannot add a server: the settings
 * document lives under the user's application data directory, and nothing else is
 * read here.
 */
export function readMcpDeclarations(settings) {
    if (typeof settings !== "object" || settings === null)
        return undefined;
    const mcp = settings["mcp"];
    if (typeof mcp !== "object" || mcp === null)
        return undefined;
    return mcp["servers"];
}
