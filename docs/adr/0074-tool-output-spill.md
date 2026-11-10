# ADR-0074: Spill oversized tool output instead of truncating it

- Status: Accepted (2026-11-08)
- Related: ADR-0005 (C06 evidence/delivery), ADR-0065 (background delivery block), V1_BASELINE.md section 7

## Context

Tool results entered model context at whatever size the tool produced. Two tools
had a hard cap (`shell` at 20,000 units, `web_fetch` at its own limit) and the rest
had none: `read_file` with a large `lineCount`, `grep` over a big tree, an MCP tool
returning a report. The measured 20-turn session with 40 KB tool results showed
RSS growth and, more importantly, a context that fills with content the model
cannot use in full.

The reference implementations handle this differently. Miyu's
`crates/miyu-engine/src/agent/pruning.rs` `spill_tool_output` writes the full text to
a session file and inlines a head/tail preview plus a locator, skipping `read_file`
itself to avoid a read→spill→read loop. OpenCode has `tool-output.ts` and the
attachment path.

Truncation was rejected: it discards the middle permanently, so a large result
becomes unusable for anything except a summary of its beginning.

## Decision

A tool result larger than the spill threshold is written to the Session directory and
replaced in model context with a structured preview.

1. **Threshold 20,000 units, head 8,000, tail 4,000.** Below the threshold nothing
   changes. Above it the model receives the first and last part, the total size, the
   reference, and the instruction to read the rest with `read_file`.
2. **The preview is structured, not a bare cut.** It states that the output was
   spilled, the total size, the tool name, the reference, and how much is missing. A
   plain `...truncated` leaves the model unable to tell a complete result from a lost
   one, or to find the rest.
3. **Stored under the Session directory**, in `spill/<toolCallId>.txt`. Deleting the
   Session removes it. The write is immutable (`wx`): a second write for the same
   call id would indicate a duplicate execution, and overwriting would destroy the
   first result.
4. **A storage failure keeps the text inline.** Spilling is an optimisation; losing
   a successful result because storage was unavailable would be worse than a large
   turn.
5. **The reference is honest about readability.** Inside the workspace it is a
   relative path. Outside, the absolute path is reported but the preview says reading
   it needs approval, because a path `read_file` will refuse is a false promise.
6. **The owned-key guard runs first.** Spilling happens after the C10 check, so the
   guard still sees the real text; the stored copy is never the thing that reaches the
   model, and a blocked result is not written to disk.

## Consequences

- `domain/evidence/tool-spill.ts` owns preview construction.
- `ports/spill-store.ts` owns the capability; `adapters/persistence/spill-store.ts`
  implements it. The coordinator depends on the port, not the adapter.
- `tool_output_spilled` records the fact: total units, preview units, reference,
  readability. The event log stays readable because the validator accepts it.
- `#appendToolResult` becomes async, so all nine call sites await it.
- No permission, credential or output rule changes. The full text is in a file the
  model can read through the ordinary `read_file` approval path.

## Known limitations

- **`read_file` does not skip spilling**, unlike Miyu. Its output already goes
  through the line-bounded read path, so a spill would require reading the spill file
  to read the original. This should be revisited if a read-spill-read loop appears.
- **The threshold is a fixed count, not a share of the context window.** A Run with a
  small window can still receive a 19,999-unit result. Tying it to the computed
  context budget is the natural next step and is not done here.
- **No re-spill protection.** A spilled preview is small, so it cannot re-trigger,
  but nothing asserts that.

## Reassessment conditions

Reopen if a read→spill→read loop is observed, if the fixed threshold causes a context
overflow on a small window, or if attachments and spill files need a unified
lifecycle.
