import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  COMPACTION_LIMITS,
  type CompactionArtifact,
  type ContextGroup,
  estimateSkeletonTokens,
  planCompaction,
  renderSkeletonBlock,
  selectRecentSuffix,
  unverifiedClaims,
  validateCompactionArtifact,
} from "../../src/domain/context/compaction.ts";

function group(overrides: Partial<ContextGroup> & { groupId: string; seq: number }): ContextGroup {
  return {
    kind: "assistant_turn",
    members: [{ id: `${overrides.groupId}-call`, kind: "tool_call", status: null }],
    bodyTokens: 100,
    bodyReducible: true,
    ...overrides,
  };
}

const GROUPS: readonly ContextGroup[] = [
  group({
    groupId: "g1",
    seq: 1,
    members: [
      { id: "call-1", kind: "tool_call", status: null },
      { id: "call-1-result", kind: "tool_result", status: "succeeded" },
    ],
  }),
  group({
    groupId: "g2",
    seq: 2,
    members: [
      { id: "call-2", kind: "tool_call", status: null },
      { id: "call-2-result", kind: "tool_result", status: "denied" },
    ],
  }),
  group({ groupId: "g3", seq: 3 }),
  group({ groupId: "g4", seq: 4 }),
];

describe("recent suffix selection", () => {
  it("keeps the newest contiguous groups that fit", () => {
    const { suffix, summarized } = selectRecentSuffix(GROUPS, 200);
    assert.deepEqual(
      suffix.map((entry) => entry.groupId),
      ["g3", "g4"],
    );
    assert.deepEqual(
      summarized.map((entry) => entry.groupId),
      ["g1", "g2"],
    );
  });

  it("moves an oversized newest group entirely into the summarised set", () => {
    const oversized = [
      group({ groupId: "small", seq: 1 }),
      group({ groupId: "huge", seq: 2, bodyTokens: 5000 }),
    ];
    const { suffix, summarized } = selectRecentSuffix(oversized, 200);
    // Splitting the huge group would separate a call from its result.
    assert.deepEqual(suffix, []);
    assert.deepEqual(
      summarized.map((entry) => entry.groupId),
      ["small", "huge"],
    );
  });

  it("never reorders groups", () => {
    const { suffix } = selectRecentSuffix([...GROUPS].reverse(), 200);
    assert.deepEqual(
      suffix.map((entry) => entry.seq),
      [3, 4],
    );
  });
});

describe("bounded plan construction", () => {
  it("builds skeletons first and fills leftover space", () => {
    const result = planCompaction({
      groups: GROUPS,
      fixedTokens: 1000,
      auxiliaryBudgetTokens: 20_000,
      recentBudget: 200,
    });
    assert.equal(result.ok, true, result.ok ? "" : result.code);
    if (!result.ok) return;
    assert.deepEqual(result.value.summarizedGroupIds, ["g1", "g2"]);
    assert.deepEqual(result.value.recentSuffixGroupIds, ["g3", "g4"]);
    assert.equal(result.value.skeletons.length, 2);
    // Enough room for both bodies in full.
    assert.deepEqual(
      result.value.skeletons.map((entry) => entry.representation),
      ["full", "full"],
    );
  });

  it("fails explicitly when fixed plus skeleton exceeds the budget", () => {
    const result = planCompaction({
      groups: GROUPS,
      fixedTokens: 9000,
      auxiliaryBudgetTokens: 1000,
      recentBudget: 0,
    });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.code, "context_capacity_insufficient");
  });

  it("degrades to an excerpt, then to reference_only, as space shrinks", () => {
    // Fill order is newest-old-group first, so the newest summarised group gets
    // the remaining space before older ones. With recentBudget 200 the summarised
    // set is g1+g2 and the conservative skeleton is 77, leaving budget-77 to fill:
    //   budget 400 -> 323 left -> g2 full (120), g1 full (120)   => both full
    //   budget 250 -> 173 left -> g2 full (120), g1 excerpt (30) => [excerpt, full]
    //   budget 100 ->  23 left -> neither fits                  => both reference_only
    const cases: readonly { budget: number; expected: readonly string[] }[] = [
      { budget: 400, expected: ["full", "full"] },
      { budget: 250, expected: ["excerpt", "full"] },
      { budget: 100, expected: ["reference_only", "reference_only"] },
    ];
    for (const scenario of cases) {
      const result = planCompaction({
        groups: GROUPS,
        fixedTokens: 0,
        auxiliaryBudgetTokens: scenario.budget,
        recentBudget: 200,
      });
      assert.equal(result.ok, true, `${scenario.budget}: ${result.ok ? "" : result.code}`);
      if (!result.ok) continue;
      assert.deepEqual(
        result.value.skeletons.map((entry) => entry.representation),
        scenario.expected,
        `budget ${scenario.budget}`,
      );
    }
  });

  it("marks a non-reducible body as reference_only regardless of space", () => {
    const result = planCompaction({
      groups: [
        group({ groupId: "authority", seq: 1, bodyReducible: false }),
        group({ groupId: "rest", seq: 2 }),
      ],
      fixedTokens: 0,
      auxiliaryBudgetTokens: 20_000,
      recentBudget: 0,
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    const authority = result.value.skeletons.find((entry) => entry.groupId === "authority");
    assert.equal(authority?.representation, "reference_only");
  });

  it("refuses more compactions than C05 allows", () => {
    const result = planCompaction({
      groups: GROUPS,
      fixedTokens: 0,
      auxiliaryBudgetTokens: 20_000,
      recentBudget: 0,
      compactionsUsed: COMPACTION_LIMITS.maxCompactionsPerRun,
    });
    assert.deepEqual(result, { ok: false, code: "too_many_compactions" });
  });

  it("refuses a duplicate group identity", () => {
    const result = planCompaction({
      groups: [group({ groupId: "a", seq: 1 }), group({ groupId: "a", seq: 2 })],
      fixedTokens: 0,
      auxiliaryBudgetTokens: 20_000,
      recentBudget: 0,
    });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.code, "group_identity_duplicated");
  });

  it("refuses a plan whose parent coverage is not contained in it", () => {
    // g1 and g2 are the summarised set with recentBudget 200, so a parent that
    // covered g2 is still contained and the plan is valid.
    const contained = planCompaction({
      groups: GROUPS,
      fixedTokens: 0,
      auxiliaryBudgetTokens: 20_000,
      recentBudget: 200,
      parentGroupIds: ["g2"],
    });
    assert.equal(contained.ok, true, contained.ok ? "" : contained.code);

    // A parent id that this plan does not cover would silently drop established
    // coverage, so it is refused rather than ignored.
    const broken = planCompaction({
      groups: [group({ groupId: "only", seq: 1 })],
      fixedTokens: 0,
      auxiliaryBudgetTokens: 20_000,
      recentBudget: 1000,
      parentGroupIds: ["missing"],
    });
    assert.equal(broken.ok, false);
    if (broken.ok) return;
    assert.equal(broken.code, "invalid_group");
  });

  it("reports the source high-water seq", () => {
    const result = planCompaction({
      groups: GROUPS,
      fixedTokens: 0,
      auxiliaryBudgetTokens: 20_000,
      recentBudget: 200,
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.value.sourceHighWaterSeq, 4);
  });

  it("estimates skeleton size from member count", () => {
    const twoMembers = group({
      groupId: "x",
      seq: 1,
      members: [
        { id: "a", kind: "tool_call", status: null },
        { id: "b", kind: "tool_result", status: "succeeded" },
      ],
    });
    assert.equal(estimateSkeletonTokens(twoMembers), 2 * 8 + 16);
  });
});

describe("skeleton rendering", () => {
  it("states that reference_only bodies never entered and pins statuses", () => {
    const result = planCompaction({
      groups: GROUPS,
      fixedTokens: 0,
      auxiliaryBudgetTokens: 950,
      recentBudget: 0,
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    const rendered = renderSkeletonBlock(result.value.skeletons);
    assert.match(rendered, /reference_only means the body never entered/);
    // The denied outcome survives verbatim: a summary cannot upgrade it.
    assert.match(rendered, /call-2-result status=denied/);
    assert.match(rendered, /call-1-result status=succeeded/);
  });
});

describe("artifact validation", () => {
  const plan = (() => {
    const result = planCompaction({
      groups: GROUPS,
      fixedTokens: 0,
      auxiliaryBudgetTokens: 20_000,
      recentBudget: 200,
    });
    assert.equal(result.ok, true);
    if (!result.ok) throw new Error("plan");
    return result.value;
  })();

  function artifact(overrides: Partial<CompactionArtifact> = {}): CompactionArtifact {
    return {
      schemaVersion: 1,
      sourceMessageIds: ["g1", "g2"],
      coverage: { fromSeq: 1, toSeq: plan.sourceHighWaterSeq },
      goal: "finish the task",
      pinnedConstraintIds: ["c1"],
      confirmedDecisionIds: [],
      completedClaims: [],
      activeTaskId: null,
      blockedReasons: [],
      nextActions: [],
      fileReferences: [],
      proposedToolCalls: 0,
      ...overrides,
    };
  }

  const base = {
    plan,
    requiredConstraintIds: ["c1"],
    requiredSourceIds: ["g1", "g2"],
    outputBudgetTokens: 1200,
    estimatedOutputTokens: 800,
  };

  it("accepts a coherent artifact", () => {
    assert.deepEqual(validateCompactionArtifact({ ...base, artifact: artifact() }), { ok: true });
  });

  it("refuses an artifact that proposes a tool call", () => {
    const result = validateCompactionArtifact({
      ...base,
      artifact: artifact({ proposedToolCalls: 1 }),
    });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.code, "proposed_tool_call");
  });

  it("refuses coverage that does not reach the high-water seq", () => {
    const result = validateCompactionArtifact({
      ...base,
      artifact: artifact({ coverage: { fromSeq: 1, toSeq: 3 } }),
    });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.code, "invalid_structure");
  });

  it("refuses a missing required source", () => {
    const result = validateCompactionArtifact({
      ...base,
      artifact: artifact({ sourceMessageIds: ["g1"] }),
    });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.code, "missing_source_id");
    assert.equal(result.detail, "g2");
  });

  it("refuses a source that was never in the plan", () => {
    const result = validateCompactionArtifact({
      ...base,
      artifact: artifact({ sourceMessageIds: ["g1", "g2", "g3"] }),
    });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.code, "unknown_source_id");
  });

  it("refuses a dropped pinned constraint", () => {
    const result = validateCompactionArtifact({
      ...base,
      artifact: artifact({ pinnedConstraintIds: [] }),
    });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.code, "constraint_uncovered");
    assert.equal(result.detail, "c1");
  });

  it("refuses an over-budget artifact", () => {
    const result = validateCompactionArtifact({
      ...base,
      artifact: artifact(),
      estimatedOutputTokens: 5000,
    });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.code, "over_budget");
  });

  it("keeps evidence-free claims as unverified narration", () => {
    const claims = unverifiedClaims(
      artifact({
        completedClaims: [
          { text: "tests pass", evidenceRefs: [] },
          { text: "file written", evidenceRefs: ["event-9"] },
        ],
      }),
    );
    assert.deepEqual(claims, [{ text: "tests pass" }]);
  });
});
