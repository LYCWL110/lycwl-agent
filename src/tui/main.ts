import { type Instance, type RenderOptions, render } from "ink";
import { createElement, type ReactElement } from "react";

import { App } from "./app.ts";
import type { TuiController, TuiNavigationRequest } from "./controller.ts";

/**
 * Mount the TUI. A caller must supply a controller wired to a real coordinator;
 * this module performs no tool, network or credential work itself.
 */
export type StartTuiOptions = Readonly<{
  /** Shown in the footer so the active model is always visible. */
  modelLabel?: string;
  modeLabel?: string;
  /** Called when the composer asked to open configuration. */
  onConfigRequest?: (page: "setup" | "model") => void;
  onSessionRequest?: (sessionId: string | null) => void;
  /** Called when the composer asked to draft an AGENTS.md. */
  onInitRequest?: () => void;
  sessionId?: string;
  onCleanupError?: (code: string) => void;
  /**
   * Read an image from the system clipboard for Ctrl+V. Absent means paste carries
   * text only.
   */
  readClipboardImage?: () => Promise<
    | Readonly<{ kind: "image"; image: import("../ports/model-provider.ts").ProviderImage }>
    | Readonly<{ kind: "empty" }>
    | Readonly<{ kind: "too_large" }>
    | Readonly<{ kind: "unavailable" }>
  >;
  /** Injected terminal streams/mount for lifecycle verification. */
  mount?: (element: ReactElement, options: RenderOptions) => Pick<Instance, "rerender" | "unmount">;
}>;

export function startTui(
  controller: TuiController,
  options: StartTuiOptions = {},
): { unmount: () => void } {
  const { modelLabel, modeLabel, onConfigRequest } = options;
  let instance: Pick<Instance, "rerender" | "unmount"> | null = null;
  let lastProjection = "";
  let stopped = false;
  let closing = false;
  let refreshTimer: ReturnType<typeof setInterval> | null = null;

  function unmount(): void {
    if (stopped) return;
    stopped = true;
    if (refreshTimer !== null) clearInterval(refreshTimer);
    instance?.unmount();
  }

  async function closeSession(request: TuiNavigationRequest = { kind: "quit" }): Promise<void> {
    if (closing || stopped) return;
    closing = true;
    try {
      await controller.close();
      unmount();
      if (request.kind === "config") onConfigRequest?.(request.page);
      if (request.kind === "session") options.onSessionRequest?.(request.sessionId);
      if (request.kind === "init") options.onInitRequest?.();
    } catch {
      unmount();
      (options.onCleanupError ?? ((code) => process.stderr.write(`${code}\n`)))(
        "session_cleanup_failed",
      );
    }
  }

  const element = (): ReactElement =>
    createElement(App, {
      view: controller.view(),
      animated: true,
      ...(modelLabel === undefined ? {} : { modelLabel }),
      ...(modeLabel === undefined ? {} : { modeLabel }),
      ...(options.sessionId === undefined ? {} : { sessionId: options.sessionId }),
      onClosePanel: () => {
        controller.closePanel();
        refresh();
      },
      onCorrectCredential: async (secret) => {
        const saved = (await controller.correctCredential?.(secret)) ?? false;
        refresh();
        return saved;
      },
      ...(options.readClipboardImage === undefined
        ? {}
        : { onPasteImage: options.readClipboardImage }),
      onMcpAdd: (entry) => {
        void controller.addMcpServer(entry).then(refresh);
      },
      onMcpRemove: (serverId) => {
        void controller.removeMcpServer(serverId).then(refresh);
      },
      onInitConfirm: () => {
        void controller.confirmInit().then(refresh);
      },
      onSessionResume: (sessionId) => {
        // Resuming replaces the whole Session, so it leaves the TUI the same way
        // /session does rather than mutating the live one.
        void controller.submit(`/session resume ${sessionId}`).then(() => {
          const request = controller.takeNavigationRequest();
          if (request !== null) void closeSession(request);
          else refresh();
        });
      },
      onSessionRename: (sessionId, title) => {
        void controller.renameSession(sessionId, title).then(refresh);
      },
      onSessionDelete: (sessionId) => {
        void controller.deleteSession(sessionId).then(refresh);
      },
      onSubmit: (text, images) => {
        return controller.submit(text, images).then((accepted) => {
          const request = controller.takeNavigationRequest();
          if (request !== null) {
            void closeSession(request);
            return;
          }
          refresh();
          return accepted;
        });
      },
      onApprove: () => {
        void controller.approve().then(refresh);
      },
      onDeny: () => {
        void controller.deny().then(refresh);
      },
      onAnswer: (text) => {
        void controller.answer(text).then(refresh);
      },
      onDeclineQuestion: () => {
        void controller.declineQuestion().then(refresh);
      },
      onCancelRun: () => {
        void controller.cancelRun().then(refresh);
      },
      onQuit: () => {
        void closeSession();
      },
    });

  function refresh(): void {
    if (stopped) return;
    const projection = JSON.stringify(controller.view());
    if (projection === lastProjection) return;
    lastProjection = projection;
    instance?.rerender(element());
  }

  instance = (options.mount ?? render)(element(), {
    exitOnCtrlC: false,
    alternateScreen: true,
  });
  // A suspended Run promise has not settled yet; its recorded waits still need
  // to reach the screen so the user can answer or approve.
  refreshTimer = setInterval(refresh, 100);
  refreshTimer.unref();
  return { unmount };
}
