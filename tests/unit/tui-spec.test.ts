import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  type ApprovalPanelState,
  acceptApprovalReply,
  actionKeepsWait,
  buildQueueView,
  DISTINCT_ACTIONS,
  describeRunVersusGoal,
  describeSkillUse,
  displayWidth,
  type FinalReportView,
  inspectComposerInput,
  PANEL_ACTIONS,
  REPORT_DIMENSIONS,
  truncateToWidth,
} from "../../src/tui/spec.ts";

function panel(overrides: Partial<ApprovalPanelState> = {}): ApprovalPanelState {
  return {
    approvalId: "ap-1",
    toolCallId: "call-1",
    requestVersion: 1,
    preview: {
      toolName: "shell",
      lines: ["command=echo hi", "cwd=C:\\ws"],
      scrollable: false,
      redacted: true,
      preconditionsChanged: false,
    },
    focusGrantsNothing: true,
    alwaysAllowAvailable: false,
    ...overrides,
  };
}

describe("panel action identities", () => {
  it("gives every panel a close action that keeps the wait", () => {
    for (const [kind, actions] of Object.entries(PANEL_ACTIONS)) {
      assert.ok(actions.includes("close_panel"), `${kind} must be closeable`);
    }
  });

  it("never shares an approval action with question or disclosure panels", () => {
    assert.ok(PANEL_ACTIONS.approval.includes("reply_approval"));
    assert.equal(PANEL_ACTIONS.question.includes("reply_approval"), false);
    assert.equal(PANEL_ACTIONS.disclosure.includes("reply_approval"), false);
    assert.ok(PANEL_ACTIONS.disclosure.includes("reply_disclosure"));
  });

  it("keeps resume out of every non-recovery panel", () => {
    for (const [kind, actions] of Object.entries(PANEL_ACTIONS)) {
      if (kind === "recovery") continue;
      assert.equal(actions.includes("resume_run"), false, kind);
    }
  });

  it("treats closing as a view action only", () => {
    assert.equal(actionKeepsWait("close_panel"), true);
    for (const action of DISTINCT_ACTIONS) {
      assert.equal(actionKeepsWait(action), false, action);
    }
  });

  it("lists the actions a generic continue must never stand in for", () => {
    assert.deepEqual(
      [...DISTINCT_ACTIONS],
      ["reply_approval", "reply_disclosure", "submit_user_input", "resume_run"],
    );
  });
});

describe("approval reply acceptance", () => {
  it("accepts a matching version with unchanged preconditions", () => {
    assert.deepEqual(
      acceptApprovalReply({ panel: panel(), replyVersion: 1, preconditionsChanged: false }),
      { accepted: true },
    );
  });

  it("rejects a stale version", () => {
    const result = acceptApprovalReply({
      panel: panel(),
      replyVersion: 2,
      preconditionsChanged: false,
    });
    assert.equal(result.accepted, false);
    if (result.accepted) return;
    assert.equal(result.reason, "stale_version");
  });

  it("rejects a reply after the target changed while the preview was shown", () => {
    const result = acceptApprovalReply({
      panel: panel(),
      replyVersion: 1,
      preconditionsChanged: true,
    });
    assert.equal(result.accepted, false);
    if (result.accepted) return;
    assert.equal(result.reason, "preconditions_changed");
  });

  it("models that focus grants nothing and there is no always-allow", () => {
    const state = panel();
    assert.equal(state.focusGrantsNothing, true);
    assert.equal(state.alwaysAllowAvailable, false);
  });
});

describe("ordinary input queue view", () => {
  it("orders items by accepted sequence", () => {
    const view = buildQueueView([
      { inputId: "b", acceptedSeq: 2, text: "second", state: "accepted" },
      { inputId: "a", acceptedSeq: 1, text: "first", state: "accepted" },
    ]);
    assert.deepEqual(
      view.items.map((item) => item.inputId),
      ["a", "b"],
    );
  });

  it("allows withdrawing only unconsumed items", () => {
    const view = buildQueueView([
      { inputId: "a", acceptedSeq: 1, text: "one", state: "accepted" },
      { inputId: "b", acceptedSeq: 2, text: "two", state: "consumed" },
      { inputId: "c", acceptedSeq: 3, text: "three", state: "sent" },
    ]);
    assert.deepEqual(view.withdrawableIds, ["a"]);
  });

  it("surfaces consumed-but-not-sent honestly", () => {
    const view = buildQueueView([{ inputId: "a", acceptedSeq: 1, text: "one", state: "consumed" }]);
    assert.equal(view.hasConsumedNotSent, true);
  });

  it("does not report unknown state as sent", () => {
    const view = buildQueueView([{ inputId: "a", acceptedSeq: 1, text: "one", state: "unknown" }]);
    assert.equal(view.withdrawableIds.length, 0);
    assert.equal(view.hasConsumedNotSent, false);
  });
});

describe("final report dimensions", () => {
  function report(overrides: Partial<FinalReportView> = {}): FinalReportView {
    return {
      runEnded: true,
      dimensions: {
        execution: "completed",
        evidence: "complete",
        delivery: "delivered",
        verification: "verified",
      },
      unrunTests: [],
      failedTests: [],
      unfinishedWork: [],
      unknownCharges: 0,
      runningBackgroundTasks: [],
      ...overrides,
    };
  }

  it("keeps the four C06 dimensions separate", () => {
    assert.deepEqual([...REPORT_DIMENSIONS], ["execution", "evidence", "delivery", "verification"]);
  });

  it("distinguishes an ended run from a verified goal", () => {
    const text = describeRunVersusGoal(report());
    assert.match(text, /run ended/);
    assert.match(text, /goal verified/);
  });

  it("shows an ended run with an unverified goal as such", () => {
    const text = describeRunVersusGoal(
      report({
        dimensions: {
          execution: "completed",
          evidence: "partial",
          delivery: "delivered",
          verification: "partially_verified",
        },
      }),
    );
    assert.match(text, /run ended/);
    assert.match(text, /goal partially_verified/);
  });

  it("lists still-running background tasks at Run end", () => {
    const text = describeRunVersusGoal(report({ runningBackgroundTasks: ["task-1", "task-2"] }));
    assert.match(text, /2 background task\(s\) still running/);
  });
});

describe("skills panel", () => {
  it("describes use as ordinary input, not approval", () => {
    const text = describeSkillUse({
      skillId: "demo",
      description: "a demo skill",
      bytes: 100,
      sourceSha256: "a".repeat(64),
    });
    assert.match(text, /queued task input/);
    assert.match(text, /does not approve shell, writes or external reads/);
  });
});

describe("composer input safety", () => {
  it("accepts ordinary text", () => {
    assert.deepEqual(inspectComposerInput("hello world", 80), []);
  });

  it("accepts a tab", () => {
    assert.deepEqual(inspectComposerInput("a\tb", 80), []);
  });

  it("flags a control character", () => {
    assert.deepEqual(inspectComposerInput("bad\u0001char", 80), ["control_character"]);
  });

  it("flags an unpaired surrogate", () => {
    assert.ok(inspectComposerInput("bad\uD800", 80).includes("unpaired_surrogate"));
  });

  it("does not flag a valid surrogate pair", () => {
    assert.deepEqual(inspectComposerInput("ok \u{1F600}", 80), []);
  });

  it("flags text wider than the viewport", () => {
    assert.ok(inspectComposerInput("x".repeat(20), 10).includes("too_wide"));
  });
});

describe("wide character width handling", () => {
  it("counts CJK as two columns", () => {
    assert.equal(displayWidth("中文"), 4);
    assert.equal(displayWidth("ab"), 2);
  });

  it("counts an emoji as two columns", () => {
    assert.equal(displayWidth("\u{1F600}"), 2);
  });

  it("truncates without splitting a wide character", () => {
    // Budget 3 fits one wide char (2) but not a second (would be 4).
    assert.equal(truncateToWidth("中文", 3), "中");
    assert.equal(truncateToWidth("中文", 4), "中文");
  });

  it("returns empty for a non-positive budget", () => {
    assert.equal(truncateToWidth("abc", 0), "");
    assert.equal(truncateToWidth("abc", -1), "");
  });

  it("keeps ascii truncation simple", () => {
    assert.equal(truncateToWidth("abcdef", 3), "abc");
  });
});
