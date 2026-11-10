# ADR-0040: Wiring The Setup Screen Into The Launch Flow

- Status: Implemented and verified locally; no real vendor request made
- Date: 2026-11-05
- Related: ADR-0039; S02

## Context

ADR-0039 delivered a setup screen, a save path and a runtime selection rule, but
the running TUI never rendered the setup screen: configuring meant writing the files
by hand. That was the last structural gap before `lycwl` could be used normally.

## Decision

Add a launch flow that shows setup when nothing is configured, then starts whatever
the saved configuration selects.

### Flow (`bootstrap/setup-flow.ts`)

- `needsSetup` reads the settings document and asks whether a `provider` block
  exists. It does not infer configuration from file presence, because a file can
  exist and be empty, corrupt or partial.
- The setup screen is mounted **in place of** the main app, not alongside it. Both
  use Ink's `useInput`, so two active handlers would compete for keystrokes;
  mounting one at a time keeps routing unambiguous.
- After a successful save the flow re-loads the document and runs
  `selectRuntime` again rather than trusting the draft. A configuration that saves
  but cannot be assembled then reports that, instead of opening a broken session.
- A failed save re-renders the screen with the field error and **keeps the draft**.
  A failure with no field, such as a config conflict, is not shown as a field
  error, because the user cannot fix it by editing one field.

### Entry point

`lycwl` with no Provider configured prints a short explanation and opens setup.
With a Provider configured it prints the selection reason and starts the session.
`--setup` continues to print status and file locations without opening either UI.

## Architecture Violation Found And Fixed

The first version put the flow at `tui/setup-main.ts`, which imported
`bootstrap/setup-save.ts` and `bootstrap/runtime-selection.ts`. The architecture
test **failed immediately**:

```
tui\setup-main.ts imports forbidden "../bootstrap/runtime-selection.ts"
tui\setup-main.ts imports forbidden "../bootstrap/setup-save.ts"
```

That failure was correct. The TUI renders and submits; composing a runtime is not
its job. The module now lives at `bootstrap/setup-flow.ts` and imports the TUI
instead of the reverse, and the boundary scan is clean.

This is worth recording because the rule caught a mistake I made while adding a
feature, which is exactly what it exists for.

## Verification

- 1058 tests pass across 223 suites; the vitest suite covers both render tests
  (12 tests total).
- `needsSetup` is covered for: no file, file without a provider block, corrupt
  file, and after a successful save.
- Setup screen rendering is covered for: all fields and hints present, no
  secret-shaped content, a field-specific error, the plaintext warning, and the key
  field not being marked required when a credential exists.
- `--setup` prints both paths, the status and the storage warning.

No real vendor request was made.

## What Is Still Not There

- **The model still cannot call tools.** `assembleRuntime` receives an empty tool
  list because tool descriptions belong to the prompt layer, which is not wired.
  A session can therefore hold a conversation but cannot read a file through a
  tool call.
- **No streaming**, so section 7's stream clocks observe nothing.
- **The setup screen is reachable only on a first run.** There is no way to reopen
  it once configured except deleting the settings file; `--setup` prints status but
  does not edit.
- Three of four protocols remain unimplemented.

## Consequences

- `lycwl` now has a complete first-run path: setup, save, select, run.
- A user cannot accidentally start a demo believing it is configured, and cannot
  silently lose a draft to a save error.
- The remaining work is tool wiring and a re-open path, not launch plumbing.

## Reassessment Conditions

Wire tool schemas together with the prompt layer so descriptions have one owner.
Add a re-open path when the configuration surface grows beyond four fields.
