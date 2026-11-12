/**
 * Shell command risk annotation.
 *
 * Every shell command already requires one-shot approval, so the question is not
 * "may this run" but "can the user see what it will do". A compound command hides
 * its destructive part inside a longer line:
 *
 *     Get-Content a.txt; Remove-Item -Recurse C:\important
 *
 * The approval preview shows that line verbatim, and nothing marks which part
 * matters. A user scanning before pressing yes has to read the whole thing and
 * notice the second statement.
 *
 * This module annotates rather than blocks. Blocking would duplicate the approval
 * decision the user is already making, and a false positive would refuse a command
 * the user wanted. Annotation is a display aid: it says "look here", and the user
 * still decides.
 *
 * The patterns are deliberately coarse. This is not a sandbox and does not claim to
 * detect every dangerous command; it flags the constructs whose effect is easy to
 * miss when scanning, which is a different and narrower goal.
 */

export type RiskCategory =
  /** Deletes files, directories or registry keys. */
  | "deletion"
  /** Formats or overwrites a volume or disk. */
  | "destruction"
  /** Stops or kills processes. */
  | "process_termination"
  /** Sends data to a remote host. */
  | "network_egress"
  /** Runs code that was itself assembled at runtime. */
  | "dynamic_execution"
  /** Changes access control or elevates. */
  | "privilege_change"
  /** Rewrites history or discards uncommitted work. */
  | "history_rewrite";

export type RiskFinding = Readonly<{
  category: RiskCategory;
  /** The construct that matched, for the user to see. */
  construct: string;
  /** What it can do, in one clause. */
  effect: string;
}>;

type Pattern = Readonly<{
  category: RiskCategory;
  /** Matched case-insensitively against the command text. */
  pattern: RegExp;
  construct: string;
  effect: string;
}>;

/**
 * Constructs whose effect is easy to miss when scanning a long line.
 *
 * Ordered from most destructive; the caller shows at most a few.
 */
const PATTERNS: readonly Pattern[] = Object.freeze([
  {
    category: "destruction",
    pattern: /\b(Format-Volume|Clear-Disk|Initialize-Disk|format\s+[a-z]:)/iu,
    construct: "volume formatting",
    effect: "erases an entire volume, including data outside this project",
  },
  {
    category: "history_rewrite",
    pattern:
      /\bgit\s+(reset\s+--hard|push\s+.*--force|push\s+.*-f\b|clean\s+-[a-z]*f|filter-branch)/iu,
    construct: "git history rewrite",
    effect: "discards uncommitted work or rewrites history others may have",
  },
  {
    category: "deletion",
    pattern: /\b(Remove-Item|rm|del|erase|rmdir)\b[^|;]*\s-(Recurse|Force)\b/iu,
    construct: "recursive or forced delete",
    effect: "removes files or directories without prompting",
  },
  {
    category: "deletion",
    pattern: /\b(Remove-Item|rm|del|erase|rmdir)\b/iu,
    construct: "delete",
    effect: "removes files or directories",
  },
  {
    category: "process_termination",
    pattern: /\b(Stop-Process|taskkill|kill)\b/iu,
    construct: "process termination",
    effect: "ends a running process, which may lose unsaved work",
  },
  {
    category: "privilege_change",
    pattern: /\b(RunAs|Start-Process\s+.*-Verb\s+RunAs|icacls|takeown|Set-ExecutionPolicy)\b/iu,
    construct: "privilege or access change",
    effect: "elevates or changes who may access a resource",
  },
  {
    category: "network_egress",
    pattern:
      /\b(Invoke-WebRequest|Invoke-RestMethod|curl|wget|iwr|irm)\b[^|;]*\s-(Method\s+(Post|Put|Patch)|Body|InFile)\b/iu,
    construct: "outbound data transfer",
    effect: "sends data to a remote host",
  },
  {
    category: "network_egress",
    pattern: /\b(nc|netcat|ncat|telnet|ssh|scp|ftp)\b/iu,
    construct: "network connection",
    effect: "opens a connection to another host",
  },
  {
    category: "dynamic_execution",
    pattern: /\b(Invoke-Expression|iex|Invoke-Command|Start-Job)\b/iu,
    construct: "dynamic execution",
    effect: "runs code assembled at runtime, so its effect cannot be read from this line",
  },
  {
    category: "dynamic_execution",
    pattern: /\b(python|python3|node|deno|ruby|perl|php|npx|bunx)\b/iu,
    construct: "interpreter",
    effect: "runs arbitrary code supplied to the interpreter",
  },
]);

/** How many findings a preview shows before summarising the rest. */
export const MAX_RISK_FINDINGS = 4;

/**
 * Annotate a command.
 *
 * Returns every distinct category found, at most one per category, in the order the
 * patterns are declared. Duplicates are dropped because a command that deletes three
 * things does not need three "delete" lines.
 */
export function annotateCommandRisk(command: string): readonly RiskFinding[] {
  const findings: RiskFinding[] = [];
  const seen = new Set<RiskCategory>();
  for (const entry of PATTERNS) {
    if (seen.has(entry.category)) continue;
    if (!entry.pattern.test(command)) continue;
    seen.add(entry.category);
    findings.push({ category: entry.category, construct: entry.construct, effect: entry.effect });
  }
  return findings;
}

/**
 * Whether the command appears to be a single simple statement.
 *
 * Used only to decide whether to say "this runs one statement", never to relax any
 * check.
 */
export function isSingleStatement(command: string): boolean {
  // A separator outside quotes is what makes a command compound. This is a
  // heuristic, not a parser: it errs toward treating a command as compound, which
  // is the direction that adds a warning rather than removing one.
  const stripped = command.replace(/(["'])(?:\\.|(?!\1).)*\1/gu, "");
  return !/[;|]|\b(and|or)\b|&&|\|\|/iu.test(stripped);
}

/**
 * Render the risk lines for a preview.
 *
 * Empty when nothing matched: a command with no finding needs no annotation, and
 * printing "no risks" on every preview would train the user to ignore the section.
 */
export function formatRiskLines(findings: readonly RiskFinding[]): readonly string[] {
  if (findings.length === 0) return [];
  const shown = findings.slice(0, MAX_RISK_FINDINGS);
  const lines = shown.map((finding) => `risk=${finding.category}: ${finding.effect}`);
  if (findings.length > shown.length) {
    lines.push(
      `risk=(${findings.length - shown.length} more categor${findings.length - shown.length === 1 ? "y" : "ies"})`,
    );
  }
  return lines;
}
