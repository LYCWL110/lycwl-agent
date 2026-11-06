import type { ProviderConversationItem } from "../../ports/model-provider.ts";
import type { InternalEvent } from "./internal-events.ts";

/**
 * Rebuild a conversation from a Session's authoritative events.
 *
 * ADR-0054 recorded that persistence stored the record but a restart did not
 * reconstruct context, so "continuing a Session" meant only that the log survived.
 * This turns the log back into the neutral conversation the model needs.
 *
 * What can and cannot be recovered is a property of what the events carry:
 *
 * - user task text: recorded on `run_started`;
 * - assistant text: recorded on `model_response_validated`;
 * - tool calls: recorded on `tool_call_received`, including their arguments;
 * - tool results: recorded on `tool_execution_finished` with the delivered text.
 *
 * Anything the events do not carry is omitted rather than invented. A tool call
 * whose result was never recorded stays open, which is the honest state: the
 * conversation is then rejected by `validateNeutralHistory` rather than silently
 * repaired.
 */

export type RebuildResult =
  | Readonly<{ ok: true; conversation: readonly ProviderConversationItem[]; runs: number }>
  | Readonly<{ ok: false; code: "unpaired_tool_call"; detail: string }>;

/**
 * Rebuild the conversation for one Session.
 *
 * Only terminal Runs contribute. A Run that was still active or waiting when the
 * process stopped is skipped: its assistant turn may have no recorded response, and
 * inventing one would fabricate history.
 */
export function rebuildConversation(events: readonly InternalEvent[]): RebuildResult {
  const conversation: ProviderConversationItem[] = [];
  let runs = 0;

  // Per-Run accumulation, flushed when the Run reaches a terminal event.
  let pendingUser: string | null = null;
  let assistantText: string | null = null;
  let assistantSeen = false;
  const calls: {
    toolCallId: string;
    providerToolCallId: string;
    toolName: string;
    arguments: unknown;
  }[] = [];
  /** Text of the assistant turn that issued the calls; later turns must not overwrite it. */
  let callingTurnText: string | null = null;
  let callingTurnSeen = false;
  const results = new Map<
    string,
    {
      status: "succeeded" | "failed" | "denied" | "cancelled" | "outcome_unknown";
      text: string | null;
      toolName: string | null;
    }
  >();
  let runTerminal = false;

  const flush = (): void => {
    if (!runTerminal) return;
    if (pendingUser !== null) conversation.push({ kind: "user", text: pendingUser });

    if (assistantSeen) {
      conversation.push({
        kind: "assistant",
        // The turn that issued the calls is the one this group represents; a
        // later assistant message belongs to the following turn.
        text: callingTurnSeen ? callingTurnText : assistantText,
        toolCalls: calls.map((call) => ({
          providerToolCallId: call.providerToolCallId,
          toolName: call.toolName,
          arguments: call.arguments,
        })),
      });
    }

    for (const call of calls) {
      const result = results.get(call.toolCallId);
      if (result === undefined) continue;
      conversation.push({
        kind: "tool_result",
        providerToolCallId: call.providerToolCallId,
        toolName: result.toolName ?? call.toolName,
        status: result.status,
        text: result.text,
      });
    }

    runs += 1;
    pendingUser = null;
    assistantText = null;
    assistantSeen = false;
    callingTurnText = null;
    callingTurnSeen = false;
    calls.length = 0;
    results.clear();
    runTerminal = false;
  };

  for (const event of events) {
    switch (event.payload.kind) {
      case "run_started":
        // A new Run begins: flush whatever the previous one accumulated.
        flush();
        pendingUser = event.payload.input;
        break;
      case "model_response_validated":
        assistantText = event.payload.text;
        assistantSeen = true;
        // The first validated response of a Run is the one whose calls are
        // dispatched; a later response is the follow-up turn and must not
        // overwrite this group's text.
        if (!callingTurnSeen) {
          callingTurnText = event.payload.text;
          callingTurnSeen = true;
        }
        break;
      case "tool_call_received":
        calls.push({
          toolCallId: event.payload.toolCallId,
          providerToolCallId: event.payload.providerToolCallId,
          toolName: event.payload.toolName,
          arguments: event.payload.arguments,
        });
        break;
      case "tool_execution_finished":
        results.set(event.payload.toolCallId, {
          status: event.payload.status,
          text: event.payload.text,
          toolName: event.payload.toolName ?? null,
        });
        break;
      case "tool_execution_denied":
        results.set(event.payload.toolCallId, {
          status: "denied",
          text: null,
          toolName: event.payload.toolName,
        });
        break;
      case "tool_call_cancelled":
        results.set(event.payload.toolCallId, {
          status: "cancelled",
          text: null,
          toolName: event.payload.toolName,
        });
        break;
      case "run_completed":
      case "run_failed":
      case "run_cancelled":
        runTerminal = true;
        flush();
        break;
      default:
        break;
    }
  }

  // An unfinished Run is dropped, not guessed at.
  const dangling = calls.find((call) => !results.has(call.toolCallId));
  if (dangling !== undefined && runTerminal) {
    return {
      ok: false,
      code: "unpaired_tool_call",
      detail: `call ${dangling.providerToolCallId} has no recorded result`,
    };
  }

  return { ok: true, conversation, runs };
}

/**
 * Keep the trailing part of a rebuilt conversation within a budget.
 *
 * The most recent turns matter most for continuing work, so truncation removes the
 * oldest entries. A cut is only made at a turn boundary: starting the history with a
 * tool result would produce a conversation that answers a call nobody made.
 */
export function trimConversation(
  conversation: readonly ProviderConversationItem[],
  maxItems: number,
): readonly ProviderConversationItem[] {
  if (maxItems <= 0) return [];
  if (conversation.length <= maxItems) return [...conversation];

  let start = conversation.length - maxItems;
  // Advance to a safe boundary: a user turn, or an assistant turn that begins a
  // group. A tool result or a bare assistant turn without its preceding user turn is
  // not a valid start.
  while (start < conversation.length) {
    const item = conversation[start];
    if (item === undefined) break;
    if (item.kind === "user") break;
    start += 1;
  }
  return conversation.slice(start);
}
