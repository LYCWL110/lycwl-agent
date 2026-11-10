# ADR-0075: Context meter, file snapshots for undo, and image input

- Status: Accepted (2026-11-08)
- Related: ADR-0005 (C04/C06), ADR-0073 (MCP scope), ADR-0074 (spill)

## Context

Three capabilities present in the reference projects were missing here. They are
unrelated in implementation but were requested together and are recorded together.

1. **Context occupancy.** Miyu's `agent/context_meter.rs` reports how full the window
   is. This Harness computed a C04 budget at Run start and never showed live usage,
   so the user could not see a Run approaching compaction.
2. **Undo.** OpenCode's `snapshot.ts` captures a content-addressed tree in a shadow
   Git repository. This Harness had no way to revert a bad edit short of `git`.
3. **Image input.** Miyu's `tools/vision/` and OpenCode's `image/` both let the model
   see images. This Harness had no image path at all: the conversation type carried
   text only.

## Decision

### Context meter

`domain/context/context-meter.ts` reports `used`, `window`, `fraction`, `source` and
`atCompaction`. Two sources, in priority order:

- **Measured**: `inputTokens` from the newest validated response, which is the
  provider's own count of the prompt it received.
- **Estimated**: a coarse local estimate at four characters per token, used before
  the first response exists.

The source is reported alongside the number, and the footer shows a raw count rather
than a percentage when the window is unknown. A percentage without a denominator
would be invented.

The estimate is deliberately coarse. A precise local tokenizer is a large dependency
for a figure that is displayed and not acted on: compaction decisions still use the
conservative C04 budget, not this number.

### File snapshots for undo

`domain/persistence/snapshot.ts` plus `adapters/persistence/snapshot-store.ts` capture
a file's content before a mutation, addressed by SHA-256, under the Session directory.

- **First capture of a path wins within a Run.** It holds the state before the Run
  touched the file, which is what reverting to the Run's start means.
- **A created file is recorded as absent**, so undo deletes it.
- **Limits**: 5 MiB per file, 256 files and 64 MiB per Run. A refused capture emits
  `snapshot_unavailable` rather than silently leaving a file that cannot be reverted.
- **`/undo` restores** through `bootstrap/undo.ts`, which repeats the workspace prefix
  check so a stored path cannot escape even if the index was edited on disk, and
  refuses to write a snapshot whose digest does not verify.

This is not OpenCode's design. Theirs shells out to Git, creates a shadow repository
and packs objects on a timer — a large amount of machinery for reverting one Run. The
trade-off accepted here is disk space instead: a snapshot of a 5 MiB file costs 5 MiB.

**Shell commands are not snapshotted.** The Harness cannot enumerate the paths a
command writes, so it cannot capture them. This is a real limitation, recorded rather
than hidden: undo covers the file tools, not arbitrary command effects.

### Image input

`ProviderImage` carries base64 plus a media type, and is attached to the task turn.

- **The media type comes from magic bytes, never the extension.** A `.png` that is
  actually a JPEG would be declared wrongly, and the provider trusts the declaration.
- **The resolved path must stay inside the workspace.** A symlink is followed before
  the check, so it cannot be used to escape.
- **Limits**: 5 MiB per image, 4 images per turn. Base64 inflates by a third and the
  bytes travel on every request that includes the turn, so a large image is expensive
  on every round rather than once.
- **Each protocol gets its own shape**: Anthropic `image` content blocks, Chat
  Completions `image_url` data URLs, Responses `input_image` data URLs. All three put
  the image before the text so the model reads it as "look at this, then answer".

`/image <path>` reads the file before the Run starts, so a missing or oversized file
is a clean refusal rather than a Run that fails partway.

## Consequences

- New: `domain/context/context-meter.ts`, `domain/persistence/snapshot.ts`,
  `ports/snapshot-store.ts`, `adapters/persistence/snapshot-store.ts`,
  `adapters/windows/image-loader.ts`, `bootstrap/undo.ts`.
- `ProviderConversationItem` user turns accept optional `images`.
- `CoordinatorResult` and the footer expose context occupancy and, from ADR-0072, token
  totals.
- New slash commands: `/undo`, `/image <path>`.
- New event: `snapshot_unavailable`.

## Known limitations

- The meter's estimate does not count tool schemas; only the measured path includes
  the real prompt. The footer therefore understates before the first response.
- Undo covers file tools only, not shell side effects.
- Images are not persisted in the event log; a resumed Session cannot replay them.
- No image is validated beyond its container format: dimensions, decode success and
  decompression bombs are not checked.

## Reassessment conditions

Reopen if the estimate proves misleading in practice, if undo needs to cover shell
effects, or if images must survive a Session resume.
