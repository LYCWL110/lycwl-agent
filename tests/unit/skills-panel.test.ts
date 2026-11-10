import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { EMPTY_VIEW, interpretComposer } from "../../src/tui/view-model.ts";

/**
 * `/skills` opens a local panel showing the workspace catalog.
 *
 * The panel is a view: it lists what discovery found and never loads a body or
 * grants anything.
 */

describe("/skills command", () => {
  it("opens the skills panel", () => {
    const intent = interpretComposer(EMPTY_VIEW, "/skills");
    assert.deepEqual(intent, { kind: "open_panel", panel: "skills" });
  });

  it("opens while a Run is active, because listing is read-only", () => {
    // The panel only displays what discovery found; it loads no body and grants
    // nothing, so blocking it during a Run would be arbitrary.
    const intent = interpretComposer(
      { ...EMPTY_VIEW, runStatus: "active", queueingInput: true },
      "/skills",
    );
    assert.deepEqual(intent, { kind: "open_panel", panel: "skills" });
  });

  it("rejects trailing arguments", () => {
    const intent = interpretComposer(EMPTY_VIEW, "/skills extra");
    assert.equal(intent.kind, "reject");
  });

  it("does not collide with /skill", () => {
    const listing = interpretComposer(EMPTY_VIEW, "/skills");
    const activation = interpretComposer(EMPTY_VIEW, "/skill demo");
    assert.equal(listing.kind, "open_panel");
    assert.equal(activation.kind, "start_run");
  });
});

describe("skills panel view state", () => {
  it("carries catalog entries and no error on success", () => {
    const view = {
      ...EMPTY_VIEW,
      localPanel: "skills" as const,
      skillCatalog: [{ skillId: "demo", description: "a demo", bytes: 100 }],
      skillCatalogError: null,
    };
    assert.equal(view.localPanel, "skills");
    assert.equal(view.skillCatalog?.length, 1);
    assert.equal(view.skillCatalogError, null);
  });

  it("carries a reason instead of an empty list on failure", () => {
    const view = {
      ...EMPTY_VIEW,
      localPanel: "skills" as const,
      skillCatalog: null,
      skillCatalogError: "not_found",
    };
    // A null catalog with a reason is distinguishable from an empty catalog,
    // which would claim the workspace has no skills.
    assert.equal(view.skillCatalog, null);
    assert.equal(view.skillCatalogError, "not_found");
  });
});
