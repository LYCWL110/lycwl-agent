# ADR-0087: Discover model context capacity and fall back to 272k

- Status: Accepted (2026-11-16)
- Related: ADR-0030 (context budgeting), ADR-0069 (model details), ADR-0071 (reasoning declarations)

## Decision

Retain upstream-declared reasoning choices and the existing three protocol
parameter mappings. Context discovery is independent: knowing reasoning levels
does not imply knowing context capacity. The production configuration flow also
queries missing context when selecting a model and before saving.

Prefer a valid context declaration in the list. Query selected-model details when
needed; use exactly 272000 tokens when no valid declaration can be obtained.
Explicit manual context remains an override, including legacy configurations
without a source label. Store the source as upstream, manual or default; display
the default as unverified. Legacy null windows resolve to the default at runtime,
without rewriting the user's settings during launch. Context arithmetic remains
strict: callers must provide a resolved budget before making model requests.

Recognize context_length, context_window, contextWindow, max_context_length and
limits.context. Only in their absence use max_input_tokens or input_token_limit.
Accept safe integer capacities from 8192 through 4000000, consistent with the
existing configuration boundary. Missing, malformed or conflicting values are
unknown. max_output_tokens is never a context capacity. Duplicate records do not
combine conflicting declarations; reasoning and context invalidity are separate.

List and successful detail metadata survive browser-to-form navigation only
within the same endpoint, protocol, credential reference and explicit key scope.
Refresh and connection changes invalidate metadata. Selection changes invalidate
pending saves and late replies; focus-only changes do not. Existing valid list
reasoning is not replaced by a context lookup's unrelated reasoning fields.

## Verification and limits

New independent metadata and Linux configuration tests cover all recognized
fields, invalid/conflicting capacities, list/detail fallback, save races, manual
overrides, cache scope, legacy runtime defaults and reasoning preservation. Existing
Windows test files remain unchanged.

No generation probes or paid requests are made for discovery. The 272k fallback
is a product policy, not verified model compatibility; smaller upstream models
can still reject oversized prompts. It supersedes the previous policy of blocking
every request solely because context metadata was unavailable.
