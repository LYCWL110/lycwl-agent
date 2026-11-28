export function injectCrashAt(events, cutPoint) {
    const cutIndex = findCutIndex(events, cutPoint);
    return {
        cutPoint,
        surviving: events.slice(0, cutIndex),
        lost: events.slice(cutIndex).map((event) => event.type),
    };
}
function findCutIndex(events, cutPoint) {
    switch (cutPoint) {
        case "before_dispatch_commit": {
            const index = events.findIndex((event) => event.payload.kind === "tool_dispatch_committed");
            return index === -1 ? events.length : index;
        }
        case "after_commit_before_start": {
            const commitIndex = events.findIndex((event) => event.payload.kind === "tool_dispatch_committed");
            if (commitIndex === -1)
                return events.length;
            return commitIndex + 1;
        }
        case "during_execution": {
            const startIndex = events.findIndex((event) => event.payload.kind === "tool_execution_started");
            if (startIndex === -1)
                return events.length;
            return startIndex + 1;
        }
        case "after_result": {
            const resultIndex = events.findIndex((event) => event.payload.kind === "tool_execution_finished" ||
                event.payload.kind === "tool_execution_denied" ||
                event.payload.kind === "tool_call_cancelled");
            return resultIndex === -1 ? events.length : resultIndex + 1;
        }
    }
}
/**
 * A truncated event list cannot be replayed as a finished Run: replay requires a
 * reportable terminal or waiting state. This documents the expected outcome
 * instead of asserting one in every caller.
 */
export function canReplayTruncated(events) {
    const last = events.at(-1);
    if (last === undefined)
        return false;
    return (last.payload.kind === "run_completed" ||
        last.payload.kind === "run_failed" ||
        last.payload.kind === "run_cancelled" ||
        last.payload.kind === "run_waiting");
}
