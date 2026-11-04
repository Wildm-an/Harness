---
name: run
description: "Start this project's app and see that a change works: run, start, launch, or screenshot the app, or confirm a fix in the real app, not only in tests. Use after a change that the user can see or use, or for /run."
---

# Run the app and check a change

Tests show that code does what the tests expect. Running the app shows that the change works for the user. Use this skill to start the app, use the changed part, and collect evidence.

## 1. Find how the project runs

Look in this order. Stop when you find a clear answer:

1. `HARNESS.md` or `CLAUDE.md`: a section about how to run the app.
2. `.harness/launch.json`: the servers of the project. The `preview_start` tool starts them.
3. `README.md`, `CONTRIBUTING.md`, and `docs/`.
4. `package.json` scripts (`dev`, `start`, `serve`), `Makefile`, `pyproject.toml` scripts, `Procfile`, `docker-compose.yml`, `manage.py`, `Cargo.toml`, `go.mod`.

If you cannot find how to run the app, ask the user with `ask_user_question`. Do not guess a command that can change data.

## 2. Select the method for the app type

| App type | Method |
|---|---|
| Web app or web server with pages | `preview_start`, then `preview_navigate`, `preview_snapshot`, `preview_click`, `preview_fill`, `preview_console`, `preview_logs`, and `preview_screenshot`. |
| API server | Start it with `bash` and `run_in_background: true`. Wait until it is ready. Send requests with `curl` or a short script. |
| Command-line tool | Run it with `bash`, with the arguments that use the change. |
| Library | Write a short script in a scratch file that imports the library and calls the changed function. Run it. Delete the script. |
| Desktop, mobile, or game app | Build it, and start it if the platform allows. If you cannot see it, tell the user what to check. |

If the web app has no server in `.harness/launch.json`, add one, for example:

```json
{ "servers": [ { "name": "web", "command": "npm run dev", "port": 5173 } ] }
```

## 3. Use the change

1. Go to the part of the app that the change affects.
2. Do what a user does: click, type, submit, load the page again.
3. Check the result:
   - The page or the output shows the expected result.
   - The browser console has no new errors (`preview_console`).
   - The server log has no new errors (`preview_logs`, or the output of the background task).
   - Requests return the expected status and data.
4. Also check one case next to the change: an empty value, a wrong value, a second click, a page reload.

## 4. Fix and check again

If the change does not work, read the error, find the cause in the code, fix it, and check again. Use the `debug` skill for a problem that is not clear.

## 5. Report with evidence

Tell the user what you checked and what you saw. Give the evidence:

- a screenshot (`preview_screenshot`) for a visual change,
- the command and its output for a command-line tool or an API,
- the log lines for a server change.

Say what you could not check, and why.

## 6. Clean up

Stop the servers and background tasks that you started (`preview_stop`, `task_stop`), unless the user wants them to keep running. Delete scratch scripts and test data that you made.
