import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ReactElement } from "react";
import { InMemoryEventLog } from "../../src/application/coordinator/event-log.ts";
import { RuntimeCoordinator } from "../../src/application/coordinator/runtime-coordinator.ts";
import { createTuiController } from "../../src/tui/controller.ts";
import { startTui } from "../../src/tui/main.ts";
import { EMPTY_VIEW, interpretComposer } from "../../src/tui/view-model.ts";
import {
  JsonDigest,
  RecordingTools,
  ScriptedApprovalGate,
  ScriptedProvider,
  SequenceIds,
} from "../fakes/deterministic-services.ts";

function fixture(
  options: {
    canResumeSession?: (id: string) => Promise<boolean>;
    cleanup?: () => Promise<void>;
  } = {},
) {
  const ids = new SequenceIds("command");
  const provider = new ScriptedProvider([{ kind: "completed", text: "reply", toolCalls: [] }]);
  const tools = new RecordingTools(false, { status: "succeeded", text: null });
  const coordinator = new RuntimeCoordinator({
    provider,
    tools: {
      ...tools,
      getDefinition: () => null,
      execute: (...args) => tools.execute(...args),
      cancelAll: options.cleanup ?? (async () => undefined),
    },
    approvals: new ScriptedApprovalGate([]),
    eventLog: new InMemoryEventLog(ids, new JsonDigest()),
    ids,
    nowUtc: () => "2026-11-07T00:00:00.000Z",
  });
  return {
    provider,
    controller: createTuiController({
      coordinator,
      ...(options.canResumeSession === undefined
        ? {}
        : { canResumeSession: options.canResumeSession }),
    }),
  };
}

describe("local composer commands", () => {
  const cases = [
    ["/config", { kind: "open_config" }],
    ["/model", { kind: "open_model" }],
    ["/session", { kind: "open_panel", panel: "session" }],
    ["/help", { kind: "open_panel", panel: "help" }],
    ["/new", { kind: "switch_session", sessionId: null }],
    ["/session new", { kind: "switch_session", sessionId: null }],
    ["/session saved-1", { kind: "switch_session", sessionId: "saved-1" }],
    ["/session resume new", { kind: "switch_session", sessionId: "new" }],
    ["/memory", { kind: "open_panel", panel: "memory" }],
    [
      "/remember Show the failing evidence first",
      { kind: "remember_memory", type: "feedback", text: "Show the failing evidence first" },
    ],
    ["/remember user Use Chinese", { kind: "remember_memory", type: "user", text: "Use Chinese" }],
    [
      "/remember --replace abc123 Use the shorter answer",
      {
        kind: "remember_memory",
        type: "feedback",
        text: "Use the shorter answer",
        replaceId: "abc123",
      },
    ],
    ["/forget abc123", { kind: "forget_memory", id: "abc123" }],
    ["/cancel", { kind: "cancel_run" }],
    ["/quit", { kind: "quit" }],
  ] as const;
  for (const [text, intent] of cases)
    it(`interprets ${text} locally`, () => {
      assert.deepEqual(interpretComposer(EMPTY_VIEW, text), intent);
    });
  for (const status of ["active", "waiting"] as const) {
    for (const text of ["/model", "/config", "/session", "/session old", "/new"])
      it(`rejects ${text} while ${status}`, () => {
        assert.deepEqual(interpretComposer({ ...EMPTY_VIEW, runStatus: status }, text), {
          kind: "reject",
          reason: "run_active",
        });
      });
  }
  for (const text of [
    "/session ../outside",
    "/session CON",
    "/session a b",
    "/session resume",
    "/session resume NUL",
    "/model changed",
    "/quit extra",
    "/remember",
    "/remember --replace abc",
    "/forget",
    "/forget a b",
  ]) {
    it(`rejects invalid arguments ${text}`, () => {
      assert.deepEqual(interpretComposer(EMPTY_VIEW, text), {
        kind: "reject",
        reason: "invalid_command",
      });
    });
  }
  it("preserves path input and reports unrecognized commands", () => {
    assert.deepEqual(interpretComposer(EMPTY_VIEW, "/src/file.ts"), {
      kind: "start_run",
      text: "/src/file.ts",
    });
    assert.deepEqual(interpretComposer(EMPTY_VIEW, "/unknown"), {
      kind: "reject",
      reason: "unknown_command",
    });
  });
  it("opens and closes local panels without a model request or transcript entry", async () => {
    const { controller, provider } = fixture();
    for (const panel of ["help", "session"] as const) {
      await controller.submit(`/${panel}`);
      assert.equal(controller.view().localPanel, panel);
      controller.closePanel();
      assert.equal(controller.view().localPanel, null);
    }
    await controller.submit("/unknown");
    assert.match(controller.view().commandNotice ?? "", /Unknown command/);
    assert.equal(provider.requests.length, 0);
    assert.deepEqual(controller.view().transcript, []);
  });
  it("checks explicit resume before handing off, keeping errors on the current page", async () => {
    const checked: string[] = [];
    const { controller, provider } = fixture({
      canResumeSession: async (id) => {
        checked.push(id);
        return id === "saved";
      },
    });
    await controller.submit("/session");
    await controller.submit("/session missing");
    assert.equal(controller.takeNavigationRequest(), null);
    assert.equal(controller.view().localPanel, "session");
    assert.match(controller.view().commandNotice ?? "", /unavailable/);
    await controller.submit("/session saved");
    assert.deepEqual(controller.takeNavigationRequest(), { kind: "session", sessionId: "saved" });
    assert.equal(controller.takeNavigationRequest(), null);
    assert.deepEqual(checked, ["missing", "saved"]);
    assert.equal(provider.requests.length, 0);
  });
  for (const command of ["/model", "/config", "/new", "/quit"]) {
    it(`cleans up before ${command} handoff`, async () => {
      let release!: () => void;
      const cleanup = new Promise<void>((resolve) => {
        release = resolve;
      });
      const { controller } = fixture({ cleanup: () => cleanup });
      let element!: ReactElement<{ onSubmit: (text: string) => void }>;
      const events: string[] = [];
      const ui = startTui(controller, {
        mount: (value) => {
          element = value as typeof element;
          return {
            rerender: () => undefined,
            unmount: () => {
              events.push("unmounted");
            },
          };
        },
        onConfigRequest: (page) => {
          events.push(`config:${page}`);
        },
        onSessionRequest: (id) => {
          events.push(`session:${id}`);
        },
      });
      try {
        element.props.onSubmit(command);
        await new Promise((resolve) => setImmediate(resolve));
        assert.deepEqual(events, []);
        release();
        await new Promise((resolve) => setImmediate(resolve));
        assert.deepEqual(
          events,
          command === "/new"
            ? ["unmounted", "session:null"]
            : command === "/quit"
              ? ["unmounted"]
              : ["unmounted", `config:${command === "/model" ? "model" : "setup"}`],
        );
      } finally {
        release();
        ui.unmount();
      }
    });
  }
  it("does not activate a requested session after cleanup fails", async () => {
    const { controller } = fixture({
      cleanup: async () => {
        throw new Error("fixture");
      },
    });
    let element!: ReactElement<{ onSubmit: (text: string) => void }>;
    let activated = false;
    let failure = "";
    const ui = startTui(controller, {
      mount: (value) => {
        element = value as typeof element;
        return { rerender: () => undefined, unmount: () => undefined };
      },
      onSessionRequest: () => {
        activated = true;
      },
      onCleanupError: (code) => {
        failure = code;
      },
    });
    try {
      element.props.onSubmit("/new");
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(activated, false);
      assert.equal(failure, "session_cleanup_failed");
    } finally {
      ui.unmount();
    }
  });
});
