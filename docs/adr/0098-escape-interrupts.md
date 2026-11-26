# ADR-0098: Escape Interrupts A Run; Ctrl+C Exits When Idle

- Status: Accepted (2026-11-26)
- Related: ADR-0090 (default permissions), ADR-0095 (approval control)

## Decision

Escape follows the OpenCode split between interrupting and exiting:

- while a Run is `active` or `waiting`, Escape cancels that Run;
- when the Run is idle, Escape does nothing outside a panel;
- Escape still dismisses the command menu and closes local panels;
- Ctrl+C cancels a busy Run and exits when idle;
- `/quit` always exits.

OpenCode's TUI source binds `session.interrupt` to `escape` and `app.exit` to
`ctrl+c,ctrl+d,<leader>q`. The previous Escape binding here called the exit path
directly, which made an interrupt key close the program instead.

## Consequences

Escape is safe to press while a model turn is running. Exiting now requires
Ctrl+C while idle or `/quit`. The composer hint states that, and the alternate
screen is restored only on an actual exit.

## Reassessment Conditions

Revisit if the TUI gains a configurable keybind file, or if Escape should clear
the draft while idle rather than doing nothing.
