import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  HARNESS_RULES_SECTIONS,
  HARNESS_RULES_VERSION,
  harnessRulesIdentity,
  renderHarnessRules,
} from "../../src/domain/context/harness-rules.ts";

/**
 * Trusted Harness rules.
 *
 * The rule these tests protect: this is the only text that reaches the model with
 * application authority. Everything else — repository files, tool results, web
 * content — is untrusted and must arrive as a sourced user turn. A rule that
 * contradicts a real capability is worse than no rule, because the model acts on it.
 */

const text = renderHarnessRules();

describe("structure", () => {
  it("has a stable section order", () => {
    assert.deepEqual(
      HARNESS_RULES_SECTIONS.map((section) => section.id),
      ["intro", "system", "doing-tasks", "actions", "using-tools", "tone", "reporting"],
    );
  });

  it("joins sections with a blank line", () => {
    assert.equal(text.split("\n\n").length >= HARNESS_RULES_SECTIONS.length, true);
  });

  it("keeps every section non-empty", () => {
    for (const section of HARNESS_RULES_SECTIONS) {
      assert.ok(section.text.trim().length > 0, section.id);
    }
  });

  it("stays within a cacheable size", () => {
    // The whole prompt is constant per build, so it is cacheable; a prompt that grew
    // past a few thousand tokens would cost on every request instead.
    assert.ok(text.length < 8_000, `${text.length} chars`);
  });

  it("is deterministic", () => {
    // A prompt that changed between renders would invalidate the cached prefix.
    assert.equal(renderHarnessRules(), text);
  });
});

describe("identity", () => {
  it("reports a stable template id and the current version", () => {
    assert.deepEqual(harnessRulesIdentity(), {
      templateId: "harness-rules",
      templateVersion: HARNESS_RULES_VERSION,
    });
  });
});

describe("content matches real capabilities", () => {
  it("names the tools that actually exist", () => {
    // A rule pointing at a tool the Harness does not expose makes the model call
    // something that fails, which is worse than saying nothing.
    for (const tool of [
      "read_file",
      "glob",
      "grep",
      "edit_file",
      "apply_patch",
      "create_file",
      "shell",
      "todo",
      "ask_user",
    ]) {
      assert.equal(text.includes(tool), true, `missing ${tool}`);
    }
  });

  it("does not promise capabilities the Harness lacks", () => {
    // These exist in the reference project this structure came from, not here.
    for (const absent of ["subagent", "Agent tool", "output style", "hooks", "plan mode"]) {
      assert.equal(text.toLowerCase().includes(absent.toLowerCase()), false, absent);
    }
  });

  it("states that edits require approval", () => {
    // This is the load-bearing permission rule; without it the model may assume a
    // write proceeds without confirmation.
    assert.match(text, /approval/i);
    assert.match(text, /shell command/i);
  });

  it("explains partial and unconfirmed results", () => {
    // These come from ADR-0081 and the model must not confuse them: partial invites a
    // continuation, unconfirmed forbids a retry.
    assert.match(text, /partial/i);
    assert.match(text, /unconfirmed/i);
  });

  it("mentions that a failed compile reverts the edit", () => {
    // ADR-0078 behaviour the model should know, so it does not assume a broken edit
    // persisted.
    assert.match(text, /compile/i);
    assert.match(text, /revert/i);
  });

  it("warns that tool results may carry injected instructions", () => {
    assert.match(text, /external sources|instruct you/i);
  });

  it("states the shell is PowerShell in a fresh process per call", () => {
    // True of this build: powershell.exe, a new process each time, no retained cwd.
    // Without it the model assumes a persistent shell and uses relative paths.
    assert.match(text, /PowerShell/);
    assert.match(text, /fresh PowerShell process|does not carry to the next call/);
  });

  it("asks for absolute paths", () => {
    assert.match(text, /absolute/i);
  });

  it("says not to reproduce code that was merely read", () => {
    assert.match(text, /merely read/i);
  });

  it("does not claim parallel tool calls", () => {
    // Sibling tools execute serially in v1. Telling the model to parallelize would
    // describe behaviour the Harness does not have.
    assert.equal(/parallel tool calls|in parallel/i.test(text), false);
  });

  it("does not mention a scratchpad directory", () => {
    // The reference has one; this Harness does not, and naming it would send the
    // model to a path that does not exist.
    assert.equal(/scratchpad/i.test(text), false);
  });

  it("does not carry a model name", () => {
    // The model is configured per Run; a name baked into the prompt would be wrong
    // for every other provider.
    assert.equal(/claude|gpt|deepseek/i.test(text), false);
  });
});

describe("provenance boundary", () => {
  it("does not contain project-specific content", () => {
    // The system prompt is fixed at build time; anything project-specific belongs in
    // a sourced user turn, where it cannot acquire application authority.
    assert.equal(/AGENTS\.md/.test(text), false);
    assert.equal(/\.agents\/skills/.test(text), false);
  });
});
