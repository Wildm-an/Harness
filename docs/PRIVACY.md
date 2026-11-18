# Privacy

Harness has no telemetry, no analytics, and no crash reports. It does not send data about you or
your projects to the Harness developers.

Harness transfers information to other networked systems only when you ask for it, or when you
configure a service that it then uses. The one exception is the update check. You can turn it off.
This page lists each connection.

## The connection that Harness makes by itself

| Connection | Data | When | How to turn it off |
|---|---|---|---|
| The update check: `https://github.com/Wildm-an/Harness/releases/latest/download/latest.json` | A plain HTTPS request. It has no data about you, your computer, or your projects. GitHub sees your IP address. | Only when the app window is visible: a few seconds after it shows, then each time you open it again (the tray icon, the tray menu, a second start, or a restore of the window). The focus alone checks at most once each 30 minutes. | Settings > Updates > "Check for updates when the app opens". |

## Connections to the services that you configure

Harness connects to these services only after you add them or turn them on:

- **Model providers.** Harness sends your prompts to the model provider that you choose. A prompt can
  contain the files and the command output that the agent reads. The default provider is Ollama on
  your own computer (`localhost`). Harness also sends parts of the chat to the same provider for these
  tasks:
  - The session title: up to 2,000 characters of the first prompt of a session.
  - Prompt suggestions: the last messages of the chat. To turn them off, use Settings > "Prompt
    suggestions".
  - Context compaction: the chat history, when the context is almost full.
  - The model list: when the start screen shows, Harness asks each provider that is on for its models.
- **Remote daemons.** If you connect to a daemon on another computer, the app sends all its traffic to
  that computer, directly or through SSH. At start, the app connects to the last computer that you used.
- **MCP servers.** Harness connects to the MCP servers in `~/.harness/mcp.json` and in the
  `.harness/mcp.json` file of the project.
- **SSH hosts.** The Cookbook and the model tunnels connect to the SSH hosts that you add.

## Connections that start when you do an action

- **App updates.** "Install and restart" downloads the installer from the GitHub release.
- **Usage page.** When you open the Usage page, the daemon reads the local histories of the agents on its computer: the Claude Code transcripts (`~/.claude/projects`), the Codex sessions (`~/.codex/sessions`), the OpenCode database, the Hermes Agent database, and the run records of Harness. It reads only the token counts, the model names, the times, and the session ids, and it keeps them in `~/.harness/usage-cache.db`. Nothing of this data leaves the computer. To estimate the cost, the daemon downloads the public model prices of LiteLLM (`https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json`) at most once a day. The request has no data about you. The custom model prices of the "Model prices" dialog stay in `~/.harness/usage-model-prices.json`. For the Limits tab of Claude Code, see "Agents". For the Limits tab of Codex, the daemon runs `codex app-server` (the `codex` program on the PATH) with no prompt and asks it for the rate limits. Codex then sends your ChatGPT login to OpenAI, as Codex does. Harness never reads the login of Codex. With no `codex` program, the daemon reads the last rate limits in the Codex sessions, and nothing leaves the computer.
- **Agents.** Settings > Agents and the agent picker read the ACP registry (`https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json`) and download the icon of each agent from the same address. The requests have no data about you. For Claude Agent, Harness runs the `claude` program of the daemon computer: `claude auth status` for the sign-in state, and a `claude -p` process with no prompt for the usage of the subscription. That process sends your Claude Code login to Anthropic, as Claude Code does. To read the models of an agent before its first session, Harness starts the agent with no prompt. The agent can then connect to its service with your login.
- **PR status.** If you turn on "Show PR status" in the sidebar filter menu, Harness runs the GitHub CLI
  (`gh pr view`) each minute for each project folder. `gh` uses your own GitHub login. It sends the
  name of the repository and the branch to GitHub. This setting is off by default.
- **The Cookbook.** The Local Models screen searches huggingface.co when you open it. Model details
  and downloads use huggingface.co. Harness sends your Hugging Face token only if you save one.
- **Dictation.** The microphone button records your voice only while you dictate. Whisper changes the
  speech to text on your computer, in the app: the audio does not leave the computer. The first
  dictation downloads the Whisper model (about 100 MB) from huggingface.co, with no token. If you turn
  on Settings > General > "Clean up dictation", the app sends the text (not the audio) to the daemon,
  and the daemon sends it to the cleanup model that you choose: a provider, or a local model.
- **Plugins.** A plugin install from a git address clones the repository.
- **Operating harness.** When you choose another harness in Settings > Operating Harness, a new session
  starts that program. A harness that runs with npx or uvx downloads its package from npm or PyPI at the
  first start. The harness then sends your prompts and project files to its own model service, under its
  own privacy policy.
- **The agent browser.** The agent browser opens the servers of the project. It opens other sites
  only after you allow them. The headless agent browser needs Chromium for Playwright. When the agent
  uses it and the matching Chromium is not installed, the daemon downloads Chromium (about 150 MB)
  from the Playwright download servers. You can also start the download with `harness-daemon --install-browser`.
- **The Browser pane, the terminal, and the agent tools.** These open the addresses and run the
  commands that you or the agent ask for, after the approvals of your permission settings.
- **The sandbox.** With the sandbox on (`docs/SANDBOX.md`, off by default), a `bash` command has no
  network. If you add domains to `sandbox.network.allowedDomains`, the command connects to those domains
  only, through a local proxy of the daemon. The proxy keeps no log. It keeps only the names of the
  blocked hosts, for the note to the agent.
- **The Windows installer.** If WebView2 is not installed, the installer downloads it from Microsoft.
  Windows 11 has WebView2.

## Servers that listen

The daemon listens only on `127.0.0.1` (your own computer). A daemon that you start by hand with
`--host` can listen on other addresses. It then shows a warning.

## Run records on your computer

The daemon keeps run records in its local database (`~/.harness/harness.db`, `daemon/harness_daemon/records.py`). They help to find the cause of a change in agent behavior or token use. Harness does not send them anywhere.

| Table | One row for each | Data |
|---|---|---|
| `turns` | Turn of a session | The start and end time, the stop reason, the permission mode, the number of steps and tool calls, the Harness version. |
| `model_requests` | Request to a model | The purpose (turn, summary, auto mode check), the provider and the model, the times, the token counts that the endpoint reported, the finish reason, an error text, and a hash of the system prompt and of the tool list. |
| `tool_calls` | Tool call | The tool name, the time, the result class (for example ok, denied, or tool error), the permission decision and the rule or person that made it, and the output size. |

The rows hold no prompt text, no tool arguments, and no tool output. The same database already holds the messages of each session. A session delete also deletes its run records.

## Full tool output on your computer

When a tool result is longer than `max_output_chars`, the model gets the cut text, and the full output goes to a file in `~/.harness/projects/<project>/<session>/tool-results/`. The file can hold what a command printed, also secrets. A session delete removes the files. The daemon removes files older than 30 days.

## Privacy policies of third-party services

- GitHub (the update check, the downloads, and `gh`):
  https://docs.github.com/en/site-policy/privacy-policies/github-general-privacy-statement
- Hugging Face: https://huggingface.co/privacy
- OpenAI: https://openai.com/policies/privacy-policy/
- OpenRouter: https://openrouter.ai/privacy
- Microsoft (WebView2 and the Chromium download of Playwright): https://privacy.microsoft.com/privacystatement

For other model providers, MCP servers, and git hosts, read the policy of the service
that you use.
