---
name: simplify
description: "Clean up the changed code: remove duplicate code, reuse existing helpers, simplify complex logic, and fix slow patterns, then apply the fixes. Use for /simplify, \"clean this up\", or \"refactor my changes\". It improves quality only. Use code-review to find bugs."
argument-hint: "[path or branch]"
---

# Simplify the changed code

Arguments: $ARGUMENTS

Make the changed code shorter, clearer, and easier to change, with the same behavior. Change only the code that the current work changed, unless the user asks for more.

## 1. Get the changes

With no arguments, use the uncommitted changes (`git diff HEAD`) and new untracked files. With a path, use the changes in that path. With a branch, use `git diff <main branch>...<branch>`. If there are no changes, ask the user which code to simplify.

## 2. Find improvements

Read each changed block and the code around it. Look for these, in this order:

1. **Reuse.** The new code repeats a helper, a constant, or a pattern that the project already has. Search with `grep` for similar names and similar code. Use the existing helper.
2. **Duplicates.** The same logic appears two or more times in the change. Extract it once, if the parts must change together.
3. **Simpler logic.** Deep nesting that early returns can flatten. A long condition that a named variable can explain. A loop that a built-in function does. Code paths that can never run. Variables and parameters that nothing uses.
4. **Right level.** A function that does two jobs. A class with one method that a function can replace. A layer that only passes calls through.
5. **Efficiency.** Work inside a loop that can move out of it. A search in a list that a set or a map can replace. The same file, query, or request done many times. Data loaded and not used.
6. **Clear names and comments.** A name that does not say what a thing is. A comment that repeats the code, or a comment that is no longer true.

Do not:

- Change behavior, public APIs, or file formats.
- Change code style that the project uses on purpose.
- Add an abstraction for one use.
- Rewrite code that the current work did not touch.

## 3. Apply the fixes

1. Make one improvement at a time, with the `edit` tool.
2. After the changes, run the tests of the changed area, and the linter or type checker if the project has one.
3. If a test fails, find out why. Undo the improvement if it changed behavior.

## 4. Report

List each improvement in one line: the file, what you changed, and why. Then list the improvements that you found but did not apply, with the reason (for example, "needs a change outside this work"). Give the test result.
