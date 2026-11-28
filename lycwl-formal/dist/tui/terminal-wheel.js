import { useStdin, useStdout } from "ink";
import { useEffect, useEffectEvent } from "react";
const ENABLE_MOUSE = "\u001b[?1000h\u001b[?1006h";
const DISABLE_MOUSE = "\u001b[?1000l\u001b[?1006l";
const PASTE_START = "\u001b[200~";
const PASTE_END = "\u001b[201~";
/** Observe SGR wheel reports without treating pasted escape sequences as actions. */
export function createWheelDecoder() {
    const decode = createMouseDecoder();
    return (chunk) => decode(chunk).filter((event) => "direction" in event);
}
export function createMouseDecoder() {
    let pending = "";
    let pasting = false;
    return (chunk) => {
        const events = [];
        for (const character of chunk) {
            if (character === "\u001b") {
                pending = character;
                continue;
            }
            if (pending === "")
                continue;
            pending += character;
            if (pending === PASTE_START || pending === PASTE_END) {
                pasting = pending === PASTE_START;
                pending = "";
                continue;
            }
            const report = /^\[<(\d{1,6});(\d{1,6});(\d{1,6})([Mm])$/u.exec(pending.slice(1));
            if (report !== null) {
                // Ignore Shift/Alt/Ctrl, retaining the wheel, motion and button bits.
                const button = Number(report[1]) & ~28;
                const column = Number(report[2]);
                const row = Number(report[3]);
                if (!pasting &&
                    report[4] === "M" &&
                    (button === 64 || button === 65) &&
                    column > 0 &&
                    row > 0) {
                    events.push({ direction: button === 64 ? "up" : "down", column, row });
                }
                if (!pasting && report[4] === "M" && Number(report[1]) === 0 && column > 0 && row > 0)
                    events.push({ column, row });
                pending = "";
                continue;
            }
            if (!PASTE_START.startsWith(pending) &&
                !PASTE_END.startsWith(pending) &&
                !/^\[(?:<\d{0,6}(?:;\d{0,6}){0,2})?$/u.test(pending.slice(1))) {
                pending = "";
            }
        }
        return events;
    };
}
export function useTerminalWheel(onWheel, onClick) {
    const { stdin, isRawModeSupported } = useStdin();
    const { stdout } = useStdout();
    const handleWheel = useEffectEvent(onWheel);
    const handleClick = useEffectEvent((event) => onClick?.(event));
    useEffect(() => {
        if (!("isTTY" in stdout) || stdout.isTTY !== true || !isRawModeSupported)
            return;
        const decode = createMouseDecoder();
        const receive = (chunk) => {
            for (const event of decode(chunk.toString())) {
                if ("direction" in event)
                    handleWheel(event);
                else
                    handleClick(event);
            }
        };
        let closed = false;
        function close() {
            if (closed)
                return;
            closed = true;
            stdin.removeListener("data", receive);
            process.removeListener("exit", close);
            if (!("destroyed" in stdout && stdout.destroyed) &&
                !("writableEnded" in stdout && stdout.writableEnded)) {
                stdout.write(DISABLE_MOUSE);
            }
        }
        // Ink owns raw input and filters mouse reports from keyboard events. Observe
        // the same bytes for scrolling, leaving its keyboard/paste parser in charge.
        stdin.on("data", receive);
        process.once("exit", close);
        stdout.write(ENABLE_MOUSE);
        return close;
    }, [stdin, stdout, isRawModeSupported]);
}
