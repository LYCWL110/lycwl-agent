import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { decideReadPermission } from "../../src/services/permission/read-policy.ts";

describe("read permission policy", () => {
  it("allows ordinary workspace reads without approval", () => {
    const decision = decideReadPermission("D:\\repo", "src\\file.ts");
    assert.equal(decision.outcome, "allowed");
    if (decision.outcome !== "allowed") return;
    assert.equal(decision.value.withinWorkspace, true);
    assert.equal(decision.value.absolutePath, "D:\\repo\\src\\file.ts");
  });

  it("requires one-shot approval for sensitive workspace reads", () => {
    const decision = decideReadPermission("D:\\repo", ".env.production");
    assert.equal(decision.outcome, "approval_required");
    if (decision.outcome !== "approval_required") return;
    assert.equal(decision.reason, "environment_file");
    assert.match(decision.disclosureWarning, /sensitive|protected/u);
    assert.equal(decision.value.withinWorkspace, true);
  });

  it("requires approval for outside-workspace reads", () => {
    const decision = decideReadPermission("D:\\repo", "..\\other\\file.ts");
    assert.equal(decision.outcome, "approval_required");
    if (decision.outcome !== "approval_required") return;
    assert.equal(decision.reason, "outside_workspace");
    assert.equal(decision.value.withinWorkspace, false);
  });

  it("returns invalid path failures without generating a target", () => {
    assert.deepEqual(decideReadPermission("D:\\repo", "CON"), {
      outcome: "invalid",
      code: "reserved_name",
    });
  });
});
