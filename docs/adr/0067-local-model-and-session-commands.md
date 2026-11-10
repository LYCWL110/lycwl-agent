# ADR-0067: Local Model And Session Commands

- Date: 2026-11-07
- Status: Authorized by the user's request to add /model, /session and related commands
- Owners: V1_DESIGN_SUPPLEMENTS S02; V1_BASELINE sections 3/7/9
- Related: ADR-0063, ADR-0064, ADR-0065, ADR-0066; V1_CONTRACTS C03/C08

## Decision

Extend the existing finite command list, without a plugin command framework.
`/model` opens the existing model browser in the model column, loads the list
through the existing validated destination/key path, and preserves reasoning
selection. Missing usable configuration opens the connection form instead.
`/config` continues opening that form. Saved choices apply to the next Run.

`/session` shows the current identity and explicit keep/new/resume choices.
`/new` and `/session new` create a random new identity without deleting records.
`/session resume <id>` explicitly selects recorded history, with `/session <id>`
as shorthand except for reserved command arguments. Shared CLI/TUI ID validation
rejects path traversal and Windows reserved device names. Resume checks existing,
nonempty log metadata before leaving the current screen. It does not enumerate
all historical sessions or silently select another conversation.

`/help` opens local help, `/cancel` invokes existing cancellation, and `/quit`
uses the existing awaited Session cleanup. Configuration/model/session commands
are unavailable during active or waiting Runs; local help/cancel/quit remain
available. Question and approval reply input retains literal handling.
Unknown command words receive local feedback instead of model dispatch.

Bootstrap owns runtime/configuration composition and filesystem inspection.
The TUI controller emits a one-shot navigation request. Await Session cleanup,
unmount, then activate the requested view; cleanup failure prevents handoff.
Model/configuration reload retains the identity. Historical events are checked
against the owned-key registry before supplying a visible transcript; history
failure keeps dispatch blocked through the existing preflight path. Historical
waits are transcript facts rather than revived pending controls.

Keep suggestions as a bounded overlay with English descriptions. Arrow
navigation scrolls a long command list, including narrow terminals. The overlay
may temporarily cover transcript lines but preserves composer placement and
scroll position. Escape closes help/session views without answering a question,
approving a tool or exiting the application.

## Validation And Limits

The user's subsequent 2026-11-07 correction asks for reasoning selection to the
right of the model. The existing browser now has a fourth Reasoning column:
left/right or Tab moves focus, up/down selects a level and Enter saves the
model and effort together. Narrow layouts keep Model and Reasoning adjacent
while either is focused. The existing `r` shortcut remains. Anthropic shows
unavailable and stays at default. This changes presentation/navigation only,
with no additional protocol mapping or compatibility assertion.

Follow-up validation: 62 browser/configuration/architecture tests and 64 TUI
tests passed, including arrow selection, persistence/reopening, existing
request serialization and side-by-side layout at 40/60/80/120 columns.

Local regression tests cover command interpretation, invalid arguments, busy
state restrictions, navigation cleanup ordering, model list/effort persistence,
new-session isolation, explicit history restoration, missing records, keyboard
completion/menu scrolling and 40-column page/input layout. Synthetic Providers
and credentials are used; no real or paid Provider request is needed.

No searchable history catalog, deletion, cross-session memory, new permissions,
automatic resume, migration of the existing storage layout, or execution replay
is introduced. G01-G10 and full Windows Terminal visual acceptance remain open.
