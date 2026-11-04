---
name: code-review
description: "Review code changes for bugs: the current diff, a branch, a commit, a file, or a pull request. Use for /code-review, \"review my changes\", \"is this safe to merge\", or a check before a commit. It finds correctness bugs and reports them with evidence."
argument-hint: "[--fix] [branch | commit | PR number | path]"
---

# Review code changes

Arguments: $ARGUMENTS

Find bugs that will cause wrong behavior: wrong results, crashes, data loss, broken edge cases, broken callers. A report with three real bugs is better than a report with twenty guesses.

## 1. Get the changes

Select the target from the arguments. With no arguments, review the uncommitted changes.

| Target | Command |
|---|---|
| No arguments | `git status`, then `git diff HEAD` (staged and unstaged). Read new untracked files too. |
| A branch | `git diff <main branch>...<branch>` |
| A commit | `git show <commit>` |
| A pull request number | `gh pr diff <number>` and `gh pr view <number>` |
| A path | `git diff HEAD -- <path>`. If the file has no changes, review the whole file. |

Find the main branch with `git symbolic-ref refs/remotes/origin/HEAD` or `git branch`. If there are no changes, tell the user and stop.

## 2. Understand the intent

Read the commit messages, the pull request text, or ask what the change must do. A bug is a difference between the intent and the behavior.

## 3. Review

For each changed file:

1. Read the whole changed function or block, not only the changed lines.
2. Read the callers and the callees of changed functions. Use `grep` to find them. A changed signature, return value, or side effect can break a caller in another file.
3. Look for these problems:
   - Logic: wrong condition, inverted check, off-by-one error, wrong operator, wrong variable.
   - Edge cases: empty input, zero, null or None, missing key, one item, very large input, unicode, time zones.
   - Errors: an exception that nobody catches, an error that is silently ignored, a resource that is not closed.
   - State: a race condition, shared state that changes, a cache that is not updated, an order of operations that is wrong.
   - Contracts: a changed API that callers still use the old way, a missing migration, a changed default value.
   - Tests: a test that does not test the change, or a test that passes for the wrong reason.
4. For a large change (more than about 10 files), give groups of files to subagents with the `agent` tool. Tell each subagent the intent and the files, and ask for findings with evidence. Check their findings yourself.

## 4. Verify each finding

Before you report a finding, prove it:

- Trace the code path from an input to the wrong result.
- If you can, run a small test or command that shows the problem.
- Remove a finding that you cannot connect to a real input. Remove a finding that the surrounding code already prevents.
- Do not report style preferences, naming, or formatting as bugs. Leave them out, or put them in a short "Other notes" list at the end.

## 5. Report

Sort the findings by severity: data loss and security first, then wrong behavior, then rare edge cases. For each finding, write:

```
1. <file>:<line> - <one sentence: the problem>
   Failure: <the input or state> -> <the wrong result>
   Fix: <a short suggestion>
```

Then write one line for the result: "N bugs found" or "No bugs found". Say which parts you did not review, if any.

## 6. Fix (only with --fix or when the user asks)

Do not change files in a review, unless the arguments contain `--fix` or the user asks. With `--fix`:

1. Fix each verified finding, one at a time.
2. Run the tests of the changed area.
3. Report each finding as fixed or not fixed, with the reason.
