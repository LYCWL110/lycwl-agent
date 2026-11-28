import { homedir } from "node:os";
import path from "node:path";
export function linuxDirectories(environment = process.env) {
    const homeDirectory = environment["HOME"] || homedir();
    const configBase = environment["XDG_CONFIG_HOME"];
    const stateBase = environment["XDG_STATE_HOME"];
    return {
        config: path.join(configBase?.startsWith("/") ? configBase : path.join(homeDirectory, ".config"), "lycwl-agent"),
        state: path.join(stateBase?.startsWith("/") ? stateBase : path.join(homeDirectory, ".local", "state"), "lycwl-agent"),
    };
}
