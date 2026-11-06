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
  /** Called when the composer asked to open configuration. */
  onConfigRequest?: () => void;
}>;

export function startTui(
  controller: TuiController,
  options: StartTuiOptions = {},
): { unmount: () => void } {
  const { modelLabel, onConfigRequest } = options;
  let instance: Instance | null = null;

  const element = (): ReactElement =>
    createElement(App, {
      view: controller.view(),
      ...(modelLabel === undefined ? {} : { modelLabel }),
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
