# ADR-0029: JSONC Configuration Parsing, Localized Edits And Save Concurrency

- Status: Confirmed implementation of already-confirmed design; no new dependency
- Date: 2026-11-05
- Related: V1_BASELINE.md sections 13; V1_BEHAVIOR_CONTRACTS.md section 9; C09

## Context

The confirmed design requires localized JSONC edits that preserve unrelated
comments and formatting, draft validation, and a compare-and-swap save under a
local-user configuration lock that returns `config_conflict` or `config_busy`
rather than silently overwriting.

None of it existed, and `jsonc-parser` is not installed. Installing a dependency
requires separate authorization, so the choice was between blocking on that
authorization or writing the smallest parser that satisfies the contract.

## Decision

Write a small JSONC parser and localized edit layer, and implement the save
protocol exactly as specified.

### Parser (`domain/config/jsonc.ts`)

Supports objects, arrays, strings, numbers, booleans, null, `//` and block
comments, trailing commas and a UTF-8 BOM. Every value node records `start`/`end`
offsets, which is what makes a localized edit possible.

Rejected on purpose:

- **duplicate object keys** — last-writer-wins would silently hide a mistake in a
  file a human edited;
- unterminated comments or strings, invalid escapes, raw control characters;
- content after the root value.

The parser is not a general YAML or JSON5 reader, and it does not try to be.

### Localized edits (`domain/config/jsonc-edit.ts`)

`replaceTopLevelValue`, `insertTopLevelValue` and `removeTopLevelKey` splice one
span and leave every other byte alone. Insertion detects the existing indentation
and the document's newline style so the result looks hand-written.

Removal takes the trailing comma when there is one and the preceding comma when
the member is last. Comments that belonged to a removed member stay put: guessing
which comment "belongs" to a key would be a second, unfounded interpretation.

Only scalars are writable. Objects and arrays are refused rather than serialized,
because the configuration surface this project has confirmed is flat key/value.

### Save protocol (`adapters/windows/config-store.ts`)

- Validation happens before and after the write, so a save can never leave an
  invalid document behind.
- The lock is an exclusively-created `settings.lock` file (`wx`), retried for up
  to 2s. Failure returns `config_busy` and writes nothing.
- Inside the lock the file is re-read and compared against
  `{baseRevision, baseDocumentHash}`. A mismatch returns `config_conflict` with
  **both** the caller's draft and the current disk state, so nothing is merged and
  nothing is lost.
- The document hash catches a hand edit that did not bump the revision, which a
  revision-only check would miss.
- `revision` is bumped with a localized edit, so the user's comments survive the
  save.
- Replacement uses a temporary file in the same directory.

## Deliberate Limits

- **This is not power-loss safety.** A rename is not a crash-consistent commit,
  and the ADR that owns the design says so; G03/G05 must verify it.
- The lock is this project's own file lock, separate from the Session writer and
  the search ledger lock, as the contract requires. It is not a general IPC
  mechanism.
- An unknown `schemaVersion` is refused. "Fields we do not recognize" is not
  treated as ignorable: depending on unverified state is how a config file becomes
  an unintended authority.
- The parser is a hand-written subset. If a future need genuinely requires JSON5
  or a full YAML frontmatter shape, that is a new decision with tests, not a quiet
  relaxation of this one.

## Consequences

- Configuration can now be edited and saved without destroying user formatting or
  letting two instances silently clobber each other.
- No runtime behaviour changed: nothing loads configuration yet. The store is a
  library with tests, not a wired feature.
- The confirmed conflict and busy shapes are now executable and proven, including
  that a conflicted save keeps the draft and leaves the winner on disk.

## Reassessment Conditions

Revisit if the configuration surface needs nested structures, or if `jsonc-parser`
is authorized later and its behaviour is shown to differ in a way that matters.
Neither justifies keeping a silently-lossy edit path today.
