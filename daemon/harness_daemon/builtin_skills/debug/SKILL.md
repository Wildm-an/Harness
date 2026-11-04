---
name: debug
description: "Find and fix the cause of a bug step by step: reproduce, isolate, diagnose, fix, and verify. Use for an error message, a stack trace, a failing test, a crash, wrong output, or \"it worked before\", when the cause is not clear."
---

# Debug a problem

Find the cause before you change code. A change that hides a symptom often creates a new bug. Work in these steps, and keep a short record of what you tried.

## 1. Understand the problem

Get these facts from the user or from the error:

- What happens, exactly: the error message, the stack trace, the wrong output.
- What must happen.
- The steps that cause it.
- When it started: after a change, a dependency update, a new environment, or always.

If a fact is missing and you cannot find it, ask the user with `ask_user_question`.

## 2. Reproduce it

1. Make the problem happen with the smallest number of steps: a test, a command, or a script.
2. If you can, write a failing test that shows the problem. It proves the bug, and later it proves the fix.
3. If you cannot reproduce it, compare your environment with the environment of the user: versions, configuration, data, operating system. Do not fix a bug that you cannot see, unless the cause is certain from the code.

## 3. Isolate it

Make the area of the cause smaller:

- **Read the stack trace from the top frame of the project code.** Read that code and the code that calls it.
- **Follow the data.** Find where the value first becomes wrong. Add temporary log lines or use a debugger to see the values.
- **Use the history.** If it worked before, run `git log` on the files near the problem. Use `git bisect` to find the commit that started the problem.
- **Remove parts.** Disable parts of the input or the code until the problem goes away. The last part that you removed is near the cause.
- **Check the assumptions.** Read the documentation of a library before you blame it. Check versions, configuration values, and environment variables.

## 4. Diagnose the cause

1. State the cause in one sentence: "X happens because Y."
2. Check the statement against all symptoms. A correct cause explains all of them.
3. If the statement does not explain all symptoms, go back to step 3.
4. Look for the same mistake in other places of the code.

## 5. Fix it

1. Change the code at the cause, not at the place where the symptom shows.
2. Make the smallest change that fixes the cause. Do not refactor at the same time.
3. Remove the temporary log lines and debug code.

## 6. Verify it

1. Run the test from step 2. It must pass now.
2. Run the tests of the area of the change, then all tests if they are fast.
3. If the user can see the problem in the app, check it in the app (the `run` skill).
4. Keep the new test, so that the bug cannot come back.

## 7. Report

Tell the user:

- the cause, in one or two sentences,
- the fix and the files that changed,
- how you verified it,
- other places with the same problem, if you found any,
- what is not verified.
