export function presentationFromArgs(args) {
    return args[0] === "web" || args.includes("--web") ? "web" : "terminal";
}
