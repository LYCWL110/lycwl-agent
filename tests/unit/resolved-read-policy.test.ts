import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { decideResolvedReadPermission } from "../../src/services/permission/resolved-read-policy.ts";

describe("resolved read permission policy", () => {
  it("allows an ordinary workspace file whose resolved target remains inside", () => {
    assert.deepEqual(
      decideResolvedReadPermission("D:\\repo", {
        requestedPath: "src\\file.ts",
        resolvedPath: "D:\\repo\\src\\file.ts",
        isDirectory: false,
        isSymbolicLink: false,
      }),
      {
        outcome: "allowed",
        requestedPath: "D:\\repo\\src\\file.ts",
        resolvedPath: "D:\\repo\\src\\file.ts",
      },
    );
  });

  it("requires approval when either the requested or resolved target is sensitive", () => {
    const requestedSensitive = decideResolvedReadPermission("D:\\repo", {
      requestedPath: ".env.local",
      resolvedPath: "D:\\repo\\config\\actual.txt",
      isDirectory: false,
      isSymbolicLink: false,
    });
    assert.equal(requestedSensitive.outcome, "approval_required");
    if (requestedSensitive.outcome !== "approval_required") return;
    assert.equal(requestedSensitive.reason, "environment_file");

    const resolvedSensitive = decideResolvedReadPermission("D:\\repo", {
      requestedPath: "safe.txt",
      resolvedPath: "D:\\repo\\.git\\config",
      isDirectory: false,
      isSymbolicLink: false,
    });
    assert.equal(resolvedSensitive.outcome, "approval_required");
    if (resolvedSensitive.outcome !== "approval_required") return;
    assert.equal(resolvedSensitive.reason, "protected_directory");
  });

  it("requires approval when the resolved target leaves the workspace", () => {
    const decision = decideResolvedReadPermission("D:\\repo", {
      requestedPath: "safe.txt",
      resolvedPath: "D:\\outside\\actual.txt",
      isDirectory: false,
      isSymbolicLink: false,
    });
    assert.equal(decision.outcome, "approval_required");
    if (decision.outcome !== "approval_required") return;
    assert.equal(decision.reason, "outside_workspace");
    assert.match(decision.disclosureWarning, /resolved target is outside/u);
  });

  it("denies symbolic-link and directory targets", () => {
    assert.deepEqual(
      decideResolvedReadPermission("D:\\repo", {
        requestedPath: "link.txt",
        resolvedPath: "D:\\repo\\target.txt",
        isDirectory: false,
        isSymbolicLink: true,
      }),
      { outcome: "denied", code: "symbolic_link" },
    );
    assert.deepEqual(
      decideResolvedReadPermission("D:\\repo", {
        requestedPath: "src\\",
        resolvedPath: "D:\\repo\\src",
        isDirectory: true,
        isSymbolicLink: false,
      }),
      { outcome: "denied", code: "directory_target" },
    );
  });

  it("fails closed on an invalid requested or resolved path", () => {
    assert.deepEqual(
      decideResolvedReadPermission("D:\\repo", {
        requestedPath: "CON",
        resolvedPath: "D:\\repo\\target",
        isDirectory: false,
        isSymbolicLink: false,
      }),
      { outcome: "invalid", code: "reserved_name" },
    );
    assert.deepEqual(
      decideResolvedReadPermission("D:\\repo", {
        requestedPath: "file.txt",
        resolvedPath: "\\\\?\\D:\\repo\\target",
        isDirectory: false,
        isSymbolicLink: false,
      }),
      { outcome: "invalid", code: "device_namespace" },
    );
  });
});
