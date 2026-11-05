# Changelog

The changes in each version of Harness. The newest version is first. The Settings dialog shows
this file on its Changelog page.

## 0.1.50 (2026-11-05)

### Split view

- Show two sessions side by side. Drag a session row onto the right half of the main view: a
  blue zone with the label "Split view" shows. Release the row to open the session in a pane at
  the right. The row menu also has "Open in" > "Split view".
- The split pane is a full chat with its own prompt box, mode menu, and context ring. The X in
  its header closes it. Drag the edge between the panes to change their widths.
- A turn that runs in the split pane continues when the pane closes.

### Sessions

- Nested sessions: a fork, and a session that the agent starts with the new `start_session` tool,
  show under the session that started them. The parent row is closed at the start. The count of
  nested sessions and an arrow show at the right end of the row.
- The agent sees the other sessions of the project, and can read them. The `offer_session` tool
  sends a task to a new nested session or to a session that fits better. The setting "When you
  ask for an unrelated task" has "Ask me", "Always do it here", and "Always start a new session".
- Better session titles: the title names the subject in 3 to 5 words. An online provider uses
  its small model for the title. A failed title tries again on the next prompt. A rename during
  the title request keeps your name.
- A new session in the Code view opens with the chat only.

### Model menu

- A new model menu, as in the Claude app: online models with number keys, the "Effort" and
  "Local models" submenus, and "Show providers". The chip shows the model and the effort level.
- Effort goes to the model as `reasoning_effort`. An endpoint that rejects it gets the request
  again with no effort.

### Start screen

- A "Worktree" check box to the right of the folder chip, as in Claude. The branch chip shows
  only when the box is on.

### Chat

- URLs in the replies of the agent are links.
- The agent gets reminders to show and update its task list.

### Updates

- The update check runs only when the window shows: a few seconds after the window opens, and
  at most one time each 30 minutes. The setting is now "Check for updates when the app opens".

## 0.1.49 (2026-11-05)

### Agent

- The agent uses its tools better. The system prompt has new rules: use the file tools in place
  of bash commands, make independent tool calls in one reply, and check the result with tool
  output before the agent says that a task is done.
- Each model family gets its own prompt text, as in Hermes Agent and opencode. GPT, Gemini,
  DeepSeek, Qwen, Kimi, and similar models get rules to act with tools and not only describe
  a plan. Small local models (14B or less) make one tool call for each reply.
- The bash, read, edit, write, glob, and grep tools have longer descriptions: when to use each
  tool, and which bash commands to avoid.
- Loop guards:
  - A tool name with the wrong case or form (for example "Bash" or "read_file") runs the
    correct tool, and the model gets a note with the correct name.
  - After 3 identical calls with the same result in one turn, the model gets a reminder to try
    a different approach.
  - When a short reply says what the model will do now but makes no tool call, the Harness asks
    the model to continue (2 times at most in each turn).
- DeepSeek models with thinking mode now work with tools: the reasoning of each reply goes back
  to the model.
- The system prompt stays the same in a session, so the prompt cache of the endpoint stays
  valid. Plan mode and memory changes go to the model as notes. The chat does not show them.

## 0.1.48 (2026-11-05)

### Settings

- A new "Your Harness" page holds the agent instructions (moved from General) and a Memory
  section, as in the Memory settings of Claude:
  - "Search and reference chats": the agent can search the past sessions of the same project.
  - "Generate memory from chats": the auto memory switch, moved from General.
  - "Include sensitive topics in memory": off by default.
  - "Your memory" > "Manage": see, add, edit, rename, and delete the memories of a project.
  - "Import memory from other AI providers": copy a prompt to another assistant, paste its
    reply, choose the facts, and import them.
  - "Export memory": save the memories as a .zip of Markdown files.
- Settings > General > System has a "Storage" row. "Manage" shows how much space Harness uses:
  sessions and worktrees, local models, the runtime, memory and settings, and the app caches and
  logs, with the details of each.

### Start screen

- The model chip shows the name of the default model, not only "Default model".

### Updates

- The app settings (theme, fonts, layouts, connections, and more) now also go to a file, and the
  app restores them at the start. An update saves them and the window position and size before
  the installer closes the app, so an update no longer loses recent changes.

## 0.1.47 (2026-11-04)

### Notifications

- When a turn ends and you do not see the session (the window is closed to the tray, minimized,
  or shows another session), Windows shows a notification with the session title and a short
  summary of what the agent did.
- The notifications and the unread dots of routine runs now also show for runs in the
  background. Before, the app dropped these events when another session was open.

### Routines

- The agent can save a routine for you. Ask, for example, "summarize the new commits each weekday
  morning". The agent asks for your approval, and the routine shows on the Routines page. It uses
  the folder, the model, and the permission mode of the session, and it cannot get a mode with
  fewer limits than the session.

## 0.1.46 (2026-11-04)

### Routines

- Each routine is now a file in the `routines` folder of Harness (`~/.harness/routines/`). The
  settings are in the frontmatter and the prompt is the body, so you can edit, copy, or back up
  a routine, or add one by hand. Harness moves the routines of 0.1.45 to files at the first start.
- The Routines page shows each routine as "Active" or "Inactive", and shows the path of the
  folder. A file with a problem shows "File error" and does not run.

## 0.1.45 (2026-11-04)

### Routines

- A new Routines page (in the sidebar, over Capabilities) runs a prompt on a schedule, each time in a
  new session. Choose the folder, the model, the permission mode, and the schedule (hourly, daily,
  weekdays, weekly, or a cron expression). "Run now" runs it at once.
- The daemon runs the routines also when no window is open. A run that needs a permission answer
  waits: open its session to answer. Windows shows a notification when a run ends or waits.
- If the computer was off at a due time, the routine runs one time at the next start.
- Settings > General > System has "Keep running in the background" (closing the window keeps
  Harness in the system tray) and "Run on startup" (Harness starts hidden when you sign in).
  The tray menu has "Open Harness" and "Quit Harness". A second start of Harness shows the
  open window.

### Connectors

- A new Email (IMAP) connector replaces the Gmail connector. It works with Gmail, iCloud Mail,
  Yahoo Mail, Fastmail, Zoho Mail, GMX, and any other IMAP service. Each account signs in with an
  app password, and the row shows how to make one. There is no Google Cloud setup.
- The mail server is part of Harness, so it needs nothing else on the daemon computer (no uv).
  The agent can search, read, send, reply, mark, move, and delete mail. "Read-only" removes the
  tools that change mail. You can add more than one account.
- The Gmail and Chrome connectors are removed. If you connected them, Harness removes their servers
  from `~/.harness/mcp.json` and the Gmail sign-in files when you open the Connectors tab. To
  remove the Gmail access of Harness at Google too, open myaccount.google.com/permissions.

### Chat

- A click anywhere on the working line ("Running Bash…", the time, or the caret) now shows its
  details. Before, only the caret did.
- The working line no longer shows the hover tip "Esc to interrupt".

## 0.1.44 (2026-11-04)

### Connectors

- The Outlook connector can hold more than one account. Click "Add account" to sign in to one
  more. Each account shows its type, and "Remove" signs out only that account. "Disconnect all"
  signs out all of them.
- Personal accounts share one MCP server (`outlook`), and work or school accounts share another
  (`outlook-work`). Each has its own token cache in `~/.harness/connectors/`. With two or more
  accounts of one type, the agent names the account in each tool call.
- Read-only applies to all the accounts of one type.
- If you signed in to Outlook with version 0.1.43, sign in again: the token cache moved.
- A new Gmail connector gives the agent mail, labels, drafts, and filters of one or more Google
  accounts. It runs the `workspace-mcp` server (MIT) with uvx, so the daemon computer needs uv.
  Click "Continue with Google" (Google's own button style) to sign in in your browser. A build of
  Harness with a Google client of its own needs no setup. Else, or with "Use your own OAuth client",
  you make a "Desktop app" client in Google Cloud and paste its ID and secret; the row lists the
  steps. Harness keeps the tokens and the client secret on the daemon computer, not in `mcp.json`.
- A new Chrome connector lets the agent use Chrome through Chrome DevTools MCP (Apache-2.0):
  open pages, click, type, take screenshots, and read the console and the network. Choose "Your
  Chrome window" (with your signed-in accounts; turn on remote debugging in
  `chrome://inspect/#remote-debugging` first) or "A separate Chrome profile".
- Gmail and Chrome show generic icons, because Google does not permit its product icons without
  an approval.
- All connector rows are collapsed when the Connectors tab opens.

### Fixes

- "Open sign-in page", "Open in browser", and the other buttons that open a web page now open it in
  your default browser. The desktop app did not permit any URL before.

## 0.1.43 (2026-11-04)

### Sidebar

- The title of a running session no longer moves to the left while it shimmers.

### Chat

- When the agent makes a new PDF or Word file, a card shows in the chat after the tool call, with
  the file name and an "Open" button. "Open" shows the file in the Preview pane. This also works
  for files that a command makes, for example the scripts of the `docx` and `pdf` skills. The
  cards show again when you open the session later.

### Connectors

- A new Microsoft Outlook connector gives the agent mail, calendar, and contacts. It runs the
  `@softeria/ms-365-mcp-server` MCP server (MIT) with npx on the daemon computer, so that
  computer needs Node.js.
- Choose "Personal account" or "Work or school account", and "Read-only" if the agent must not
  send, change, or delete. Click "Sign in with Microsoft". Harness shows a code: open
  microsoft.com/devicelogin and enter it. "Cancel" stops a sign-in that waits.
- The server keeps its own sign-in in its encrypted cache. "Disconnect" signs out and removes the
  server.
- Each connector shows the logo of its service. The GitHub connector and its MCP server row show
  the GitHub mark. Outlook shows a mail icon, because Microsoft does not permit its product icons
  without a license.

## 0.1.42 (2026-11-04)

### Skills

- Harness now comes with four built-in skills: `docx` (Word), `xlsx` (Excel), `pptx`
  (PowerPoint), and `pdf`. The agent loads one when a task matches. Each skill has instructions
  and scripts: build helpers, tracked changes and comments in Word, a formula check for Excel,
  template decks for PowerPoint, PDF form filling, and page images for a visual check. The
  scripts run with your Python. An added skill with the same name replaces a built-in skill.
- The `office_edit` tool tells the agent to load these skills for work that is larger than a
  small edit.
- Eight more built-in skills for work on code and on Harness itself:
  - `init` makes or improves the `HARNESS.md` of a project.
  - `run` starts the app of the project and checks a change, with evidence.
  - `debug` finds the cause of a bug step by step: reproduce, isolate, diagnose, fix, verify.
  - `code-review` and `security-review` review the changes for bugs and for vulnerabilities.
  - `simplify` cleans up the changed code and runs the tests.
  - `skill-creator` and `mcp-builder` help you make skills and MCP servers. They are Anthropic
    skills under the Apache License 2.0, changed for Harness (see `MODIFICATIONS.md` in each).

### MCP servers

- HTTP and SSE MCP servers can now use OAuth. A server that needs a sign-in shows "Needs
  authentication" and an "Authenticate" button on the MCP servers tab. The sign-in page opens
  in your browser, and the server connects when the sign-in completes.
- For a daemon on another computer, paste the URL of the callback page into the field under
  the row.
- "Re-authenticate" and "Clear authentication" show for a server that has tokens.
- The new `oauth` key in `mcp.json` sets a registered client (`client_id`, `client_secret`),
  the scopes, and a fixed callback port. `"oauth": false` turns OAuth off.
- The tokens are in `~/.harness/mcp-auth.json`. Harness refreshes them when they expire.

### Connectors

- The Connectors tab now has a GitHub connector. It adds the GitHub MCP server
  (`https://api.githubcopilot.com/mcp/`) for all your projects: repositories, issues, pull
  requests, code search, and Actions.
- Click "Use GitHub CLI" to use the sign-in of `gh auth login` on the daemon computer, or paste
  a personal access token. Harness checks the token with GitHub first.
- The token is in `~/.harness/mcp-auth.json`, not in `mcp.json`. "Disconnect" removes the token
  and the server.

### Capabilities page

- The tabs are now in this order: Skills, Connectors, Plugins, MCP servers. "Connections" is now
  "Connectors".
- The Skills tab has two choices: "Built-in skills" and "Added skills". Each opens its list.

### Sidebar

- The title of a running session now shimmers, as in the Claude app, and the row shows no status
  mark. A session that waits for your approval still shows a yellow dot.

### Session model

- An old session now opens when the provider of its model is gone or off. Before, the session
  did not open.
- When no provider gives the model of a session, a prompt in the chat asks you to switch to an
  available model. Select a model and click "Switch", or click "Not now". The new model applies
  to the next turn. A prompt with the old model fails with a clear error.
- With "Preferred providers" on, the session switches to the default model (or the local model
  with no connection) and does not ask.
- "Choose the model by network" in Settings > Providers is now "Preferred providers".
- A model switch no longer adds a message to the chat. Only the model label under the prompt box
  changes. A warning about the new model (for example, no API key) still shows.

## 0.1.41 (2026-11-04)

### The agent

- The agent can show an interactive visual (HTML or SVG) in the chat with the new tool
  `show_visual`. The chat shows it as a "Made a visual" item in a sandboxed frame, and a button
  in the visual can send the next prompt.

### Working line

- During a turn, the last tool calls show only in the dropdown of the working line, as in
  Claude Code. When the turn ends, they show as a group line in the chat again.
- The loader of the working line is now a turning gyroscope: 3 rings with comet tails, in the
  accent color. It is still when "reduce motion" is on.

### Sidebar

- The status mark of a session is now a smaller dot at the right end of the row. An idle session
  has no mark. On hover, the ⋮ button takes its place.

## 0.1.40 (2026-11-04)

### Sidebar

- Right-click a project with no sessions and choose "Remove from sidebar" (under "Archive all").
  The folder and its files stay.
- The question before you delete a session selects "Delete", so Enter deletes the session.

## 0.1.39 (2026-11-04)

### The agent

- New tools `web_search` and `web_fetch`, as in Claude Code. Search uses DuckDuckGo with no key,
  or Brave Search, Tavily, or a SearXNG server (Settings > General > Web). A fetch asks for each
  host, and a page becomes text in the Markdown form.
- The agent can ask you questions while it works (`ask_user_question`). A card shows 2 to 4
  options with number keys, "Something else", "Skip", and "Next" / "Submit".
- In plan mode, the agent gives its plan for approval (`exit_plan_mode`). The plan card has
  "Reject", "Revise…", "Accept", and "Accept and allow edits" with a menu of the other modes.
- Agent types for the agent tool: `general-purpose`, `Explore` (read-only search), `Plan`
  (read-only architect), and custom agents from `.claude/agents` or `.harness/agents`. `/agents`
  lists them.
- Hooks in the settings files, in the form of Claude Code hooks: `SessionStart`,
  `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, and `Stop`.
- Auto memory: the agent keeps notes about you and the project between sessions, with the
  `memory` tool. `/memory` lists them. Settings > General > "Auto memory" turns it off.
- The `read` tool shows images to a model that accepts images.
- Scheduled prompts with a cron expression: `cron_create`, `cron_list`, and `cron_delete`. A
  recurring one ends after 7 days. The task lists show them as "Scheduled".

### Chat

- The working line is at the bottom of the chat, as in the Claude app: dots, the step of the task
  list in progress (or what the agent does), the time, and a caret that shows the details.

## 0.1.38 (2026-11-03)

### Background work

- When a background task ends, the agent gets a note and continues, as in Claude Code. The note
  goes into the running turn, or it starts a new turn, also for a session in the background.
- New tools: `agent` (a subagent, also in the background), `monitor` (each new output line of a
  command is a note), and `schedule_wakeup` (a turn after a delay).
- The session rail shows all running tasks with their kind: Command, Monitor, Agent, or Wakeup.
- Settings > General > "Subagents" turns the agent tool off.

### Browser

- The dev servers are in the Browser pane. The Servers pane and the Servers menu of the title bar
  are gone. An empty tab lists the servers of `.harness/launch.json` with play buttons.
- "Annotate" opens a bar at the bottom of the pane: select an element, pen, shapes (line, arrow,
  rectangle, ellipse, step), text, and color. "Add to prompt" puts a screenshot of the page with
  the marks into the prompt box (desktop app).

### Prompt box and chat

- Paste or drop a screenshot: it shows as a thumbnail, and a model with image input gets it.
- An element note of the browser shows as a small chip. Remove a chip or an image with its x, or
  with Backspace at the start of the box.
- Each session keeps its own unsent prompt.
- The chat follows the agent only at the bottom. A round button goes back down, with three dots
  while the agent works.

### Settings

- General > "Agent instructions": how to think, do research, and speak. Only the agent that you
  talk to gets them.
- Providers (was Connections) > "Choose the model by network": a default model, and a local model
  for a computer with no connection.

### Window and layout

- Closing the app while an agent works asks first: "Quit anyway", "Wait for the agent", or
  "Cancel".
- The session rail closes when a pane opens, and opens again when the last pane closes.
- The Capabilities page has tabs: Skills, MCP servers, and Connections.
- A folded project shows its running, waiting, and unread sessions.
- The sidebar is at most 384px wide. The title bar has a line under it.

## 0.1.37 (2026-11-03)

### Capabilities

- A new "Capabilities" item under "New session" in the sidebar opens one page with the skills and
  the MCP servers. It replaces the Skills and MCP panes. `/skills` and `/mcp` open it.
- Each row shows the name, a short description, and a status: "Enabled", "Command only", or
  "Agent only" for a skill, and "Connected", "Connecting", "Failed", "Disabled", or
  "Not connected" for an MCP server. A red dot on the sidebar item shows a failed server.
- A filter finds skills and servers by name, description, command, or tool name.
- A skill row opens the skill. A server row shows its command or URL, its error, and its tools.
  "Reload all", the restart button of each server, and "Edit mcp.json" stay.
- With no session, the page shows the skills and the configured servers of the selected project.

### New session page

- "Open folder…" and "New project…" are small text buttons under the folder block.
- The folder block stays after a folder pick, until you start the session. The prompt box gets
  the focus.
- In the IDE view, the Files pane, the editor, the terminal, and the chat show at once. A folder
  from the block in the editor moves the empty session to that folder.
- A switch back to the Code view before a prompt removes the empty session and shows the new
  session page again. The app opens in the view that you used last.

### Sidebar

- When the sidebar is hidden, the pointer on the sidebar toggle shows the sidebar over the view.
- The sidebar is at least 216px wide, so the Code / IDE switch fits.

### Connections

- Each endpoint in Settings > Connections has a copy button after its URL.

## 0.1.36 (2026-11-03)

### New session page

- The new session page looks like the Claude new session page. A block in the center shows the
  3 most recent project folders, "Open folder…", "New project…", and "Show more". The prompt box
  is at the bottom of the window, at the same place as in a session.
- The block shows when the app opens, after "New session", and after the "+" of a project. The
  "+" of a project puts the check mark on that project.
- "Show more" shows all the project folders.
- "New project…" asks for a folder name and a location, and makes the folder. The location stays
  the same for each new project until you change it.
- In the IDE view, the same block shows in the editor. A folder from it starts an empty session.
- The page no longer shows the recent sessions. The sidebar shows them.

### Files

- On macOS, a rename that changes only the case of a name works.

## 0.1.35 (2026-11-02)

### Previews

- The Preview pane shows PDF and Word files. A click in the file tree, or the show_document tool
  of the agent, opens a file.

### Files

- The file tree menu has "Copy path" (Shift+Alt+C) and "Rename…" (F2).

### Updates

- The update popup has an "Update now" button, and it shows the download progress.

### IDE view

- The IDE view uses a VS Code layout by default: the files at the left, the editor with the
  terminal under it, and the chat at the right. The terminal opens again at its last place.

### Session rail

- The folded Context section shows the percent in use. The open section shows the usage.
- "Keep computer awake" is in the Environment section.
- In the Code view, the rail closes when the Preview or the Browser pane opens.

## 0.1.34 (2026-11-02)

### Documents

- The agent reads PDF, Word, PowerPoint, and Excel files. It sees numbered paragraphs, tables,
  slides, and cells, and can read only some pages of a PDF.
- The agent changes and makes Word, PowerPoint, and Excel files with the new office_edit tool:
  text, paragraphs, table cells, slides and notes, cells and formulas, and sheets. The permission
  request shows the change as a diff of the text. Rewind restores the file.

### IDE view

- Autocomplete in the editor, as GitHub Copilot: when you stop typing, the model suggests the code
  at the cursor in gray. Tab accepts it. "Autocomplete" in the status bar turns it off.
- New file and New folder in the Files sidebar, a language menu in the status bar, and a sidebar
  edge to drag. Files that the editor cannot open are gray. The sidebar buttons go into a "⋯" menu
  when the sidebar is narrow.
- Settings > Appearance > IDE view, and a Layout menu in the title bar: the Classic, Focus, Wide
  terminal, and Review layouts, the chat side, and the first sizes.
- The app opens in the Code view, and each new session starts in it. "IDE" on the start screen
  starts an empty session, so the files show at once.

### Chat

- The agent can show its task list under the messages, and a box at the end of a turn with a
  recap, a question, and answer buttons, as Claude Code does.
- Ctrl+U in a prompt box adds files to the prompt. "Open folder…" in the Files sidebar moves the
  session to another folder.
- The model shows without its provider, except in the menus. When the mode and the model do not fit
  under the prompt box, only their icons show.

### Appearance

- An accent color: white by default (black in the light theme), the old clay orange, four other
  colors, or a custom color.
- "System font" for the code font. The Visual Studio themes are the default code themes.

### Fixes

- The terminal no longer takes the keyboard from the editor or the prompt box.
- A session that moves to another folder gets new terminal shells, with no "Unknown terminal" error.
- Menus and the context panel fit in narrow panes. The space under the last terminal row is no
  longer black. The installer loading bar is white.

## 0.1.33 (2026-11-02)

### IDE view

- A switch with "</>" and "IDE" is at the right end of the sidebar head. When the sidebar is
  hidden, it is in the title bar, after Back and Forward.
- The IDE view is like Cursor: the file tree and the editor, the terminal under them, and the chat
  at the right. It hides the sessions sidebar and the session rail. Each view keeps its own layout
  for each project.
- In the editor, Ctrl+K opens an inline box at the selected lines. Type an instruction and press
  Enter: the agent gets the instruction with the lines. "Edit with agent" in the status bar does
  the same. Ctrl+L adds the selection to the chat.

### Session rail

- A column at the right of a session shows the details of the session: Environment (the computer,
  the folder, the branch, and the worktree), Context (the tokens in use and "Compact this
  session"), Pull requests, Servers, and Background tasks. A section with no data does not show.
- The button at the right end of the title bar shows or hides the rail. Each section folds. In a
  narrow window, the rail covers the session, and Esc closes it.

### Git worktrees

- On the start screen, the worktree chip can start a session in an isolated copy of the repository,
  from a branch that you select. The session gets a new branch `harness/<name>` and its own folder.
  Your project folder does not change.
- The title bar shows the branch of a worktree session. The archive of a session with changes that
  are not in a commit asks first. The branch and its commits stay.

### Appearance

- Settings has a new Appearance page: Theme, Accent color, Interface font, Text size, Transcript
  width, and Density. Code appearance has the Code font and the Light and Dark code themes.
- The accent color is white by default (black in the light theme). Clay (the old orange), Blue,
  Green, Purple, Pink, and a custom color are also available.
- "Reset to defaults" puts the appearance settings back. The theme stays.

### Permissions

- The permission modes have the Claude names: Manual, Accept edits, Plan, Auto, and Bypass
  permissions. Each mode has a description in the mode menu.
- A permission request asks "Allow Claude to {action} {object}?" with Deny (Esc), Always allow
  (Ctrl+Shift+Enter), and Allow once (Ctrl+Enter). A note tells where Always allow saves the rule.

## 0.1.32 (2026-10-02)

### Plugins

- Harness no longer runs plugins made for DeepSeek Harness (npm bundles). The Plugins screen shows
  only Harness plugins. Harness plugins (`plugin.json` bundles) work as before.
- At start, the daemon deletes the data of the DeepSeek plugins: the folder `~/.harness/dsh` and the
  file `~/.harness/plugin-host-path`.
- The installers are smaller: they no longer contain the Node plugin host and its packages.

### Settings and privacy

- Settings > General > Updates has "Check for updates at start". It is on by default. When it is
  off, the app looks for a new version only when you click "Check for updates".
- "Show PR status" in the sidebar filter is now off by default.
- The file `docs/PRIVACY.md` in the repository lists each network connection of the app.

## 0.1.30 (2026-10-02)

### Chat

- "Send while the agent works" in Settings > General has 3 choices: Queue (the default), Interrupt,
  and Steer. With Steer, the agent reads your message at its next step, and the turn continues.
- A queued message shows as a bubble at the end of the chat. Hover over it to see "Send now"
  (interrupts the turn) and "Remove".
- Hover over a message that you sent to see its time, Copy, Rewind, and Fork.
  - Rewind goes back to the time before the message. You can restore the conversation, the files
    that the agent changed with `edit` and `write`, or both. The message goes back into the prompt box.
  - Fork opens a new session with the conversation before the message.
- The hint in the prompt box during a turn tells what Enter does.

### Sidebar

- Search the sessions with the search button or Ctrl+K.
- The filter button sets Status (Active, Archived, or All), Group by (Folder or None),
  Sort by (Last activity or Created), Show empty groups, and Show PR status.
- Archive and unarchive a session from its menu (key A).
- Show PR status shows the pull request of the branch of each project folder. It needs `git` and `gh`.
- Projects with the same name show their parent folder after the name, for example "app · work".
- Right-click a session to open its menu. Right-click a project for New session, Move up, Move down,
  Sort A to Z, and Archive all.

### Browser

- The ⋮ menu of the Browser pane has the items of Claude: Open in your browser, Save screenshot,
  Open HTML file, Viewport, Show dev server logs, Open links in built-in browser, Auto-verify
  changes, Manage allowed sites, Keep cookies (Always, Until quit, or Until a server restarts),
  and Clear browsing data.
- Manage allowed sites lists the sites that the agent browser opens with no question.

### Other changes

- The app reconnects to its daemon after the computer wakes from sleep, and when the network comes
  back. It also tries again when the connection closes.
- The API key field on the Connections page shows the saved key, masked. Buttons show the key and copy it.
- The permission modes are all grey. On the start page, the mode is on the left of the project.
- A warning shows at the bottom left when the daemon has another version than the app, for example
  a remote daemon that was not updated. It stays until you connect to another daemon, or start the
  update. Settings > General also marks the different versions.
- "Update daemon" on the warning sends the daemon of the app version to an older remote daemon. The
  daemon installs it with pip and restarts, and the app connects again.
- The "Limit tool calls" switch in Settings > General turns off the tool call limit.
- The tool rows, the notices, and the permission titles of the chat follow the chat font size.
- The Settings dialog has a Changelog page.

## 0.1.29 (2026-10-02)

- Plugins is a page of the Settings dialog, after General. The sidebar does not show a Plugins button.
- The default tool call limit is 250, not 50.
- The default chat font size is 14, not 15. Your messages follow the font size setting too.
- A step with the arrows in a number field of Settings > General saves at once.

## 0.1.28 (2026-10-01)

- The installer shows the progress as a percentage under the loading bar.

## 0.1.27 (2026-10-01)

- The local daemon starts in about 1 second, not 7.5.

## 0.1.26 (2026-10-01)

- The start page shows 3 recent sessions, and the prompt box stays in place.

## 0.1.25 (2026-10-01)

- The installer uses the sidebar color, text buttons, and fewer words.

## 0.1.24 (2026-10-01)

- OpenRouter is a provider kind.
- The prompt box has the sizes of the Claude prompt box, and follows the density setting.

## 0.1.23 (2026-10-01)

- The sidebar uses the font sizes and the columns of the Claude desktop sidebar.
- Settings > General has a Density choice: Compact (the default) or Comfortable.
- Drag a project, or press Alt+Up or Alt+Down, to move it. The order is saved.

## Earlier versions

- The MIT license, a one-click installer, and an update check at launch.
- The Settings dialog (Ctrl+,) and the new session shortcut (Ctrl+N).
- A window for each pane, browser and terminal tabs, a side chat, and background tasks.
- Skills in the middle of a prompt with "/".
- The title bar of the app, prompt suggestions, and back and forward.
- Queued prompts, a session menu, a folder menu, and a mode menu on the start page.
- Grouped tool calls in the chat, and file changes.
- Plugins, the DeepSeek plugin bridge, and the auto permission mode.
- Session titles from the model, and a working line as in Claude Code.
- A terminal pane, the pane shortcuts of Claude, and Ctrl+B for the sidebar.
- Sessions that keep running in the background, and session states.
- Project sessions, @ references, permission modes, and the context ring.
- The Cookbook for local models, the MCP client, saved projects, and the Providers screen.
- The daemon, the desktop client, and the packaging.
