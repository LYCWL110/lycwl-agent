import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import { createSkillDiscovery } from "../../src/adapters/windows/skill-discovery.ts";

/**
 * Workspace document Skills.
 *
 * ADR-0057 records that the Skill catalog existed and nothing called it, so
 * `.agents/skills/` had no effect. These tests drive the real filesystem discovery.
 */

let root = "";

before(async () => {
  root = await mkdtemp(path.join(tmpdir(), "lycwl-skills-"));
});

after(async () => {
  if (root.length > 0) await rm(root, { recursive: true, force: true });
});

async function workspace(name: string): Promise<string> {
  const directory = path.join(root, name);
  await mkdir(directory, { recursive: true });
  return directory;
}

async function skill(directory: string, id: string, body: string): Promise<void> {
  const target = path.join(directory, ".agents", "skills", id);
  await mkdir(target, { recursive: true });
  await writeFile(path.join(target, "SKILL.md"), body, "utf8");
}

function frontmatter(name: string, description: string): string {
  return `---\nname: ${name}\ndescription: ${description}\n---\n\n# Body\n`;
}

describe("skill discovery is off by default", () => {
  it("returns disabled without touching the filesystem", async () => {
    const directory = await workspace("disabled");
    await skill(directory, "demo", frontmatter("demo", "a demo"));

    const discovery = createSkillDiscovery({ workspaceRoot: directory });
    const result = await discovery.discover({ enabled: false });
    assert.deepEqual(result, { ok: false, code: "disabled" });
  });
});

describe("skill discovery reads the workspace catalog", () => {
  it("builds a catalog from SKILL.md files", async () => {
    const directory = await workspace("catalog");
    await skill(directory, "alpha", frontmatter("alpha", "does alpha things"));
    await skill(directory, "beta", frontmatter("beta", "does beta things"));

    const discovery = createSkillDiscovery({ workspaceRoot: directory });
    const result = await discovery.discover({ enabled: true });
    assert.equal(result.ok, true, result.ok ? "" : result.code);
    if (!result.ok) return;

    assert.equal(result.catalog.skills.length, 2);
    // Sorted by id, so filesystem order cannot decide what is visible.
    assert.deepEqual(
      result.catalog.skills.map((entry) => entry.skillId),
      ["alpha", "beta"],
    );
    assert.match(result.block, /trust=untrusted project material/);
    assert.match(result.block, /does alpha things/);
  });

  it("reports not_found when there is no skills directory", async () => {
    const directory = await workspace("none");
    const discovery = createSkillDiscovery({ workspaceRoot: directory });
    assert.deepEqual(await discovery.discover({ enabled: true }), {
      ok: false,
      code: "not_found",
    });
  });

  it("returns an empty catalog for an empty skills directory", async () => {
    const directory = await workspace("empty-dir");
    await mkdir(path.join(directory, ".agents", "skills"), { recursive: true });
    const discovery = createSkillDiscovery({ workspaceRoot: directory });
    const result = await discovery.discover({ enabled: true });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepEqual(result.catalog.skills, []);
    assert.equal(result.block, "");
  });

  it("ignores a directory that has no SKILL.md", async () => {
    const directory = await workspace("partial");
    await skill(directory, "real", frontmatter("real", "present"));
    await mkdir(path.join(directory, ".agents", "skills", "notaskill"), { recursive: true });

    const discovery = createSkillDiscovery({ workspaceRoot: directory });
    const result = await discovery.discover({ enabled: true });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepEqual(
      result.catalog.skills.map((entry) => entry.skillId),
      ["real"],
    );
  });
});

describe("skill discovery refuses bad input", () => {
  it("rejects an invalid directory id rather than skipping it", async () => {
    const directory = await workspace("bad-id");
    await skill(directory, "Bad_Name", frontmatter("Bad_Name", "x"));

    const discovery = createSkillDiscovery({ workspaceRoot: directory });
    const result = await discovery.discover({ enabled: true });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.code, "invalid_skill_id");
  });

  it("rejects execution metadata in the frontmatter", async () => {
    const directory = await workspace("allowed-tools");
    await skill(
      directory,
      "danger",
      "---\nname: danger\ndescription: x\nallowed-tools: [shell]\n---\n",
    );

    const discovery = createSkillDiscovery({ workspaceRoot: directory });
    const result = await discovery.discover({ enabled: true });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.code, "unsupported_field");
  });

  it("rejects a name that does not match the directory", async () => {
    const directory = await workspace("mismatch");
    await skill(directory, "alpha", frontmatter("beta", "mismatched"));

    const discovery = createSkillDiscovery({ workspaceRoot: directory });
    const result = await discovery.discover({ enabled: true });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.code, "name_mismatch");
  });

  it("rejects a file above the per-file bound", async () => {
    const directory = await workspace("too-big");
    await skill(directory, "huge", `---\nname: huge\ndescription: x\n---\n${"y".repeat(70_000)}`);

    const discovery = createSkillDiscovery({ workspaceRoot: directory });
    const result = await discovery.discover({ enabled: true });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.code, "file_too_large");
  });
});
