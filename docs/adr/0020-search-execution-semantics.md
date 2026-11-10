# ADR-0020: Search Execution Semantics

- Status: Confirmed design; documentation only
- Date: 2026-11-01
- Owner: [V1_BEHAVIOR_CONTRACTS.md section 2.3](../architecture/V1_BEHAVIOR_CONTRACTS.md)
- Related: ADR-0019; G06/G08; existing Runtime permissions, budgets and outcomes

## Context And Confirmation

After ADR-0019, the user requested the next architecture discussion.
The presented proposal covered four groups: the Node regular-expression
execution route, ignore-rule sources and precedence, matching-line/context
counting and truncation evidence, and deterministic path order/depth/change
reporting. The user replied “可以”. Adopt these four groups.
No feature implementation, dependency installation or product testing was
requested or authorized.

## Decision And Maintained Owner

Behavior section 2.3 owns the detailed rules. Select Node's built-in
ECMAScript regular expressions in Unicode mode, with compilation and matching
in a terminable computation thread. Keep literal-by-default selection,
line-by-line search, controlled case handling, explicit errors and no automatic
engine fallback. Bind dialect/version in the tool contract; engine replacement
requires compatibility review and regressions.

Select Gitignore-style `.ignore` semantics, precedence over `.gitignore`,
per-kind directory/order processing, and workspace-only rule sources.
Do not automatically read external ancestors, global rules or
`.git/info/exclude`; a repository is not required for workspace `.gitignore`.
Unreadable/unhandled rules leave explicitly reported unsearched scope.
A reviewed parser dependency remains to be selected.

Count unique matching lines, merge overlapping context, and do not infer
additional matches from a result count equal to the limit. Distinguish actual
extra observed matches from remaining unsearched scope.
Use path-segment/code-point order and increasing line numbers, selecting the
first N in a deterministic search order. Reject depth zero, retain depth-one
immediate children, and report observed file changes without an atomic
workspace-snapshot claim.

These selections close the presented behavior choices. Serialization,
algorithms, compatibility fixtures and engineering evidence remain deliverables;
they are not reasons to relabel the selected route as pending.

## Evidence, Alternatives And Tradeoffs

The official-document checks and earlier project/book evidence are indexed in
[reference evidence section 9](../architecture/REFERENCE_EVIDENCE_20261031.md).
Node documents the blocking risk of pathological regular expressions and
computation-thread/termination facilities. This supports investigating the
selected route; it does not establish bounded cancellation or resource safety
for this Harness. A Worker is not an OS sandbox or a separate Agent.

RE2 offers a different compatibility/performance tradeoff and excludes
constructs such as backreferences and lookaround. Adopting it would require a
separate wrapper/dependency/Windows-distribution review and a different dialect
contract. Running regex on the TUI thread is simpler but exposes interaction
to long matching work. Select the built-in route with explicit limitations,
not an unverified universal isolation or linear-time guarantee.

Git documents hierarchical pattern/negation behavior, and ripgrep documents
`.ignore` precedence. Our workspace-only sources are an explicit product
choice, not a claim of complete Git or ripgrep option/configuration parity.
The OpenCode/Miyu/local Claude observations already recorded in section 8
illustrate search/result packaging but do not prescribe these exact choices.
The already-read book p.199 supports examining the byte-to-matching chain and
prefix/end-to-end regressions, not these comparator or engine details.

Simple glob approximations and silent ignore failures are cheaper but make
search scope unreliable. Arbitrary first-N collection followed by sorting is
easier but cannot provide the selected deterministic first-N behavior.
Declaring truncation from count alone misstates evidence. The chosen approach
requires more precise traversal, result facts and failure fixtures, and
preserves the limitation that concurrent workspace edits prevent an atomic
whole-workspace claim.

## Remaining Work And Reassessment

Deliver reviewed parser/package/version evidence, exact flags/dialect/version
serialization and normalization, ignore precedence/negation fixtures,
deterministic traversal and result facts, and cancellation/timeout/resource
validation on Windows. No third-party regex package is selected.
The old tool JSON still hard-codes rust-regex, permits depth zero and cannot
fully express the selected scope/extra-match facts. It remains a historical
pending proposal; preserve fenced JSON bodies and resource IDs in this adoption.

Future checks must cover pathological/invalid regex and termination,
Unicode/case/line boundaries, competing nested ignore files and excluded
parents, rule-read failure, repeated matches/context overlap, exactly-N versus
N-plus-one versus unsearched scope, path ordering, depth-zero rejection and
concurrent edits. These are future acceptance requirements, not executed tests.
Concrete resource limits and algorithm/Schema delivery remain open.

Reassess if Windows validation cannot enforce the selected behavior or if
future engine/parser changes alter dialect, scope, order or completeness.
Do not silently substitute another engine or weaken permission boundaries.
Todo and remaining Shell/background/Web field limits are outside this decision.
G01–G10 remain OPEN; RT-01–53 remain unexecuted.
