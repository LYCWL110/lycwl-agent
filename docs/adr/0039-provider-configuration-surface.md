# ADR-0039: Provider Configuration Surface And Runtime Selection

- Status: Implemented and verified locally; no real vendor request made
- Date: 2026-11-05
- Related: ADR-0037 (adapter), ADR-0038 (credential storage); C03; S02

## Context

After ADR-0037 (real adapter) and ADR-0038 (usable credential storage), the
remaining gap between the code and a working tool was one thing: nothing let a user
*configure* a provider, and the entry point always built the demo runtime. The
project had all the parts and no way to connect them.

## Decision

Add a configuration model, a setup screen, a save path and a runtime selection
rule, and wire the entry point to them.

### Configuration model (`domain/config/provider-config.ts`)

Validates a draft into a `ProviderConfig`. Two refusals matter:

- **An unsupported protocol is rejected as unsupported.** OpenAI and Google
  protocols are not implemented, so accepting those strings would let a user
  configure something nothing can serve.
- **A plaintext `http` base URL is refused.** Unlike WebFetch, there is no
  confirmation flow on this path, and the adapter refuses it too.

A query or fragment on the base URL is also rejected, because the protocol path is
appended and those components would be silently dropped — the request would go
somewhere other than what the user typed.

### Setup screen (`tui/setup-screen.ts`)

Field-by-field editing with `tab` to move, `enter` to save, `esc` to discard.

- the API key never echoes, and `maskSecret` returns a **fixed-width** mask rather
  than a length hint, because the length of a short key is itself information;
- a validation error is shown against the specific field and the draft is kept;
- save and discard are separate actions;
- the screen performs no I/O.

### Save path (`bootstrap/setup-save.ts`)

Order is deliberate: validate, then write the credential, then write the settings
document. If the settings write fails, an unreferenced credential may exist, which
is recoverable. The reverse order would leave settings pointing at a key that was
never stored, which fails later as an opaque authentication error.

The key never enters the settings file: the document holds
`{ protocol, baseUrl, model, credentialRef, maxOutputTokens }` and the vault holds
the secret. A test asserts the settings text does not contain the key.

### Runtime selection (`bootstrap/runtime-selection.ts`)

The rule: **the runtime is chosen from configuration, never from a flag.**

| State | Result |
| --- | --- |
| no settings document | demo, reason `no_configuration` |
| valid settings and a stored credential | real provider |
| settings present but unusable | demo, with the specific failure printed |

The last row is the important one. A saved configuration that cannot be assembled
does not silently become the demo: the reason is printed before the TUI starts,
because a demo that looks like a working agent is the most misleading outcome
available. `--setup` prints both file paths, the revision, the resolved provider,
and the plaintext-storage warning.

## Defect Found While Testing

The first implementation wrote the `provider` block as a **JSON-escaped string**
instead of an object:

```json
"provider": "{\n  \"protocol\": \"anthropic_messages\", ... }"
```

Cause: I reused `replaceTopLevelValue`, which only accepts scalars, and cast the
serialized object through it. A second save then failed with `missing_field`
because re-reading found a string where an object was expected.

The test caught it only because it saved twice. A single-save test would have passed
while producing a document that could never be read back — the settings would have
looked written and been permanently unusable. Fixed by splicing a real object
literal and preserving everything outside its span.

## Verification

A local probe against a temporary directory confirmed the full chain:

```
no config          -> demo (no_configuration)
save               -> ok
configured         -> real claude-test
missing credential -> demo (credential_missing)
```

1052 tests pass. 17 new tests cover config validation, endpoint path construction,
mask semantics, credential-then-settings ordering, comment preservation, the
second-save case that exposed the defect, and the empty-key-with-existing-credential
case.

## What This Is Still Not

- **No TUI path to the setup screen yet.** `SetupScreen` and `saveSetup` exist and
  are tested, but the running TUI does not render it; configuring currently means
  writing the files. That is the next step, not a finished feature.
- **No tool schemas are sent to the model.** `assembleRuntime` receives an empty
  tool list, so the model cannot call tools even though the coordinator can execute
  them.
- **No streaming**, so the section 7 stream clocks still have nothing to observe.
- No real vendor request was made, and three of four protocols remain unimplemented.

## Consequences

- A user can now configure a provider, and the entry point uses it.
- The demo fallback is loud, so an unusable configuration cannot be mistaken for a
  working agent.
- The remaining work is a UI path and tool-schema wiring, not protocol work.

## Reassessment Conditions

Wire the setup screen into the TUI and populate tool schemas only together with the
prompt layer, so tool descriptions come from one owner rather than being invented in
the bootstrap.
