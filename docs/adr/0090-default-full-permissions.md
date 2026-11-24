# ADR-0090: Default To Full Permissions With A Read-Only Opt-Out

- Status: Accepted (2026-11-24)
- Related: ADR-0042 (write tools opt-in), ADR-0058 (shell enablement)
- Supersedes: ADR-0042, ADR-0058

## Decision

A launch has two permission modes:

| Command | Writes | Shell and background |
| --- | --- | --- |
| `lycwl` | enabled | enabled |
| `lycwl --read-only` | disabled | disabled |

Full permissions are the default. Every write and every command still requires
its own approval; the mode only decides whether those tools are wired and
advertised. `--write` and `--shell` are accepted for compatibility and ignored,
because there is no write-only mode any more. `--read-only` wins when it appears
with either historical flag, so a leftover `--write` in an alias cannot undo an
explicit opt-out.

Internally, `enableWrites` and `enableProcesses` remain separate. The one-mode
default is a CLI and product decision, not a collapse of the capability model:
the read-only composition still forces both off, the domain layer still refuses
shell in a read-only session, and tests can still construct a write-only or a
process-only runtime.

## Consequences

This reverses ADR-0042's "safe mode is the one you get by not asking". A user who
launches without reading the help now has write and shell tools available from
the first turn. Approval remains the gate, so no action runs without a decision,
but the blast radius of a mistaken approval is larger than in read-only mode.

The launch summary and `--help` state the default explicitly. The README does
not describe read-only as the default.

G02 (process supervision) remains open. Defaulting shell on increases exposure
without closing that gate, and ADR-0058's honesty requirement still applies: an
approved command runs with the user's full permissions and v1 has no sandbox.
