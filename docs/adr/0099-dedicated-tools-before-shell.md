# ADR-0099: Dedicated Tools Before Shell, With A Bounded Curl Fallback

- Status: Accepted (2026-11-26)
- Related: ADR-0021 (web boundaries), ADR-0085 (shell risk annotation), ADR-0096 (native search)

## Decision

The Harness rules prefer a dedicated tool for every operation. Shell remains
reserved for commands that genuinely need a shell.

When no dedicated tool can express the operation, a shell command such as `curl`
is allowed with its normal approval. The fallback is for a structural gap, for
example a request method or body that `web_fetch` does not implement. It is not a
way around a refusal: a denied approval, a policy refusal, an unsupported scheme,
a forbidden header, or an address-binding failure must be fixed or reported, not
retried through shell.

The rule is in the trusted Harness prompt (`using-tools`) and bumps the prompt
template version to 6.

## Consequences

The model can reach HTTP APIs that the narrow `web_fetch` surface cannot express.
That path loses `web_fetch`'s address pinning, redirect refusal, header allowlist
and response-size policy; the shell risk annotation and per-command approval are
the remaining controls.

The AgentGuide ReAct page reviewed for this change says "use only the listed
tools" and recommends Tool Cards. It does not define a shell fallback. This ADR
records the fallback our Harness chooses, not a requirement copied from that page.

## Reassessment Conditions

Revisit if `web_fetch` grows method/body support, if shell network access needs its
own address policy, or if a fallback is used to bypass a dedicated-tool refusal.
