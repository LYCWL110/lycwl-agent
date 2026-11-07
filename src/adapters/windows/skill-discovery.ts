import { createHash } from "node:crypto";

import {
  buildSkillCatalog,
  estimateCatalogTokens,
  isValidSkillId,
  renderSkillCatalog,
  SKILL_FILE,
  SKILLS_DIRECTORY,
  SKILLS_LIMITS,
  type SkillCatalog,
  type SkillSource,
} from "../../domain/context/skills.ts";
import { resolveWorkspacePath } from "../../services/permission/workspace-path.ts";
import { createWindowsFileReader } from "./windows-directory-reader.ts";

/**
 * Discover workspace document Skills.
 *
 * Only `.agents/skills/<skillId>/SKILL.md` inside the workspace is read. There is no
 * home, ancestor, global-install or network discovery, and no directory is created.
 *
 * The catalog is untrusted project material: a skill's description is data, never an
 * instruction, and the body is not loaded here. Reading a body stays an ordinary
 * governed `read_file`, so the trust level of the text is the same as any other
 * project file.
 */

export type SkillDiscoveryResult =
  | Readonly<{
      ok: true;
      catalog: SkillCatalog;
      /** Rendered catalog block, empty when there are no skills. */
      block: string;
    }>
  | Readonly<{
      ok: false;
      code:
        | "disabled"
        | "not_found"
        | "unreadable"
        | "approval_required"
        | "invalid_skill_id"
        | "too_many_skills"
        | "file_too_large"
        | "catalog_too_large"
        | "unsupported_field"
        | "invalid_frontmatter"
        | "missing_frontmatter"
        | "invalid_name"
        | "name_mismatch"
        | "invalid_description"
        | "duplicate_skill_id";
      detail?: string;
    }>;

export function createSkillDiscovery(options: Readonly<{ workspaceRoot: string }>) {
  const reader = createWindowsFileReader({ workspaceRoot: options.workspaceRoot });

  return {
    /**
     * Build the catalog for this workspace.
     *
     * `enabled` defaults to false, matching the confirmed design: a Session must opt
     * in, and enabling the switch is not permission to read sensitive paths.
     */
    async discover(input: { enabled: boolean }): Promise<SkillDiscoveryResult> {
      if (!input.enabled) return { ok: false, code: "disabled" };

      const resolved = resolveWorkspacePath(options.workspaceRoot, SKILLS_DIRECTORY);
      if (!resolved.ok) return { ok: false, code: "unreadable" };

      const listed = await reader.listDirectory(resolved.value.absolutePath);
      if (!listed.ok) {
        // A missing skills directory is not an error; there is simply nothing.
        return listed.code === "not_found"
          ? { ok: false, code: "not_found" }
          : { ok: false, code: "unreadable" };
      }

      const directories = listed.entries
        .filter((entry) => entry.kind === "directory")
        .map((entry) => entry.path.replace(/\\/g, "/").split("/").at(-1) ?? "")
        .filter((name) => name.length > 0)
        // Deterministic order, and the limit is applied after sorting so a
        // filesystem's incidental order cannot decide which skills are visible.
        .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));

      if (directories.length > SKILLS_LIMITS.maxSkills) {
        return { ok: false, code: "too_many_skills" };
      }

      const sources: SkillSource[] = [];
      for (const skillId of directories) {
        // An invalid directory name is reported rather than skipped: silently
        // ignoring it would hide a skill the author believes is present.
        if (!isValidSkillId(skillId)) {
          return { ok: false, code: "invalid_skill_id", detail: skillId };
        }
        const skillPath = `${SKILLS_DIRECTORY}/${skillId}/${SKILL_FILE}`;
        const read = await reader.readFile(skillPath, {
          unapproved: true,
          maxBytes: SKILLS_LIMITS.maxFileBytes,
        });
        if (!read.ok) {
          if (read.code === "not_found") continue;
          return {
            ok: false,
            code:
              read.code === "approval_required" || read.code === "file_too_large"
                ? read.code
                : "unreadable",
          };
        }
        let text: string;
        try {
          text = new TextDecoder("utf-8", { fatal: true }).decode(read.bytes);
        } catch {
          return { ok: false, code: "unreadable" };
        }
        sources.push({
          skillId,
          text,
          sourceSha256: createHash("sha256").update(text, "utf8").digest("hex"),
        });
      }

      if (sources.length === 0) {
        return {
          ok: true,
          catalog: {
            version: 1,
            skills: [],
            unsupportedFields: [],
            totalBytes: 0,
            estimatedTokens: 0,
          },
          block: "",
        };
      }

      // Build once with a zero estimate to obtain the rendered text, then rebuild
      // with the real estimate so the bound is checked against what is actually sent.
      const provisional = buildSkillCatalog({ version: 1, sources, estimatedTokens: 0 });
      if (!provisional.ok) {
        return {
          ok: false,
          code: provisional.code,
          ...(provisional.skillId === undefined ? {} : { detail: provisional.skillId }),
        };
      }
      const rendered = renderSkillCatalog(provisional.value);
      const tokens = estimateCatalogTokens(rendered);

      const built = buildSkillCatalog({ version: 1, sources, estimatedTokens: tokens });
      if (!built.ok) {
        return {
          ok: false,
          code: built.code,
          ...(built.skillId === undefined ? {} : { detail: built.skillId }),
        };
      }
      return { ok: true, catalog: built.value, block: rendered };
    },
  };
}
