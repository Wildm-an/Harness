# Dispatch page: build plan

Status: plan, on hold. No code exists for it yet.

## 1. Goal

The Dispatch page lets the user start autonomous agents. Each agent runs a task with no window and no approval prompts. Each agent works in its own Docker container. The agents run while Harness runs: with the window open, or with only the tray icon.

## 2. Facts from the code

These parts exist now. The plan uses them.

| Part | File | Use for the plan |
|---|---|---|
| Sessions with no window | `server.py`: `HeadlessConnection`, `run_routine`, `start_child_session`, `adopt_session` | An agent is a session with no window. A window that opens it takes it. |
| Queue with a limit | `routines.py`: `RoutineScheduler`, `MAX_PARALLEL = 3` | The model for the agent queue. |
| Session creation | `server.py`: `create_session(conn, cwd, provider, model, mode, wt_arg, parent_id)` | It makes the session of each agent. |
| Shell argv | `tools/shell.py`: `ShellInfo.argv` | `bash` (`run_command`), `tasks.py`, and `servers.py` all start `[*shell.argv, command]`. One new `ShellInfo` sends all three into the container. |
| File tools | `tools/base.py`: `ToolContext.cwd`, `resolve` | The file tools work on the host folder. A bind mount makes the same files show in the container. |
| Tray | `client/src-tauri/src/lib.rs`: `make_tray` | The daemon continues when the window closes, if "Keep running in the background" is on. |
| Keep awake | `keepawake.py` | The computer stays awake while an agent works. |
| No sandbox now | `auto_mode.py:13` | The container is the sandbox that this file says Harness does not have. |

Name conflict: `agents.py` holds the subagent types. The new modules use the names `sandbox.py` and `dispatch.py`.

## 3. Decisions (defaults)

The plan uses these defaults. Change them before phase 1 if they are wrong.

1. **Docker is required.** Docker Desktop 29.4.3 with WSL2 is on this computer. Windows 11 Home has no Windows Sandbox and no Hyper-V Manager.
2. **One container for each agent.** The default image is `mcr.microsoft.com/devcontainers/base:ubuntu`. The user can set an image for each agent.
3. **A full clone, not a worktree.** A worktree has a `.git` file that points to a Windows path. Git in the container cannot read that path. A `git clone --local` copy has its own `.git` folder.
4. **The model calls stay in the daemon.** Only the tools run in the container. The container gets no API keys.
5. **Network: on by default.** The user can set "No network" for each agent (`--network none`).
6. **Mode: `bypassPermissions` inside the container.** Tools that run on the host stay limited (see phase 4).
7. **Limits:** 2 CPUs and 4 GB of memory for each agent. At most 3 agents run at the same time.

## 4. Phases

### Phase 1: Sandbox module (daemon)

Make `daemon/harness_daemon/sandbox.py`.

- `docker_status()`: return "missing", "stopped", or "ready". Use `docker info`.
- `start_docker()`: start Docker Desktop. Wait at most 120 seconds for "ready".
- `create(agent_id, image, host_dir, cpus, memory, network)`: run `docker run -d --name harness-agent-<id> --label harness.agent=<id> -v <host_dir>:/workspace -w /workspace --cpus <n> --memory <m> <image> sleep infinity`.
- `start`, `stop`, `remove`, `exists`.
- `shell_info(name)`: return `ShellInfo("bash", ("docker", "exec", "-i", "-w", "/workspace", name, "bash", "-lc"))`.
- `orphans()`: list the containers with the label `harness.agent` that have no agent in the database.

Tests: `daemon/tests/test_sandbox.py`. Use a fake `docker` command. Do not need Docker in CI.

### Phase 2: Agent copy of the project

Add these functions to `sandbox.py`, or to a new `agent_copy.py`.

1. Clone the project: `git clone --local <project> ~/.harness/agents/<id>/workspace`.
2. Make the branch `harness/agent-<id>` in the clone.
3. At the end, fetch the branch into the project: `git fetch <clone> harness/agent-<id>:harness/agent-<id>`.
4. "Discard" deletes the clone folder and the container.

A project that is not a git repository: copy the folder. "Keep" then copies the changed files back, after the user sees the diff.

### Phase 3: Tools in the container

1. In `agent.py`, let the caller give a `ShellInfo`. An agent session gives `sandbox.shell_info(name)`.
2. Fix the stop of a command. A kill of the `docker exec` client does not stop the process in the container.
   - Wrap each command: `echo $$ > /tmp/harness-<call>.pid; exec bash -lc '<command>'`.
   - On a timeout or a cancel, run `docker exec <name> kill -TERM -<pid>`, and then `-KILL`.
   - Put this change in `shell.py`, `tasks.py`, and `servers.py`.
3. In `ToolContext.resolve`, map a path that starts with `/workspace` to the host folder. The model sees `/workspace` in `bash` output and can use the same path in `read` and `edit`.
4. Give `bash` a new description for agents: "Linux bash in a container. The project folder is /workspace."
5. Preview servers: publish a port range with `-p 127.0.0.1:<host>:<port>`. Do this phase last. Agents can work with no preview.

Tests: a fake `ShellInfo` that records the argv. A test for the `/workspace` path map. A test for the stop of a command.

### Phase 4: Host tools for agents

Some tools run on the host and not in the container. An agent session must limit them.

| Tool | Agent rule |
|---|---|
| `read`, `write`, `edit`, `glob`, `grep` | Allowed. `resolve` keeps them in the clone folder. |
| `web_fetch`, `web_search` | Allowed only when the agent has network. |
| MCP connectors | Off by default. The user can turn on each connector for an agent. |
| Hooks of the user (`hooks.py`) | They run on the host, as now. The agent cannot change them, because they are not in the clone. |
| `start_session`, `routine_create`, `cron_create` | Removed for agents. |
| `ask` (question card), plan card | Removed. An agent has no user to ask. The agent writes the question in its report and stops. |

Put these rules in `permissions.py` as a new mode `sandboxed`. Do not reuse `bypassPermissions`, because that mode also skips the host rules.

### Phase 5: Agent runner (daemon)

Make `daemon/harness_daemon/dispatch.py`. Copy the pattern of `RoutineScheduler`.

- Storage: a new table `dispatch_agents` with `id`, `name`, `prompt`, `project`, `provider`, `model`, `image`, `network`, `cpus`, `memory`, `status`, `session_id`, `container`, `clone_dir`, `branch`, `created_at`, `ended_at`, `error`.
- Status values: `queued`, `starting`, `running`, `paused`, `done`, `failed`, `stopped`, `kept`, `discarded`.
- Start of an agent:
  1. Check `docker_status()`. If Docker is stopped, call `start_docker()`.
  2. Make the clone (phase 2).
  3. Make the container (phase 1).
  4. Call `create_session` with the clone folder and the mode `sandboxed`.
  5. Run the turn with the prompt, as `run_routine` does.
- End of a turn: set `done` or `failed`. Keep the container stopped, so the user can see the files.
- Turn limit: stop after `max_tool_calls` or after a time limit (default 2 hours). This protects the model quota.
- Keep awake: call `keepawake.py` while one or more agents run.

### Phase 6: Lifetime

1. Harness quits: stop all agent turns. Run `docker stop` on each running container. Set the status `paused`.
2. Harness starts: for each `paused` agent, start the container and continue the session with the prompt "Harness restarted. Continue the task."
3. Window closes with "Keep running in the background" off: the daemon stops. The agents pause.
4. Window closes with "Keep running in the background" on: the agents continue.
5. The Dispatch page shows a line when "Keep running in the background" is off: "Agents pause when you close the window."

### Phase 7: Protocol

Add to `client/src/daemon/protocol.ts` and `server.py`.

Client to daemon:

| `type` | Fields | Function |
|---|---|---|
| `dispatch.list` | | Send the list. |
| `dispatch.create` | `name`, `prompt`, `project`, `model`, `image`, `network`, `cpus`, `memory` | Make and queue an agent. |
| `dispatch.stop` | `id` | Stop the turn. Keep the files. |
| `dispatch.resume` | `id`, `prompt?` | Continue a stopped agent. |
| `dispatch.keep` | `id` | Fetch the branch into the project. |
| `dispatch.discard` | `id` | Delete the clone and the container. |
| `dispatch.docker` | | Start Docker Desktop. |

Daemon to client:

| `type` | Fields | Function |
|---|---|---|
| `dispatch` | `items`, `docker` | The list and the Docker status. To all clients. |
| `dispatch.status` | `id`, `status`, `error?` | One change. |

### Phase 8: Dispatch page (client)

Read `docs/UI_RULES.md` first. Add a section "3.6 Dispatch page" to it before the code.

- Nav item "Dispatch", under "Routines". A badge shows the count of running agents.
- `client/src/components/DispatchPage.tsx`: the same layout as `RoutinesPage.tsx`.
  - Title "Dispatch". A context line with the Docker status and "Start Docker" when it is stopped.
  - "New agent" opens the form: "Name", "Task", "Folder", model chip, "Image", "Network", "CPUs", "Memory".
  - Each row: name, folder, status pill, time, and "Open session".
  - Detail view: "Stop", "Resume", "Review changes", "Keep", "Discard…".
- "Review changes" opens the existing diff view (`DiffReview.tsx`) on the clone folder.
- The sidebar row of an agent session gets a container icon.
- Windows notification on the end: "{name} finished" or "{name} failed", as routines do (RT7).

Tests: `DispatchPage.test.ts`, as `RoutinesPage.test.ts`.

### Phase 9: Check the whole feature

1. Start an agent with the task "Add a test for X" on a small repository.
2. Close the window with "Keep running in the background" on. Check that the agent continues.
3. Quit Harness. Start Harness. Check that the agent continues.
4. In the container, run `rm -rf /workspace/*`. Check that the project folder stays safe. Only the clone changes.
5. Start 4 agents. Check that one agent waits in the queue.
6. Stop Docker Desktop while an agent runs. Check that the agent fails with a clear error.

## 5. Risks

- **Slow file access.** A bind mount of a Windows folder into a Linux container is slow on Docker Desktop. If a build is too slow, put the clone in a Docker volume and copy the files out at the end.
- **Windows-only projects.** The container is Linux. Windows builds (for example the Tauri `.exe`) do not work in it.
- **Model quota.** 3 agents with no limit can use the quota fast. The time limit and `max_tool_calls` reduce this risk.
- **Docker Desktop license.** It is free for personal use and small companies. A large company needs a paid plan.
- **Disk.** Each clone and each image uses disk. The Storage dialog (`StorageDialog.tsx`) must show the agent folders.

## 6. Order of work

1. Phase 1 and phase 2 (no UI). Test with a script.
2. Phase 3 and phase 4. Test with one agent from a script.
3. Phase 5 and phase 6.
4. Phase 7 and phase 8.
5. Phase 9.
