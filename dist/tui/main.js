import { render } from "ink";
import { createElement } from "react";
import { App } from "./app.js";
export function startTui(controller, options = {}) {
    const { modelLabel, modeLabel, onConfigRequest } = options;
    let instance = null;
    let lastProjection = "";
    let stopped = false;
    let closing = false;
    let refreshTimer = null;
    function unmount() {
        if (stopped)
            return;
        stopped = true;
        if (refreshTimer !== null)
            clearInterval(refreshTimer);
        instance?.unmount();
    }
    async function closeSession(request = { kind: "quit" }) {
        if (closing || stopped)
            return;
        closing = true;
        try {
            await controller.close();
            unmount();
            if (request.kind === "config")
                onConfigRequest?.(request.page);
            if (request.kind === "session")
                options.onSessionRequest?.(request.sessionId);
            if (request.kind === "init")
                options.onInitRequest?.();
        }
        catch {
            unmount();
            (options.onCleanupError ?? ((code) => process.stderr.write(`${code}\n`)))("session_cleanup_failed");
        }
    }
    const element = () => createElement(App, {
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
                if (request !== null)
                    void closeSession(request);
                else
                    refresh();
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
    function refresh() {
        if (stopped)
            return;
        const projection = JSON.stringify(controller.view());
        if (projection === lastProjection)
            return;
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
