/**
 * Launch presentation.
 *
 * The terminal UI is the default. `lycwl web` selects the browser front end;
 * `--web` remains an explicit alias for scripts written against the first web
 * build. `--cli` is accepted for compatibility but no longer changes anything.
 */
export type Presentation = "terminal" | "web";

export function presentationFromArgs(args: readonly string[]): Presentation {
  return args[0] === "web" || args.includes("--web") ? "web" : "terminal";
}
