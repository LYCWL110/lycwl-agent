# ADR-0102: Task Report Shows Changes, Syntax Facts And Declared Checks

- Status: Accepted (2026-11-26)
- Related: ADR-0017 (verification), ADR-0081 (completeness), ADR-0101 (edit rollback)

## Decision

The task report stops presenting an empty `changes` and `tests` list when the
Run has facts to show:

- successful built-in mutations contribute `changes` with their workspace path;
  a reverted edit is removed from that list, and a same-path earlier success is
  restored to the list;
- syntax results become non-required `supporting_check` assertions. They carry
  the event reference, the path, the failed/skipped/passed state and the rollback
  outcome. A later mutation makes an older check `stale`;
- when there are code changes or syntax facts and no declared verification
  command, the report includes `project-tests: not_run` rather than implying a
  pass;
- `shell` accepts an explicit `verification: true` argument. Such a command is
  recorded in `tests` with `basis: caller_declared`, its command, approval fact,
  execution id and passed/failed/not_run outcome. The name of the command is never
  used to guess, and the basis makes clear this is a caller declaration rather than
  a verified project acceptance command;
- the required goal remains `unknown` unless independent goal evidence exists.

Syntax passing is not goal verification. The report keeps those dimensions
separate.

## Consequences

A coding Run now shows "something changed", "this file compiled" and "no
project check was recorded" as distinct facts. Pure Q&A with no changes does not
gain a test-not-run assertion.

Only a model-declared verification command enters `tests`; a successful shell
command that merely looks like a test does not.

## Reassessment Conditions

Revisit when project scripts can be independently classified without a model
declaration, or when the report gains a UI that needs richer per-file outcomes.
