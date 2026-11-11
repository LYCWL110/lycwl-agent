# ADR-0081: Separate result completeness from execution status

- Status: Accepted (2026-11-08)
- Related: ADR-0074 (spill), ADR-0079 (uncertain outcomes), ADR-0080 (argument schema)

## Context

Partiality lived only in the tool result text, as a marker like
`[truncated: model budget]`. Three problems with that:

1. **The model had to read prose to learn a fact.** A marker can be paraphrased
   away by a later summary, and a result with no marker is indistinguishable from
   one where the marker was lost.
2. **A report could not tell.** The task report and replay read events, not text
   markers, so completeness was invisible to them.
3. **"Partial" and "unknown" looked the same.** A truncated listing and a timed-out
   payment both produced a short result, and the difference between "there is more"
   and "nobody knows" is the difference between fetching the next page and stopping.

## Decision

`ToolExecutionResult.completeness` carries `{ outcome, reason, continuation }`,
independent of `status`.

| Situation | status | outcome |
| --- | --- | --- |
| Small result | succeeded | (absent = complete) |
| Output cut for the token budget | succeeded | partial / model_budget |
| Tool page limit reached | succeeded | partial / page_limit |
| Output stored, preview shown | succeeded | partial / spilled |
| Payment timed out | outcome_unknown | **unconfirmed** / unverified |
| Confirmed failure | failed | (absent) |

The two axes answer different questions and must not be collapsed. `status` is "did
the call finish normally". `outcome` is "is what the model received the whole
result".

### Absent means complete

A complete result carries no field. Writing `outcome: "complete"` on every call
would be noise on the common path, and older records have no field, so a replay must
treat absence as complete rather than unknown.

### Unconfirmed is not partial

An uncertain execution reports `unconfirmed`, not `partial`. Partial claims a result
arrived and more exists; unconfirmed says the effect could not be established. The
first invites a continuation, the second forbids a retry.

### Both text and field

The text marker stays, and the field is added. The model reads text; a report reads
the field. Neither alone is enough.

`mergeCompleteness` keeps the most severe outcome across stages, so a result that
was spilled and then also had an uncertain effect stays `unconfirmed`.

## Consequences

- `domain/tool-invocation/result-completeness.ts` owns the vocabulary and rendering.
- `tool_execution_finished` records the optional field; the validator accepts it.
- Spill sets `partial/spilled` with a continuation naming the stored copy.
- `outcome_unknown` sets `unconfirmed/unverified`.
- Existing markers changed from `[truncated: model budget]` to
  `[partial: cut to fit the token budget]` so the text and the field agree; four
  existing tests asserted the old wording and were updated.

## Known limitations

- **Only the spill and unknown paths set it.** `shell`, `web_fetch` and LSP emit the
  text marker but do not yet set the field, because the coordinator does not inspect
  tool text to guess completeness — that would be reading prose, which is what this
  ADR removes.
- **No tool declares `page_limit` yet.** The vocabulary exists; no tool pages.
- **The continuation is prose**, not a structured next-call. A model must interpret
  it rather than construct a follow-up mechanically.

## Reassessment conditions

Reopen if a tool needs structured continuation, if the text marker and the field are
found to disagree, or if a report needs per-reason completeness statistics.
