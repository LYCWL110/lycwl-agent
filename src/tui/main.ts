import { type Instance, render } from "ink";
import { createElement, type ReactElement } from "react";

import { App } from "./app.ts";
import type { TuiController } from "./controller.ts";

/**
 * Mount the TUI. A caller must supply a controller wired to a real coordinator;
 * this module performs no tool, network or credential work itself.
 */
export type StartTuiOptions = Readonly<{
  /** Shown in the footer so the active model is always visible. */
  modelLabel?: string;
  modeLabel?: string;
  /** Called when the composer asked to open configuration. */
  onConfigRequest?: () => void;
}>;

export function startTui(
  controller: TuiController,
  options: StartTuiOptions = {},
): { unmount: () => void } {
  const { modelLabel, modeLabel, onConfigRequest } = options;
  let instance: Instance | null = null;
  let lastProjection = "";
  let stopped = false;
  let refreshTimer: ReturnType<typeof setInterval> | null = null;

  function unmount(): void {
    stopped = true;
    if (refreshTimer !== null) clearInterval(refreshTimer);
    instance?.unmount();
  }

  const element = (): ReactElement =>
    createElement(App, {
      view: controller.view(),
      animated: true,
      ...(modelLabel === undefined ? {} : { modelLabel }),
      ...(modeLabel === undefined ? {} : { modeLabel }),
      onSubmit: (text) => {
        void controller.submit(text).then(() => {
          // A /config request must be consumed before the view is redrawn, so
          // the browser mounts instead of the stale app.
          if (controller.takeConfigRequest()) {
            unmount();
            onConfigRequest?.();
            return;
          }
          refresh();
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
        unmount();
      },
    });

  function refresh(): void {
    if (stopped) return;
    const projection = JSON.stringify(controller.view());
    if (projection === lastProjection) return;
    lastProjection = projection;
    instance?.rerender(element());
  }

  instance = render(element(), { exitOnCtrlC: false });
  // A suspended Run promise has not settled yet; its recorded waits still need
  // to reach the screen so the user can answer or approve.
  refreshTimer = setInterval(refresh, 100);
  refreshTimer.unref();
  return { unmount };
}
