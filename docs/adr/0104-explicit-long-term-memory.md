# ADR-0104: Explicit, User-Controlled Long-Term Memory

- Status: Accepted (2026-11-26)
- Related: ADR-0084 (memory excluded from v1), ADR-0044 (project guidance), ADR-0030 (compaction)

## Decision

Add a first long-term memory surface with one rule: **only an explicit user
command writes memory**. There is no model-facing memory tool, no extraction from
session logs, no background distillation, and no vector store.

The store lives under the application state directory in `memory/memory.json`,
separate from Session logs. Entries carry:

- `type`: `user`, `feedback`, `project`, `reference`;
- `scope`: `global` user preference, or `project` with the absolute workspace root;
- `content`, `source: user_explicit`, created/updated timestamps, optional expiry.

`/remember <text>` saves feedback for the current project. `/remember user <text>`
saves a global user preference; `project` and `reference` type prefixes are
available. `/remember --replace <id> <text>` corrects an entry, `/memory` lists
active entries, and `/forget <id>` removes one. A deleted or expired entry is
never recreated by scanning history.

Memory is retrieved just in time through the read-only `memory_search` tool. The
model decides that prior intent is missing and searches with a query; the tool
hard-filters by active state, project/global scope and requested type, then
lexically ranks matches. It returns a small set with id, type, scope, date and
content, or an explicit no-match result. There is no automatic recall on every
turn and no vector store.

The result is a normal tool result, not a system prompt. It states that memory
explains preferences and past corrections but is not proof of current code,
permission, or approval. If multiple entries conflict, the text tells the model
to report the conflict rather than selecting one by score.

## Consequences

A new Session can carry a correction forward without carrying the transcript.
The text remains untrusted user material and cannot bypass approvals. Project
scope uses the workspace path, so moving a checkout can make its project memory
invisible; that is safer than applying it to the wrong tree.

The MVP lists/forgets entries in a TUI panel and corrects by command. It does not
auto-detect contradictions; the later explicit entry is a new or replaced item,
never an inferred merge.

## Reassessment Conditions

Revisit when memory needs keyword search across many entries, cross-machine sync,
or automatic conflict detection. Do not add extraction without a separate decision
about consent, scope and deletion.
