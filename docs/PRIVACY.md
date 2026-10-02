# Privacy

Harness has no telemetry, no analytics, and no crash reports. It does not send data about you or
your projects to the Harness developers.

Harness transfers information to other networked systems only when you ask for it, or when you
configure a service that it then uses. The one exception is the update check. You can turn it off.
This page lists each connection.

## The connection that Harness makes by itself

| Connection | Data | When | How to turn it off |
|---|---|---|---|
| The update check: `https://github.com/Wildm-an/Harness/releases/latest/download/latest.json` | A plain HTTPS request. It has no data about you, your computer, or your projects. GitHub sees your IP address. | Once, a few seconds after the app starts. | Settings > General > Updates > "Check for updates at start". |

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
- **PR status.** If you turn on "Show PR status" in the sidebar filter menu, Harness runs the GitHub CLI
  (`gh pr view`) each minute for each project folder. `gh` uses your own GitHub login. It sends the
  name of the repository and the branch to GitHub. This setting is off by default.
- **The Cookbook.** The Local Models screen searches huggingface.co when you open it. Model details
  and downloads use huggingface.co. Harness sends your Hugging Face token only if you save one.
- **Plugins.** A plugin install from a git address clones the repository.
- **The agent browser.** The agent browser opens the servers of the project. It opens other sites
  only after you allow them. Chromium downloads only when you run `harness-daemon --install-browser`.
- **The Browser pane, the terminal, and the agent tools.** These open the addresses and run the
  commands that you or the agent ask for, after the approvals of your permission settings.
- **The Windows installer.** If WebView2 is not installed, the installer downloads it from Microsoft.
  Windows 11 has WebView2.

## Servers that listen

The daemon listens only on `127.0.0.1` (your own computer). A daemon that you start by hand with
`--host` can listen on other addresses. It then shows a warning.

## Privacy policies of third-party services

- GitHub (the update check, the downloads, and `gh`):
  https://docs.github.com/en/site-policy/privacy-policies/github-general-privacy-statement
- Hugging Face: https://huggingface.co/privacy
- OpenAI: https://openai.com/policies/privacy-policy/
- OpenRouter: https://openrouter.ai/privacy
- Microsoft (WebView2 and the Chromium download of Playwright): https://privacy.microsoft.com/privacystatement

For other model providers, MCP servers, and git hosts, read the policy of the service
that you use.
