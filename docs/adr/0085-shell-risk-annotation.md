# ADR-0085: Annotate shell command risk and state that compaction loses tool results

- Status: Accepted (2026-11-08)
- Related: ADR-0084 (comparison findings), ADR-0083 (Harness rules), ADR-0016 (compaction)

## Context

The comparison in ADR-0084 recorded two residual risks and did not fix them.

1. **A destructive statement can hide inside a compound command.** The approval
   preview showed the command verbatim and marked nothing. A user scanning
   `Get-Content a.txt; Remove-Item -Recurse C:\important` before pressing yes had to
   read the whole line and notice the second statement.

2. **Compaction summarises earlier tool results away, and the model was not told.**
   Claude Code's prompt says to write down anything needed later because old results
   may be cleared. This project compacts but carried no such rule, so a model could
   rely on a result that had already been replaced by a summary.

## Decision

### Risk annotation, not blocking

`domain/process/shell-risk.ts` matches coarse patterns for constructs whose effect
is easy to miss: volume formatting, git history rewrite, recursive or forced delete,
plain delete, process termination, privilege change, outbound transfer, bare network
connection, dynamic execution and interpreters.

The preview gains at most four `risk=` lines and, when a separator appears outside
quotes, a `statements=more than one` line.

Three properties are deliberate:

- **It annotates; the user still decides.** Every shell command already requires
  one-shot approval. Blocking would duplicate that decision, and a false positive
  would refuse a command the user wanted.
- **No finding prints nothing.** A "no risks" line on every preview would train the
  user to ignore the section.
- **A false positive is the more expensive error.** The patterns are narrow on
  purpose: `Get-Content`, `npm test`, `git status` and `ls` produce nothing.

`isSingleStatement` strips quoted text before looking for a separator, so
`echo 'a; b'` is one statement. It errs toward calling a command compound, which
adds a warning rather than removing one.

This is not a sandbox and does not claim to detect every dangerous command. It
answers "where should the user look", which is a different and narrower question
than the classifier Claude Code carries for its auto-allow mode.

### One rule in the system prompt

The environment section now says that compaction summarises earlier tool results
away and that anything needed later must be written down. `HARNESS_RULES_VERSION`
is 4.

## Consequences

- Shell previews carry risk lines; harmless commands are unchanged.
- The model is told a result it merely read is not durable.
- No behaviour is blocked. Nothing about approval, retry or budgets changes.

## Known limitations

- **Pattern matching is coarse.** `Remove-Item` inside a quoted string is still
  flagged; a dangerous command expressed through an alias is not.
- **The annotation cannot see what an interpreter will do.** `node -e` is flagged as
  dynamic execution, which is all that can be said without running it.
- **The compaction rule is advice.** Nothing enforces that the model writes anything
  down; it only removes the excuse that it did not know.

## Reassessment conditions

Reopen if the annotation produces enough false positives that it is ignored, if a
destructive construct is missed that should have been caught, or if compaction is
measured losing detail the model needed despite the rule.
