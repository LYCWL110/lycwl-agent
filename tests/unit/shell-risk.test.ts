import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  formatShellPreview,
  renderShellPreview,
  validateShellRequest,
} from "../../src/domain/process/shell.ts";
import {
  annotateCommandRisk,
  formatRiskLines,
  isSingleStatement,
  MAX_RISK_FINDINGS,
} from "../../src/domain/process/shell-risk.ts";

/**
 * Shell command risk annotation.
 *
 * The rule these tests protect: this annotates, it does not block. Every shell
 * command already requires approval, so the question is not "may this run" but
 * "can the user see what it will do". A false negative is a missed hint; a false
 * positive is a scary line in front of a harmless command, which teaches the user
 * to ignore the section.
 */

const EMPTY_FILTER = { environment: {}, removedNames: [], grantNames: [] };

function preview(command: string): string {
  const validated = validateShellRequest(
    { command, cwd: "C:\\proj" },
    { sessionMode: "workspace_write" },
  );
  assert.equal(validated.ok, true);
  if (!validated.ok) return "";
  return formatShellPreview(
    renderShellPreview(validated.value, {
      environment: {},
      removedNames: [],
      missingGrantNames: [],
    }),
  );
}

describe("annotateCommandRisk", () => {
  it("flags a recursive delete hidden after another statement", () => {
    // The exact case the annotation exists for: the destructive part is the second
    // statement of a longer line.
    const findings = annotateCommandRisk("Get-Content a.txt; Remove-Item -Recurse C:\\important");
    assert.equal(
      findings.some((f) => f.category === "deletion"),
      true,
    );
  });

  it("flags a plain delete", () => {
    assert.equal(annotateCommandRisk("Remove-Item a.txt")[0]?.category, "deletion");
  });

  it("flags a git history rewrite", () => {
    for (const command of ["git reset --hard HEAD~3", "git push --force", "git clean -fd"]) {
      const findings = annotateCommandRisk(command);
      assert.equal(
        findings.some((f) => f.category === "history_rewrite"),
        true,
        command,
      );
    }
  });

  it("flags volume formatting", () => {
    assert.equal(annotateCommandRisk("Format-Volume -DriveLetter D")[0]?.category, "destruction");
  });

  it("flags process termination", () => {
    assert.equal(
      annotateCommandRisk("Stop-Process -Name chrome")[0]?.category,
      "process_termination",
    );
  });

  it("flags outbound data transfer", () => {
    const findings = annotateCommandRisk("Invoke-WebRequest -Uri https://x -Method Post -Body $d");
    assert.equal(
      findings.some((f) => f.category === "network_egress"),
      true,
    );
  });

  it("flags a bare network connection", () => {
    assert.equal(annotateCommandRisk("ssh host")[0]?.category, "network_egress");
  });

  it("flags an interpreter", () => {
    // The effect of `node -e "..."` cannot be read from the command line alone.
    assert.equal(annotateCommandRisk('node -e "x"')[0]?.category, "dynamic_execution");
  });

  it("flags dynamic execution", () => {
    assert.equal(
      annotateCommandRisk("Invoke-Expression $payload")[0]?.category,
      "dynamic_execution",
    );
  });

  it("returns nothing for a harmless command", () => {
    // A false positive here would train the user to ignore the section.
    for (const command of ["Get-Content a.txt", "npm test", "git status", "ls"]) {
      assert.deepEqual(annotateCommandRisk(command), [], command);
    }
  });

  it("reports each category once", () => {
    // Three deletes do not need three lines.
    const findings = annotateCommandRisk("Remove-Item a; Remove-Item b; Remove-Item c");
    assert.equal(findings.filter((f) => f.category === "deletion").length, 1);
  });
});

describe("isSingleStatement", () => {
  it("is true for one command", () => {
    assert.equal(isSingleStatement("Get-Content a.txt"), true);
  });

  it("is false when a separator appears outside quotes", () => {
    assert.equal(isSingleStatement("a; b"), false);
    assert.equal(isSingleStatement("a | b"), false);
  });

  it("ignores a separator inside quotes", () => {
    // `echo 'a; b'` is one statement, and flagging it would be a false positive.
    assert.equal(isSingleStatement("echo 'a; b'"), true);
    assert.equal(isSingleStatement('Write-Output "a; b"'), true);
  });
});

describe("formatRiskLines", () => {
  it("renders one line per finding", () => {
    const lines = formatRiskLines(annotateCommandRisk("Remove-Item -Recurse x"));
    assert.equal(lines.length, 1);
    assert.match(lines[0] ?? "", /^risk=deletion: /);
  });

  it("says nothing when there is no finding", () => {
    assert.deepEqual(formatRiskLines([]), []);
  });

  it("summarises beyond the cap", () => {
    const many = Array.from({ length: MAX_RISK_FINDINGS + 2 }, (_unused, index) => ({
      category: "deletion" as const,
      construct: `c${index}`,
      effect: "e",
    }));
    const lines = formatRiskLines(many);
    assert.equal(lines.length, MAX_RISK_FINDINGS + 1);
    assert.match(lines.at(-1) ?? "", /more categor/);
  });
});

describe("shell preview", () => {
  it("shows the risk for a compound destructive command", () => {
    const text = preview("Get-Content a.txt; Remove-Item -Recurse C:\\important");
    assert.match(text, /statements=more than one/);
    assert.match(text, /risk=deletion/);
  });

  it("shows no risk lines for a harmless command", () => {
    // An empty section would be noise on every preview.
    const text = preview("Get-Content a.txt");
    assert.equal(/risk=/.test(text), false);
    assert.equal(/statements=/.test(text), false);
  });

  it("shows the risk for a single-statement destructive command", () => {
    const text = preview("git reset --hard HEAD~3");
    assert.match(text, /risk=history_rewrite/);
    // It is one statement, so the compound warning must not appear.
    assert.equal(/statements=more than one/.test(text), false);
  });

  it("still shows the command itself", () => {
    // The annotation adds to the preview; it must not replace the thing being
    // approved.
    const text = preview("Remove-Item a.txt");
    assert.match(text, /command=Remove-Item a\.txt/);
  });
});
