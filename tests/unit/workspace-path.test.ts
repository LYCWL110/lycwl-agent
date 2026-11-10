import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  classifySensitiveRead,
  resolveWorkspacePath,
} from "../../src/services/permission/workspace-path.ts";

describe("workspace path resolution", () => {
  it("normalizes relative and absolute paths inside the workspace", () => {
    const relative = resolveWorkspacePath("D:\\repo", "src\\tools/file.ts");
    assert.deepEqual(relative, {
      ok: true,
      value: {
        absolutePath: "D:\\repo\\src\\tools\\file.ts",
        workspaceRoot: "D:\\repo",
        withinWorkspace: true,
        isDirectory: false,
      },
    });

    const absolute = resolveWorkspacePath("d:/repo", "D:\\REPO\\src\\file.ts");
    assert.equal(absolute.ok, true);
    if (!absolute.ok) return;
    assert.equal(absolute.value.absolutePath, "D:\\REPO\\src\\file.ts");
    assert.equal(absolute.value.withinWorkspace, true);
  });

  it("keeps traversal outside the workspace instead of silently mapping it inside", () => {
    const result = resolveWorkspacePath("D:\\repo", "..\\outside\\file.ts");
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.value.absolutePath, "D:\\outside\\file.ts");
    assert.equal(result.value.withinWorkspace, false);
  });

  it("supports UNC workspace roots and detects paths outside them", () => {
    const inside = resolveWorkspacePath("\\\\server\\share\\repo", "src/file.ts");
    assert.equal(inside.ok, true);
    if (!inside.ok) return;
    assert.equal(inside.value.absolutePath, "\\\\server\\share\\repo\\src\\file.ts");
    assert.equal(inside.value.withinWorkspace, true);

    const outside = resolveWorkspacePath("\\\\server\\share\\repo", "\\\\server\\other\\file");
    assert.equal(outside.ok, true);
    if (!outside.ok) return;
    assert.equal(outside.value.withinWorkspace, false);
  });

  it("fails closed for Windows device paths and ambiguous names", () => {
    assert.deepEqual(resolveWorkspacePath("D:\\repo", "\\\\.\\C:\\repo"), {
      ok: false,
      code: "device_namespace",
    });
    assert.deepEqual(resolveWorkspacePath("D:\\repo", "file.txt:hidden"), {
      ok: false,
      code: "alternate_data_stream",
    });
    assert.deepEqual(resolveWorkspacePath("D:\\repo", "CON.txt"), {
      ok: false,
      code: "reserved_name",
    });
    assert.deepEqual(resolveWorkspacePath("D:\\repo", "file. "), {
      ok: false,
      code: "ambiguous_segment",
    });
  });

  it("rejects an invalid workspace root before evaluating a target", () => {
    assert.deepEqual(resolveWorkspacePath("repo", "file.ts"), {
      ok: false,
      code: "invalid_workspace_root",
    });
    assert.deepEqual(resolveWorkspacePath("D:repo", "file.ts"), {
      ok: false,
      code: "invalid_drive",
    });
    assert.deepEqual(resolveWorkspacePath("\\\\server", "file.ts"), {
      ok: false,
      code: "invalid_unc",
    });
  });
});

describe("sensitive read classification", () => {
  it("classifies protected directories and sensitive files", () => {
    assert.equal(
      classifySensitiveRead({ absolutePath: "D:\\repo\\.git\\config", isDirectory: false }),
      "protected_directory",
    );
    assert.equal(
      classifySensitiveRead({ absolutePath: "D:\\repo\\.bashrc", isDirectory: false }),
      "sensitive_file",
    );
  });

  it("requires approval for .env variants while preserving example exemptions", () => {
    assert.equal(
      classifySensitiveRead({ absolutePath: "D:\\repo\\.env.local", isDirectory: false }),
      "environment_file",
    );
    assert.equal(
      classifySensitiveRead({ absolutePath: "D:\\repo\\.env.example", isDirectory: false }),
      null,
    );
    assert.equal(
      classifySensitiveRead({
        absolutePath: "D:\\repo\\.claude\\.env.example",
        isDirectory: false,
      }),
      "protected_directory",
    );
  });
});
