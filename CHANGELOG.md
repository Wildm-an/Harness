# Changelog

The changes in each version of Harness. The newest version is first. The Settings dialog shows
this file on its Changelog page.

## 0.1.75 (2026-11-12)

### Computers

- On Windows, the play button with "Also listen on Tailscale" checks Windows Firewall. When the
  port is blocked, Windows asks for administrator rights one time. Then the app adds the rule
  "Harness remote daemon" (TCP 8765, only from Tailscale addresses, only for the daemon program,
  and only on the Tailscale interface), and removes the block rules
  of the daemon program. Before, the firewall dropped the connections of the other computers.
- When the port is still blocked, the page says so, with "Allow in Windows Firewall".

## 0.1.74 (2026-11-11)

### Computers

- The play button of Settings > Computers can also listen on the Tailscale address of this
  computer: the switch "Also listen on Tailscale" shows when Tailscale runs, and it is on by
  default. Before, that daemon listened only on 127.0.0.1, so a connection through Tailscale failed.
- A connection to an address where no daemon answers now says "Cannot reach a daemon at
  {address}". Before, it said that the daemon did not reply to the token.
- The token field of a remote daemon has one show button and a copy button. The second eye was
  the built-in button of the WebView, and it is gone from all secret fields.
- Edit of a remote daemon fills in the saved token, so you can show it or copy it.

## 0.1.73 (2026-11-11)

### Computers

- Settings > Computers has a play button next to the start command. It starts the daemon of this
  app on port 8765, so other computers can connect to this computer. The daemon uses the token file,
  so its token stays the same. It stops when you quit Harness.
- While that daemon runs, "Show token" shows its token, with a copy button. The play button
  changes to a stop button, "Stop remote daemon".
- "New token" restarts that daemon with a new token. The computers that use the old token lose the
  connection, and they cannot connect again.
- The page shows the computers that are connected to that daemon now: the name, the address, the
  app version, and the time of the connection. The app now sends its computer name and version when
  it connects to a daemon.
- While that daemon runs, the tray menu has "Stop remote daemon".

## 0.1.72 (2026-11-11)

### Memory

- The agent must keep the project memory current. Before its final answer, it saves the new facts
  of the task. It saves a correction or a preference of the user at once.
- A memory check at the end of a turn: when the turn saved nothing, and you told the agent a
  preference ("always", "from now on", "remember") or the turn was long, the agent gets one more
  step to save facts. It does not write its answer again.

### Appearance

- The status colors have new palettes. On the dark theme they are softer, so they agree with the
  greys. On the light theme the text shades are dark, and the dots, bars, and borders are brighter.
- The scroll-to-bottom button is a circle again.

## 0.1.71 (2026-11-11)

### Appearance

- The dark theme is now grey on dark grey, with no hue. The light theme is light grey on off-white.
- The default accent color "White" is a neutral grey.
- All corners have one small radius. Switches and dots stay round. All outlines are thin.
- Inline code in the chat is white on the dark theme, and black on the light theme.
- The session rail has the color of the chat. The sidebar is a little lighter than the chat.

### Layout

- The footer of the sidebar is one row: the name of the connection, then the computer.
- The prompt box is nearer to the bottom edge of the window.
- The bubble of your message is smaller.
- Each pane header is smaller. The editor shows no empty tab row.
- The Files pane of the IDE view has one header row. The Files and Search switch and the "⋯" menu
  of the file actions are in that row.

## 0.1.70 (2026-11-11)

### Updates

- The install page shows "Installing Harness", and the version under it in a smaller gray font.
- An update deletes the old installers that earlier updates left in the temp folder. Each one is
  about 90 MB.

## 0.1.69 (2026-11-11)

### Routines

- Each routine row has a "Run now" button. You do not have to open the routine to run it.
- "Duplicate" in the routine view makes a copy and opens it. The copy has the name "{name} (copy)",
  and the Name field has the focus. The schedule of the copy is off.
- The Prompt box grows with the prompt, so you can read all of it.

### Your Harness

- "Agent instructions" is now "Global instructions". They apply to all projects.
- "Project instructions" has one text box for each project. The agents of that project follow it.
- "Output style" sets how the agent writes its replies: Default, Concise, Explanatory, Learning, or
  Proactive. "New output style…" makes a style from your description.

### Connectors

- Outlook (classic) can organize the mailbox in the "Drafts" and "Send" modes: make, rename, and
  move folders, move messages to a folder, and mark messages as read or unread. It does not delete.

## 0.1.68 (2026-11-10)

### Browser

- A tab that opens from the session rail stays inside the Browser pane. Before, the page showed
  over the chat for a moment.
- A pane that opens again in its last place does not start again. Before, the Browser pane moved
  its page out of sight and back.

## 0.1.67 (2026-11-10)

### Browser

- The Browser pane page stays inside its pane. Before, a difference in the screen scale could put
  the page over the chat.
- The chat shows no browser card when the agent opens a page. The page shows in the Browser pane
  and in the session rail.

### Chat

- "Send now" of a queued message keeps the task list. A stop with Esc still hides it.
- "Open" on a file card opens the file in its default app. Programs and scripts do not open. A
  file that does not open shows an error popup.

### Session rail

- The grip of a section heading does not cover the value of the heading, for example the context
  share.

## 0.1.66 (2026-11-10)

### Chat

- An error of a turn shows as a card with a title, "Try again", and "Copy details". The errors of
  pages, the sidebar, and the panes show in a popup at the bottom right, not in the middle of a
  reply. The same message shows one time with a count.
- The number keys and Esc of a permission, question, or plan card work from the prompt box. Esc
  answers the card and does not stop the turn. The empty prompt box names the keys.
- Stop shows during the whole turn. When the box has text, Send shows next to it.
- A request shows in one place. While a permission card waits, the tool row of its call does not
  show. After the answer, one row shows with "Allowed once", "Always allowed", or "Denied". The
  "Asked 2 questions" row above a question card is gone.
- Each code block has "Copy code", and each finished reply has "Copy message".
- A queued message is a muted bubble with a dashed edge, a "Queued" label, and "Remove" and
  "Send now" that always show.
- After a rewind, "Undo rewind" brings back the messages and the files.

### Safety and data

- The actions that remove a sign-in, a token, a host, or a connection, or that stop a program, ask
  first. A terminal tab asks before it closes only when a program runs in it.
- "Archive all" and the side chat "Clear" show a popup with "Undo".
- A failed save keeps the editor text, with "Try again".
- A session start with no connection does not lock the start screen. The "connection closed"
  banner shows on all screens.
- In Settings, Esc closes an open form first, and Harness asks before typed text is lost. A new
  form scrolls into view and takes the focus.
- The secret fields (tokens, keys, the mail app password) have a show and hide button.

### Look and feel

- Menus, dialogs, panes, opened rows, and new chat items move in softly. With "reduce motion" on,
  nothing moves.
- Gray placeholder rows show while Settings, the sidebar, and Changes load. The sidebar keeps its
  list when the connection comes back.
- A click on a skill keeps the list, with a spinner in the row, until the skill opens.
- Font sizes, corners, switches, back links, check marks, and file sizes are the same in all of
  the app. The ⋮ button shows an accent dot, not a red dot, while tasks run.

### Sessions

- A click on the session title in the top bar renames the session. A caret at the right of the
  title opens the session menu. The folder name shows at the left of the title.
- The X of the Browser pane also removes the view of the agent page from the session rail. The tab
  stays open. "Minimize" still keeps the view in the rail.

## 0.1.65 (2026-11-10)

### Chat

- Rewind does not ask what to restore. It always restores the code and the conversation. In the
  "Rewind" dialog (Esc two times), a click or Enter on a message rewinds to it. The rewind button
  on a message rewinds with one click.

### Sessions

- The "Worktree" row of the Environment section shows only for a session in a worktree, or when the
  "Worktree" box of the start screen is on for the project of the session.
- The Background tasks section of the session rail shows only the running tasks. A task that ends
  goes away from the rail.
- In the Background tasks pane, the tasks that ended go into a "Finished" group under the running
  tasks. The group starts folded. Click its heading to open it.

## 0.1.64 (2026-11-10)

### Chat

- Tables in the chat look as in the Claude app: the full width, a line below each row, no vertical
  lines, and a bold header at the left. A table that is wider than the chat scrolls in its own box.
- The chat shows equations. Write LaTeX as `$...$` or `\(...\)` in a line, and as `$$...$$` or
  `\[...\]` for a display equation. A dollar amount such as "$5" stays text.
- The agent writes equations in LaTeX.

### Sessions

- "Delete" in the session menu opens a "Delete session?" dialog. The focus starts on "Delete", so
  Enter deletes the session. Esc cancels.
- The confirm button of each confirm dialog has a danger-color outline.

## 0.1.63 (2026-11-09)

### Models

- The model chip on the new session screen shows the model that you chose last. A model change in a
  session counts too. Before, an old model came back after each start and each update.
- A saved model that no provider gives now shows as "Default model". While the model list loads, the
  saved model stays.
- Images that you attach go to the models of OpenAI-compatible servers. Harness reads image input from
  the model list of the server. A model with no image input shows a warning in the chat and a note
  under the image.

### Chat

- When a turn ends with open steps in the task list, the agent gets one reminder to close the list.

### Files and Browser

- A file opens in an unpinned tab (an italic name). The next file takes its place. A pin, a
  double-click, or an edit keeps the tab open.
- Drag a file tab or a browser tab to move it.
- The Browser section of the session rail has a new card: the page title, a tab menu, "Open in the
  Browser pane", "Close tab", and the page picture.
- A click on a browser card opens the Browser pane in its place. The browser does not cover the chat.

### Window

- The new session screen has no line under the title bar.
- After a click on "Hide sidebar", the sidebar stays hidden. It does not show again under the pointer.

## 0.1.62 (2026-11-09)

### Chat

- Press Esc two times to open the new "Rewind" dialog. It lists your messages in the session. Choose a
  message, then choose what to restore: the code and the conversation, the conversation, or the code.
  During a turn, Esc still stops the agent.
- A new session gets its title before the reply starts. Harness waits up to 15 seconds for the title.

### Routines

- A routine does not stop to ask if a task goes to a new session. The task stays in the routine session.
- When you delete a session, its runs go away from the run list of the routine.
- A new routine starts in your "Default permission mode" of Settings > General.

### Updates

- The note "Harness updates when the agent is done" shows at the top of the window. It does not cover
  the prompt box. The note "Harness quits when the agent is done" moved there too.

### Connectors

- In the installed app, the tools of the Outlook (classic) connector that read a date (messages and
  calendar events) do not fail with "No module named 'win32timezone'" again.

## 0.1.61 (2026-11-09)

### Operating Harness

- A harness can use a model of your providers: choose it in the new "Model" row of Settings >
  Operating Harness. Harness gives the harness the server address, the key, and the model when it starts
  the harness. It does not change the config files of the harness. This works for Qwen Code, goose, Codex,
  and OpenCode. Codex needs a server with the OpenAI Responses API, for example Ollama.

### Window tabs

- The close X of a browser or terminal tab is at the right edge of the tab.
- A tab is up to 240px wide. The tabs get smaller to share the room of the header.
- A double-click on the divider next to the Browser pane minimizes the browser to the session rail.

### Chat

- When you open a dropdown in the chat, for example a tool row or the Rewind menu, the chat scrolls so
  you can see it. Before, an opened dropdown at the bottom of the chat stayed out of view.

## 0.1.60 (2026-11-09)

### Connectors

- A new Outlook (classic) connector uses the classic Outlook app on the daemon computer, with the
  accounts that are signed in to Outlook. It needs no Microsoft sign-in and no app registration.
  Windows only. The agent can read folders, messages, and calendar events. You choose if the agent
  can also make drafts and replies, or also send a draft. The server is part of Harness.

### Updates

- Settings > Operating Harness has a "Download" button for the harnesses of the ACP registry. Harness
  downloads the program for your computer (it checks the sha256 of the registry), or installs the npm or
  Python package. A downloaded harness shows "Update" when the registry has a newer version, and you can
  delete the download. "Check again" also looks for updates.
- In an ACP session, the browser, file, and artifact cards now show in the chat when the other
  harness uses a Harness tool. The new PDF and Word files of these tools also get a card.
- An update of Harness on Windows does not fail with "Error opening file for writing" on
  `harness-daemon\_internal\VCRUNTIME140.dll` again. The cause was a local llama-server that
  continued after Harness closed and kept that file open.
- A local llama-server on Windows now stops when the daemon stops, also when the app kills the
  daemon. The daemon puts it in a Job Object. At the next start, the Local Models screen and the
  model list do not show the stopped server.
- llama-server does not load DLL files from the daemon folder when Windows has the Visual C++
  runtime.
- Before the installer writes the files, it stops each process that runs a file of the install
  folder or has a DLL file of that folder open. The uninstaller does this too.

## 0.1.59 (2026-11-09)

### Operating Harness

- Harness connects its features to the other harness when the harness supports them:
  - The file reads and edits go through Harness: an edit keeps a checkpoint for the rewind, the deny
    rules and plan mode apply, and the open editor tabs update.
  - Harness runs the commands of the harness, and the tool rows show their output.
  - The harness gets the Harness tools that it does not have (browser preview, documents, background
    tasks, memory, session search) and your MCP servers, through one MCP server named "harness".
  - The commands of the harness show first in the `/` menu.
  - The chip under the prompt box shows the model of the harness, and opens a menu to change it.
  - The context ring shows the context use that the harness reports.
- The harness starts when the session opens, so its models and commands show before the first prompt.

## 0.1.58 (2026-11-06)

### Operating Harness

- Settings has a new page, "Operating Harness". It chooses the harness that runs the agent loop of new
  sessions. "Harness" (the built-in loop) is the default.
- Other harnesses connect through ACP, the Agent Client Protocol. The list has 41 harnesses from the
  ACP registry, for example OpenCode, Codex, Claude Agent, Gemini CLI, goose, Qwen Code, Cline, and
  Oh My Pi. Each row shows if the program is installed, or if it runs with npx or uvx.
- A "Recommended" group comes first: OpenCode, Oh My Pi, Codex, Claude Agent, Gemini CLI, goose,
  Qwen Code, and Cline. Each row says why, and a "Local models" pill shows the harnesses that can use
  a local model server.
- You can add a custom harness with a name and the command that starts it in ACP mode.
- In a session of another harness, the chat shows its text, thinking, tool calls with diffs, task
  list, and permission requests. The harness name replaces the model menu, and the context ring does
  not show.

## 0.1.57 (2026-11-06)

### Window

- The corner radii are tighter: buttons 4px, menus and cards 6px, panels and the prompt box 8px,
  and the sidebar rows 4px (6px in the comfortable density).
- The context ring is under the prompt box again. The Context heading of the session rail shows
  only the percentage.
- The hover fill of a section heading in the session rail stays inside the lines between the
  sections.
- A hover tip that would go on the page of the Browser pane goes to the other side of its button,
  or next to it.

### Changes

- A click on the Changes section of the session rail opens the Changes pane with all the changes
  of the branch, as in the Claude app: "{base} → {branch}" with a menu (all changes of the branch,
  or only the uncommitted changes), search, a list of the files, and a section for each file with
  the line numbers, the changed words, and the syntax colors. Before, the pane was empty.
- The Changes section of the rail lists the pull requests of the session, the newest first: the
  ones that the agent made, and the one of the branch. Each row shows the state icon, the title,
  and "{repository} #{number}".
- The state icon of a pull request follows GitHub: the rail checks again every 30 seconds while
  the window shows, and when the window gets the focus.
- The git button ("Create PR", "Commit", "Push") goes away after a click and while the agent works,
  so a second click cannot ask for the same pull request again.

### Browser

- The annotation bar is a row under the page, as in the Claude app. The page gets smaller, so the
  bar covers no part of it. The drawer is gone.

### Chat

- The caret of an open finished plan is at the far right, after the total time.

### Daemon

- The new message `git.diff` gives the full change of a folder for the Changes pane.

## 0.1.56 (2026-11-06)

### Chat

- The end-of-turn box keeps the recap short: 300 characters or less, and the question 100 or less,
  as in the Claude app. The details go in the final answer.
- A finished plan shows at the top of the end-of-turn box, so the plan and the recap are one card.
- The toolbar of a user message shows "Read" or "Sent", then the time. "Sent": the turn runs and
  nothing came after the message yet.

### Window

- The context ring is at the right of the percentage in the Context heading of the session rail.
  Its panel opens under the heading. The prompt box of the main session no longer shows the ring.
  The split pane keeps its ring.
- The interface font is the system font by default (Segoe UI on Windows). IBM Plex Sans is an
  option in Settings > Appearance > Interface font.

### Daemon

- When the check of the model endpoint finds no context length (for example, a timeout while the
  server is busy), the daemon does not keep the default of 8192 tokens for 10 minutes. A session
  with the default checks again before its next turn, at most one time each minute. The check
  waits up to 10 s, not 3 s. Before, a busy server could give a 1M-token model 8192 tokens, and
  the session compacted early.

## 0.1.55 (2026-11-06)

### Chat

- The task list shows the time of each completed step at the right. A finished plan shows its
  total time on the folded line and on "Plan finished". The times stay after a reload.
- The agent updates the task list as soon as a step finishes. After 8 tool calls with no update,
  the daemon reminds it. Before, some models marked all steps completed at the end.
- A question card can show a preview of each option (a mockup or code) next to the options. You
  can add notes to an answer: the agent gets them with the answer.
- A visual shows short loading lines until it loads, and has a download button (.svg or .html).
- The agent can send files to you with `send_file`. Each file gets a card with "Open" and
  "Show in folder". A file can open in a pane at once, or in its default app. When the agent
  sends a file on its own, a notification shows if you do not look at the session.
- The agent can publish an HTML page as an artifact with `artifact`. The card opens the page in
  the Browser pane. A new publish of the same file makes a new version. The artifacts are local,
  in `~/.harness/artifacts`. A delete asks you first.

### Window

- The update popups move to the left of the Browser pane, so the pane does not cover them. Each
  popup has an X at the top right ("Close", Esc).

### Settings

- Each provider row has a quick test button. It tests the saved values and key, and shows the
  result under the key.

### Daemon

- In auto mode, an MCP tool that its server marks as read-only runs with no model check, as a
  read-only bash command does. Each check took about 3 s.
- The daemon log gives the cause when a model endpoint cannot be reached.

## 0.1.54 (2026-11-06)

### Browser

- The annotation bar floats over the bottom of the page, with no band under the page. It is in a
  drawer: the handle slides it down, so you can mark the part of the page behind it. The
  "Annotate" tab at the bottom edge pulls it back out (a click or a drag up). The screenshot of
  "Add to prompt" does not show the bar.
- A page that comes back from the session rail shows at once. Before, it stayed blank until a
  resize of the window.
- A new tab does not take the keyboard focus. A page that the agent opens does not stop your
  typing in the prompt box.
- "New tab" and Ctrl+T put the cursor in the address bar.

### Chat

- Sent and queued messages show their browser annotations as chips above the text, as the prompt
  box does. A queued message shows its pasted images too.

### Window

- A line separates the session rail button from the pane buttons in the title bar.

## 0.1.53 (2026-11-05)

### Daemon

- The daemon makes its model requests as in 0.1.51 again. The request changes of 0.1.52 are
  removed: the title and the next-prompt suggestion send a short prompt again and run as before,
  the tool order, the retry of rejected request fields, and the background checks (open files,
  server logs, hook settings, the file scan of commands) work as in 0.1.51.
- Tool search: when the MCP tools are large (more than 4,000 tokens or 10% of the context), the
  request has only their names. The agent loads the tools that it needs with `tool_search`, and
  then uses them. With the GitHub MCP server, each request is about half the size. The setting
  `"tool_search"` in settings.json is `"auto"` (the default), `"on"`, or `"off"`.
- The daemon log has one line for each model request: the time to the first byte, the first
  reasoning, the first answer, and the end. A slow model server then shows in the log.
- The context view puts the size of each tool in the correct part again.

### Pull requests

- The Changes section of the session rail shows the pull request of the branch, and the work in
  three parts with their own color and icon: Uncommitted, Not pushed, and Pushed.
- The git button has the menu of the Claude app: "View changes", "Create PR", "Create draft PR",
  "Manually create PR", and "Dismiss".
- A pull request link in the chat, the PR row of the rail, and the PR mark of a worktree session
  row show a hover card with the state, the repository, the time, the title, the author, and the
  line counts. The row menu has "Open PR".

### Files

- The Files pane of the Code view has the editor at the left and the tree at the right, with
  "Filter, or ? to search in files" at the top of the tree. The header has search, "Collapse all
  folders", the file tree switch, and a more menu.
- The tree shows the git state of each file in both views: a color and a letter for a changed
  file, and a dot for a folder that holds one.
- Files is a button with a folder icon in the title bar, to the right of Browser.

### Window and panes

- The more menu starts with "Side chat" (Ctrl+;), then "Background tasks", "Preview", and "IDE
  view" (Ctrl+E). The Code / IDE switch is removed for now. Ctrl+E still switches the view.
- The Browser pane has "Minimize": the page moves to a small live view in the session rail. A
  click on the view opens the pane again.
- The annotation bar of the Browser pane is a small floating bar. A new line width menu shows for
  the pen and the line shapes.
- Browser and terminal tabs show their titles again.

### Colors

- The status, context, pull request, and git colors use the brighter Clear Sight palette. Each
  part of the context breakdown has its own color. The light theme uses darker shades, for a text
  contrast of 4.5:1 or more.

### Chat

- The scroll-to-agent button shows only when the working line is out of view.
- The permission and plan cards say "the agent", not a product name.

### Fixes

- Windows 11 has its correct name in the system prompt, the hello message, and the Cookbook.
- The connection tooltip says "Disconnected from".

## 0.1.52 (2026-11-05)

### Speed

- Local models answer sooner. The title and the next-prompt suggestion come after the turn, and
  they start with the conversation of the agent, so the model server keeps its cache. Before,
  each of these requests made the server read the full conversation again on the next turn.
- The tool list keeps its order when a setting changes, which also keeps the cache of the model
  server.
- The daemon loads the model client at start. Before, the first request stopped the daemon for
  about 1 second.
- A request field that a model rejects is not sent again in a new session.
- In a very large project, the file scan around each command stops for 5 minutes. Before, it
  could add up to 1 second to each step.

### Chat

- The reply streams with less work: the chat renders once a frame, and only the last paragraph
  of the reply is read again. Tool rows, diffs, and your messages render only when they change.
- Typing in the prompt box no longer measures the row under it at each key.
- The working line shows "Thinking…" while the model reasons.
- Queued messages show above the task list.
- Tool code uses the code theme of Settings > Appearance.
- Your chat bubble has the corner radius of the prompt box. The jump-to-agent button shows a down
  arrow on hover.
- The model chip has the color of the other chips, with a bar before the effort level.

### Power

- The working loader draws at 30 frames a second, and stops while the turn waits for you.
- The shimmer of a running session in the sidebar uses fewer frames, and stops when the window is
  not in front.
- Open files, server logs, the browser view, and the PR status use less work while nothing
  changes or the window is hidden.

### Servers and browser

- Auto mode starts a server of the project launch.json with no question. The agent lists the
  servers first and uses a running one.
- The Browser pane has "Stop all servers". A close of the window to the tray asks to stop the
  servers that the agent started.
- Each session has its own browser tabs. You and the agent share them.
- Browser and terminal tabs get smaller to fit. A list button shows the tabs that do not fit.

### Sessions and routines

- A click on a Windows notification opens its session.
- Routines have an API trigger: "API access" on the Routines page shows the URL, the token, and
  an example request.
- Settings has "Archive inactive sessions".
- An app update asks first while the agent works: "Update now", "Wait for the agent", or
  "Cancel".
- Drag to reorder the rail sections and the sidebar projects with animation.

## 0.1.51 (2026-11-05)

### Browser

- The agent works in the Browser pane, in its own tab ("Agent: …"), one tab for each session.
  You see the same page as the agent, live, and you can use it too. All tabs share the cookies,
  so the agent is signed in where you are. A navigation of the agent shows its tab in the open
  pane. This needs the desktop app on Windows with the daemon of this computer.
- When the agent starts to work in the browser, the session rail opens with a small live view
  of the page ("Browser"). A click on it opens the page in the Browser pane.
- With a remote daemon, the agent uses a headless browser. It sends live pictures of its page,
  and the rail and the Browser pane show them.

### Session rail

- Drag a section heading to move the section, or press Alt+Up or Alt+Down on the heading. The
  order stays for new sessions and after an update. "Browser" is under "Servers" by default.
- A new "Changes" section shows "+N −N" of the session folder against its base branch. A
  repository with a GitHub remote has "Create PR": the agent commits, pushes, and opens a pull
  request. A local repository has "Commit".
- "Compact this session" is "Compact". The Context section starts folded in each session.

### Chat

- A finished task list folds into one line, "Plan finished · {n} steps". A click opens it.
- When you send a message during a turn, the task list shows "Plan from before your last
  message" at once, and the step in progress stops its spinner.
- Esc stops the agent from anywhere in the window, not only in the prompt box.
- The "Diff" pane is "Changes".

### Speed

- Sessions open faster: about 50 ms in the daemon, before up to several seconds. The open no
  longer waits for the checks of the model endpoint, and the previous session closes in the
  background.
- The daemon makes its SSL context one time. Before, each network request stopped the daemon for
  about 300 ms on Windows.

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
