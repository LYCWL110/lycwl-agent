import { type Instance, render } from "ink";
import { createElement, type ReactElement } from "react";

import { App } from "./app.ts";
import type { TuiController } from "./controller.ts";

/**
 * Mount the TUI. A caller must supply a controller wired to a real coordinator;
 * this module performs no tool, network or credential work itself.
 */
export function startTui(
  controller: TuiController,
  /** Called when the composer asked to open configuration. */
  onConfigRequest?: () => void,
): { unmount: () => void } {
  let instance: Instance | null = null;

  const element = (): ReactElement =>
    createElement(App, {
      view: controller.view(),
      onSubmit: (text) => {
        void controller.submit(text).then(() => {
          // A /config request must be consumed before the view is redrawn, so
          // the browser mounts instead of the stale app.
          if (controller.takeConfigRequest()) {
            instance?.unmount();
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
        instance?.unmount();
      },
    });

  function refresh(): void {
    instance?.rerender(element());
  }

  instance = render(element());
  return { unmount: () => instance?.unmount() };
}
