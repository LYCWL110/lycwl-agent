# ADR-0103: High-Risk Approvals Start On Cancel

- Status: Accepted (2026-11-26)
- Related: ADR-0021 (web boundaries), ADR-0085 (shell risk), ADR-0095 (approval control)

## Decision

Ordinary tool approvals still start on `Approve`, so the same single Enter
keeps the previous behavior. A small high-consequence set starts on `Cancel`:

- `delete_path`;
- `shell` commands whose structured preview contains `risk=destruction`,
  `risk=history_rewrite`, `risk=privilege_change`, or a forced/recursive
  deletion marked "without prompting";
- sensitive-context redisclosure, which already started on Cancel.

The decision reads the recorded `risk=` preview lines, not the raw command text.
The user can still move left and approve explicitly. Approval remains per call;
this is not a sandbox and does not remove the approval step.

## Consequences

A mistaken Enter on a disk-destroying or history-rewriting command denies it
instead of running it. Ordinary commands do not gain a keypress. A risk line is
an annotation, not a complete detector; commands outside the listed categories
still start on Approve and still require the user to read the preview.

## Reassessment Conditions

Revisit if the risk classifier gains reliable categories for data egress or
process termination, or if a new destructive tool appears.
