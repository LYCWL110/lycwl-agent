/**
 * TUI functional specification layer (V1_DESIGN_SUPPLEMENTS.md S02).
 *
 * This is not a visual prototype. It is the testable part of the spec: what each
 * panel must show, which actions are distinct, and which shortcuts must not be
 * mistaken for authority.
 *
 * The recurring failure this module exists to prevent is a keystroke meaning two
 * things. Appending `a` to a composer line is not an approval, closing a panel is
 * not a decision, and a generic "continue" is not any of ReplyApproval, disclosure
 * consent or ResumeRun.
 */

export type PanelKind =
  | "approval"
  | "question"
  | "disclosure"
  | "queue"
  | "recovery"
  | "report"
  | "skills";

/**
 * A panel's action identity. Two panels may look similar but must never share an
 * action id, because the TUI dispatches by action rather than by position.
 */
export type PanelActionId =
  | "reply_approval"
  | "deny_approval"
  | "submit_user_input"
  | "decline_question"
  | "cancel_question"
  | "reply_disclosure"
  | "withdraw_input"
  | "resume_run"
  | "cancel_run"
  | "use_skill"
  | "close_panel";

export const PANEL_ACTIONS: Readonly<Record<PanelKind, readonly PanelActionId[]>> = Object.freeze({
  approval: ["reply_approval", "deny_approval", "close_panel"],
  question: ["submit_user_input", "decline_question", "cancel_question", "close_panel"],
  disclosure: ["reply_disclosure", "close_panel"],
  queue: ["withdraw_input", "close_panel"],
  recovery: ["resume_run", "close_panel"],
  report: ["close_panel"],
  skills: ["use_skill", "close_panel"],
});

/** True when closing a panel leaves every underlying wait exactly as it was. */
export function actionKeepsWait(action: PanelActionId): boolean {
  return action === "close_panel";
}

/**
 * Actions that are distinct identities and must never be substituted for one
 * another by a generic "continue". Listed explicitly so a future shortcut cannot
 * quietly alias them.
 */
export const DISTINCT_ACTIONS: readonly PanelActionId[] = Object.freeze([
  "reply_approval",
  "reply_disclosure",
  "submit_user_input",
  "resume_run",
]);

export type ApprovalPreviewView = Readonly<{
  toolName: string;
  /** Full preview text; scrollable, never truncated for safety information. */
  lines: readonly string[];
  /** True when the preview is longer than the visible area. */
  scrollable: boolean;
  /** Sensitive values must already be redacted by the producer. */
  redacted: boolean;
  /** True when the environment or targets changed since the preview was shown. */
  preconditionsChanged: boolean;
}>;

export type ApprovalPanelState = Readonly<{
  approvalId: string;
  toolCallId: string;
  requestVersion: number;
  preview: ApprovalPreviewView;
  /**
   * Focus is never approval. A focused panel still requires an explicit action,
   * and there is no always-allow control.
   */
  focusGrantsNothing: true;
  alwaysAllowAvailable: false;
}>;

export type ApprovalReplyRejection =
  | "stale_version"
  | "preconditions_changed"
  | "unknown_approval"
  | "not_focused";

/**
 * Decide whether a keypress may become an approval reply.
 *
 * `preconditionsChanged` is a fresh comparison, not the flag recorded when the
 * panel opened: a target that changed while the user was reading means the shown
 * preview no longer describes the operation.
 */
export function acceptApprovalReply(input: {
  panel: ApprovalPanelState;
  replyVersion: number;
  preconditionsChanged: boolean;
}): Readonly<{ accepted: true }> | Readonly<{ accepted: false; reason: ApprovalReplyRejection }> {
  if (input.replyVersion !== input.panel.requestVersion) {
    return { accepted: false, reason: "stale_version" };
  }
  if (input.preconditionsChanged) {
    return { accepted: false, reason: "preconditions_changed" };
  }
  return { accepted: true };
}

export type QueueItemState = "accepted" | "consumed" | "sent" | "unknown" | "withdrawn";

export type QueueItem = Readonly<{
  inputId: string;
  acceptedSeq: number;
  text: string;
  state: QueueItemState;
}>;

export type QueueView = Readonly<{
  items: readonly QueueItem[];
  /** Items still eligible for WithdrawRunInput. */
  withdrawableIds: readonly string[];
  /** True when the model has not yet been shown a consumed item. */
  hasConsumedNotSent: boolean;
}>;

/**
 * Build the queue panel. A consumed-but-not-sent item is visible as such, because
 * "consumed" is not a promise the model saw it.
 */
export function buildQueueView(items: readonly QueueItem[]): QueueView {
  const ordered = [...items].sort((left, right) => left.acceptedSeq - right.acceptedSeq);
  return {
    items: ordered,
    withdrawableIds: ordered
      .filter((item) => item.state === "accepted")
      .map((item) => item.inputId),
    hasConsumedNotSent: ordered.some((item) => item.state === "consumed"),
  };
}

export type ReportDimension = "execution" | "evidence" | "delivery" | "verification";

/**
 * The four C06 dimensions, shown separately. Collapsing them into one label is how
 * an ended Run gets mistaken for a working feature.
 */
export const REPORT_DIMENSIONS: readonly ReportDimension[] = Object.freeze([
  "execution",
  "evidence",
  "delivery",
  "verification",
]);

export type FinalReportView = Readonly<{
  runEnded: boolean;
  dimensions: Readonly<Record<ReportDimension, string>>;
  unrunTests: readonly string[];
  failedTests: readonly string[];
  unfinishedWork: readonly string[];
  unknownCharges: number;
  /** Background tasks that still run when the Run ended. */
  runningBackgroundTasks: readonly string[];
}>;

/**
 * The single question the report must answer unambiguously: did the Run end, and
 * separately, is the goal verified?
 */
export function describeRunVersusGoal(report: FinalReportView): string {
  const ended = report.runEnded ? "run ended" : "run not ended";
  const verified =
    report.dimensions.verification === "verified"
      ? "goal verified"
      : `goal ${report.dimensions.verification}`;
  const background =
    report.runningBackgroundTasks.length === 0
      ? ""
      : ` (${report.runningBackgroundTasks.length} background task(s) still running)`;
  return `${ended}; ${verified}${background}`;
}

export type SkillCatalogItemView = Readonly<{
  skillId: string;
  description: string;
  bytes: number;
  sourceSha256: string;
}>;

export type SkillsPanelView = Readonly<{
  /** Session switch; default off, and enabling it grants no read permission. */
  enabled: boolean;
  limits: Readonly<{ maxSkills: number; maxFileBytes: number; maxCatalogEstimatedTokens: number }>;
  items: readonly SkillCatalogItemView[];
  /** Parse or limit errors shown instead of a silently shorter list. */
  errors: readonly Readonly<{ skillId: string; code: string }>[];
  /** "Use" submits ordinary queued task input; it is not tool approval. */
  useIsOrdinaryInput: true;
}>;

/**
 * Describe what "use" means, so the UI text cannot imply it approves tools the
 * skill happens to mention.
 */
export function describeSkillUse(item: SkillCatalogItemView): string {
  return [
    `queued task input: use skill ${item.skillId}`,
    "effect=submits ordinary input; it does not approve shell, writes or external reads",
  ].join("\n");
}

export type InputSafetyIssue = "control_character" | "unpaired_surrogate" | "too_wide";

/**
 * Screen practical input hazards before they reach the composer.
 *
 * This is a UI guard, not validation of a command: rejecting a control character
 * here says nothing about whether the resulting text is a valid instruction.
 */
export function inspectComposerInput(text: string, maxWidth: number): readonly InputSafetyIssue[] {
  const issues: InputSafetyIssue[] = [];
  for (const character of text) {
    const codePoint = character.codePointAt(0);
    if (codePoint === undefined) continue;
    if (codePoint < 0x20 && codePoint !== 0x09) issues.push("control_character");
  }
  if (issues.length === 0 && containsUnpairedSurrogate(text)) {
    issues.push("unpaired_surrogate");
  }
  if (displayWidth(text) > maxWidth) issues.push("too_wide");
  return [...new Set(issues)];
}

/**
 * Approximate terminal column width. CJK and fullwidth characters occupy two
 * columns, which is what makes a naive `text.length` truncation cut a line in the
 * wrong place. This is an approximation, not a Unicode width table.
 */
export function displayWidth(text: string): number {
  let width = 0;
  for (const character of text) {
    const codePoint = character.codePointAt(0);
    if (codePoint === undefined) continue;
    width += isWide(codePoint) ? 2 : 1;
  }
  return width;
}

/** Truncate to a column budget without splitting a wide character. */
export function truncateToWidth(text: string, maxWidth: number): string {
  if (maxWidth <= 0) return "";
  let width = 0;
  let output = "";
  for (const character of text) {
    const codePoint = character.codePointAt(0);
    if (codePoint === undefined) continue;
    const cost = isWide(codePoint) ? 2 : 1;
    if (width + cost > maxWidth) break;
    width += cost;
    output += character;
  }
  return output;
}

function isWide(codePoint: number): boolean {
  return (
    (codePoint >= 0x1100 && codePoint <= 0x115f) ||
    (codePoint >= 0x2e80 && codePoint <= 0xa4cf) ||
    (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
    (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
    (codePoint >= 0xfe30 && codePoint <= 0xfe6f) ||
    (codePoint >= 0xff00 && codePoint <= 0xff60) ||
    (codePoint >= 0xffe0 && codePoint <= 0xffe6) ||
    (codePoint >= 0x1f300 && codePoint <= 0x1f64f) ||
    (codePoint >= 0x1f900 && codePoint <= 0x1f9ff) ||
    (codePoint >= 0x20000 && codePoint <= 0x3fffd)
  );
}

function containsUnpairedSurrogate(text: string): boolean {
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      index += 1;
      continue;
    }
    if (code >= 0xdc00 && code <= 0xdfff) return true;
  }
  return false;
}
