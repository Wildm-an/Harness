# Harness UI/UX rules

Harness must look and act like the Code tab of the Claude desktop app. A user who knows Claude Code must find each control in the same place in Harness.

Read this file before you change the UI. If a change breaks a rule, change the rule in this file in the same commit, and give the reason.

## How these rules were made

The rules come from the shipped Claude desktop app, version `2.42304.0` (Windows, 2026-10-18):

- The Electron shell (`app.asar`): native menus, the title bar, the preference keys, and the design tokens.
- The claude.ai web bundles in the app cache. The Code tab UI loads from claude.ai, so its strings, its shortcut registry, its CSS, and its release notes are in these bundles.
- The tool interface that the desktop app gives to Claude: the pane names, the sidebar views, and the settings names.

Each rule shows the text of the Claude UI in quotes. Use the same words in Harness. Some details were not in the cached bundles. The section [Unknowns](#unknowns) lists them. Do not guess these details. Check them in the live app first.

"Ctrl" in this file is the Windows key. Claude uses "Cmd" on macOS for the same shortcut.

## 1. Core principles

- **P1. Same place, same name.** Put each control where Claude Code puts it, and give it the same label. Do not make a new name for a feature that Claude already names.
- **P2. Settings for defaults, menus for this session.** A setting changes the default for new sessions. A per-session menu changes the current session only. The description of a setting must say which one it changes ("Applies to new sessions.").
- **P3. Few visible controls.** Show the common controls. Put the rest in an overflow menu (⋮) or a "+" menu. Do not add a new row of buttons.
- **P4. Each command has three paths.** A user can find each command in a menu, in the command menu (Ctrl+K), and with a keyboard shortcut when one exists. Menu items show their shortcut on the right.
- **P5. Every hover tip names the shortcut.** Use the tooltip style in `Tooltips.tsx`: the label, then the key in a muted color. Exception that the user asked for: the scroll-to-bottom button of the chat has no hover tip.
- **P6. Harness-only features go to the nearest Claude location.** Model providers, local models, and remote daemons do not exist in Claude. Put them where the closest Claude feature lives (see section 9).

## 2. Window and title bar

- **W1.** The window has no system title bar. The app draws its own title row. The Windows caption buttons (minimize, maximize, close) are at the far right.
- **W2.** The left end of the title row holds the sidebar toggle (Ctrl+B) and Back / Forward (Alt+Left, Alt+Right).
- **W3.** Alt alone or F10 opens the app menu at the top left. The app menu has these menus, in this order: File, Edit, View, Go, Help. See section 8 for the items.
- **W4.** Claude has a "Chat / Cowork / Code" switch in the title row. Harness has only Code, so Harness does not show this switch.

## 3. Sidebar

### 3.1 Order, top to bottom

1. A "Search" field. It opens the command menu (Ctrl+K). The key hint shows on hover or focus.
2. "New session" (Ctrl+N), with a round "+" icon.
3. Nav items: "Routines", then "Capabilities". Claude shows "Routines" and "Customize". Harness shows "Capabilities" in place of "Customize" (the user asked for this name). "Routines" opens the Routines page (section 3.5). It opens the Capabilities page with the skills, the MCP servers, and the plugins (section 3.4). Permission rules are not on this page yet. See section 9.
4. "Pinned". Show the first 20 items, then "Show more". The empty text is "Tip: you can drag sessions here to pin them".
5. The session sections (projects, date groups, or custom sections).
6. A bottom tray: the update strip (section 7.4), then the account button. The account button opens a menu with "Settings", "View changelog", "Keyboard shortcuts", "Get help".

Harness now has a "More" accordion for Permission rules, and a Settings gear in the footer. Move these to the Capabilities page and the account menu.

### 3.2 Group and sort menu

- **S1.** The menu button shows when the pointer is on a group heading. Its tooltip is "Group and sort". When a filter is active, the tooltip is "Filter (active)".
- **S2.** Items, in this order:
  1. "Status": "Active" / "Archived" / "All".
  2. "Group by": "Date" / "Folder" / "State" / "None" (Claude also has "Environment" and custom sections).
  3. "Sort by": "Name" / "Date created" / "Last activity".
  4. Checkboxes: "Show empty groups", "Show PR status".
  5. "Clear filters".
- **S3.** "Group by: State" uses these groups, in this order: "Needs input", "Ready for review", "Working", "Completed".
- **S4.** "Group by: Date" uses "Today", "Yesterday", "Older".

### 3.3 Session row

- **S5.** The row shows a status mark, the title, and a ⋮ button on hover ("More options for {label}"). Right-click opens the same menu.
- **S6.** Status marks:

  | State | Tooltip | Mark |
  |---|---|---|
  | Idle | — | no mark |
  | Running | "Running" (screen readers) | no mark: the title shimmers, as in Claude (the user asked for this) |
  | Waiting | "Awaiting input" or "Awaiting answer" | yellow dot |
  | Unread | "Unread response" | accent (blue) dot |
  | Error | — | warning icon |
  | Archived | "Archived" | archive icon |

  Harness puts the mark at the right end of the row, after the title (the user asked for this). The mark is a 6px dot. On hover, on focus, and while the menu is open, the ⋮ button takes its place. An idle session has no mark, so its title starts at the left with no empty slot.

- **S7.** The row menu has groups in this order. A line separates the groups.
  1. Open: "Open PR" (Ctrl+Alt+G), "Open in" > "Split view" / "New window".
  2. Edit: "Pin" / "Unpin" (Ctrl+Alt+P), "Mark as read" / "Mark as unread" (Ctrl+Alt+U), or "Mark as completed" for a waiting or failed session, "Rename" (Ctrl+Alt+R, edit in place), "Fork" (Ctrl+Alt+O).
  3. Share: "Copy link".
  4. Organize: "Move up", "Move down", "Move to group".
  5. Settings: "Transcript view" > "Normal" / "Thinking" / "Verbose", "Output style", "Keep computer awake for this session".
  6. Remove: "Archive" (Ctrl+Alt+A), "Delete".

  Harness now uses the single keys P, U, R, A, D in this menu. Change them to the Ctrl+Alt chords above. Harness has "Open in" > "Split view" (V7a), but not "Open PR" or "New window" yet.
- **S8.** Archive asks first only when the session has uncommitted changes: "Archive session with uncommitted changes?" with "Archive anyway". Delete always asks first. The focus starts on the "Delete" button of that question, so Enter deletes the session (the user asked for this).
- **S13.** The project menu has "Remove from sidebar" under "Archive all" (the user asked for this). It is available only for a saved project with no sessions in the list. The folder, its files, and its sessions stay.
- **S9.** A drag of a row shows a label pill: "Open in split view", "Release to unpin", "Move to {label}". Harness shows "Open in split view" now (V7a). The browser fixes the drag image at the start of the drag, so the pill text does not change during the drag.
- **S12.** The edge at the right of the sidebar changes its width, from 216px to 384px (the widest sidebar of the Claude app, the user asked for it). The default is 264px. A double-click sets the default.
- **S11.** A folded project still shows the open session and its sessions that are running, awaiting input, or unread, under the project name (the user asked for this). The other sessions show when the project opens.
- **S14.** Nested sessions, as the linked sessions of the Claude app. A fork, and a session that the agent starts with the `start_session` tool, show under the session that started them (`parent_id`). A pinned session stays in the Pinned list. A session with a parent that is not in the list shows at the top level. The parent row is closed until the user opens it (the user asked for this): the nested sessions do not show. The number of nested sessions shows at the far right of the parent row, with an arrow to its right (the user asked for this place). The arrow opens and closes the list. The ⋮ button and the status mark move to the left of the number. A closed row opens when the open session is one of its nested sessions. On a closed row, the number is yellow when a nested session awaits input, and blue when one has an unread response. The open state of each row is saved. A nested session of a nested session cannot start more sessions.
- **S10.** When the sidebar is hidden, the pointer on the sidebar toggle in the title row shows the sidebar over the view (the user asked for this). It goes away a short time after the pointer leaves it, on Esc, or after a choice in it. A menu or a dialog of the sidebar keeps it. The sidebar toggle in it shows the sidebar again in its usual place.

### 3.4 Capabilities page

Claude shows skills and connectors on separate tabs of its "Customize" page. The Hermes dashboard shows them on separate "Skills" and "MCP" pages. The user asked for one page that shows both (`CapabilitiesPage.tsx`). The plugins are on the same page.

- **K1.** The "Capabilities" nav item is under "New session". It shows at all times, also with no session. A red dot shows when an MCP server failed. The page is a full screen in the main area, as the new session page. Back and Forward include it. `/skills` and `/mcp` also open it.
- **K2.** The page has the title "Capabilities", one line that names the project folder, then the tabs "Skills", "Connectors", "Plugins", and "MCP servers", in this order (the user asked for tabs and for this order). The user asked for the plugins on this page, not in Settings. The Plugins tab has the install field, the installed plugins, and "Reload". It shows a count, and a red dot when a plugin failed. `/plugins` opens it. The Skills and MCP servers tabs have a "Filter" field and a count. A failed MCP server puts a red dot on its tab. The Connectors tab lists the connectors (section 3.4, K8). The Skills tab first shows two choices, "Built-in skills" (the skills that come with Harness) and "Added skills" (all other skills), each with its count. A click opens that list, with a "Skills" button to go back, and the "Filter" field under the list title (the user asked for this). The page opens on the last tab. `/skills` and `/mcp` open their own tab. The filter finds each word in the name, the description, the command or URL, or the tool names.
- **K3.** Each row shows an icon, the name, a short description, and a status pill. A skill row also shows its source. The description of an MCP server is "{n} tools · {transport} · {scope}". A failed server shows its error.
- **K4.** Status pills:

  | Item | Pill | Meaning |
  |---|---|---|
  | Skill | "Enabled" | A / command, and the agent can use it |
  | Skill | "Command only" | `disable-model-invocation: true` |
  | Skill | "Agent only" | `user-invocable: false` |
  | MCP server | "Connected" / "Connecting" / "Failed" | The state in the session |
  | MCP server | "Disabled" | `"disabled": true` in `mcp.json` |
  | MCP server | "Needs authentication" | The OAuth server needs a sign-in. The row has an "Authenticate" button, as the `/mcp` menu of Claude Code. |
  | MCP server | "Authenticating" | The sign-in page is open in the browser. The open row has "Open sign-in page", "Cancel", and a field for the URL of the callback page. |
  | MCP server | "Not connected" | No session is open in the folder |

- **K5.** A click on a skill row opens the skill (the SKILL.md text, the files, the frontmatter) with "All capabilities" to go back. A click on an MCP row opens the command or URL, the error, the server log, and the tools. A failed server row is open at the start.
- **K6.** With a session, the page shows the session's skills and live MCP states (daemon message `capabilities.list`). The MCP section head has "Reload all" and "Edit mcp.json". Each server row has a restart button. An open OAuth server row with tokens has "Re-authenticate" and "Clear authentication", the names of Claude Code. "Edit mcp.json" opens the file in the session editor.
- **K8.** Each connector shows the logo of its service, in the text color (`ConnectorLogo.tsx`): on its Connectors row and on the MCP server row of its server. The user asked for this rule for all connectors. A new connector gets its official logo, with its source and license in `THIRD_PARTY_LICENSES.md`. A connector with no logo shows the plug icon. Exception that the user chose: Microsoft does not permit its product icons without a license, so Microsoft Outlook shows the lucide "Mail" icon with its full name. The Email connector serves many mail services, so it shows "Inbox". The Connectors tab has one row for each connector (GitHub, Microsoft Outlook, and Email (IMAP)), with "{n} of {m} connected". The row shows the account and the token source ("@login · GitHub CLI") and the pill "Connected" or "Not connected". All rows are collapsed at the start (the user asked for this). A device code opens its row. It has "Use GitHub CLI" (when `gh` is signed in on the daemon computer), a token field with "Connect", and "Create a token". A connected row has "Disconnect". An error shows in the row. The Outlook row has "Personal account" / "Work or school account", a "Read-only" box, and "Sign in with Microsoft". During the sign-in, it shows the device code in large letters, "Copy code", "Open sign-in page", and "Cancel". With accounts, the row lists each account with its type and "Remove", then "Add account" and "Disconnect" ("Disconnect all" for two or more accounts). The summary line is "{login} · {type}", or "{n} accounts · {logins}". The Email row asks for the address, the mail service (chosen from the address), the help of the service and "Make an app password", the server fields for "Other IMAP server" (host, port, security), "App password", "Read-only", and "Connect". Its accounts show as the Outlook accounts, with the name of the mail service. The tab needs no session. An MCP server row of a connector with no token has "Connect", which opens this tab.
- **K7.** With no session, the page shows the skills and the configured servers of the project that the new session page selected, with no connection. The restart buttons and "Edit mcp.json" do not show. A note says: "Open a session in this folder to connect the servers, restart them, or edit mcp.json."

### 3.5 Routines page

- **RT1.** The "Routines" nav item is the first nav item, over "Capabilities". It shows at all times, also with no session. A red dot shows when the last run of a routine failed. The page is a full screen in the main area. Back and Forward include it.
- **RT2.** A routine is a prompt that the daemon runs on a schedule, each time in a new session. Each routine is a Markdown file in the `routines` folder of the app data (`~/.harness/routines/<id>.md`, `routine_files.py`): the frontmatter has `name`, `schedule`, `cwd`, `model`, `permission_mode`, and `enabled`, and the body is the prompt (the user asked for one folder named routines). The user can edit, copy, or add a file by hand. The run history stays in the database. The daemon runs the routines also when no window is open (`routines.py`). A routine runs only while the daemon runs: see "Run on startup" (section 9.3).
- **RT3.** The page has the title "Routines", one context line with the path of the routines folder, then the list with a count and "New routine". Each row shows the calendar-clock icon, the name, "{schedule in words} · Next: {time} · {folder}" (or the problem of the file), the pill "Active" or "Inactive" (the user asked for these labels), a second pill for the run state when there is one, and a switch that turns the schedule on or off. The empty text is "No routines yet. A routine runs a prompt on a schedule, for example a summary of the changes each morning."
- **RT4.** Pills: "Active" (the routine runs on its schedule) or "Inactive" (it is off, or its file has a problem). Run state pills: "File error", "Waiting" (other routines run: at most 3 run at the same time), "Running", "Needs approval" (a permission request waits), "Last run failed". A file error or a failed last run puts a red dot on the nav item.
- **RT5.** A click on a row (or "New routine") opens the detail view with "All routines" to go back. The view has "Run now", "Delete…" (it asks "Delete this routine?"; the file goes to the Recycle Bin, and the sessions of the runs stay), "Next run: {time}", the path of the file, and the problem of the file if it has one. The form has "Name", "Prompt", "Folder" (the projects and "Choose…"), the model and mode chips of the new session page, "Schedule" ("Hourly", "Daily", "Weekdays", "Weekly", "Custom (cron)", with the time and the day), and "Run on the schedule". The buttons are "Cancel" and "Create routine" (a new routine) or "Save".
- **RT6.** The view lists the last 20 runs: the time, a status pill ("Running", "Needs approval", "Done", "Failed", "Skipped"), the error, and "Open session".
- **RT7.** A run gets a new session with the name of the routine as its title. Its sidebar row shows the calendar-clock icon. When the run ends or waits for an answer, the row gets the unread dot, and Windows shows a notification ("{name} finished", "{name} failed", "{name} needs your approval") if the window does not show that session.
- **RT8.** The mode of the routine applies to its sessions only. The project settings do not change. No one can answer a permission request while no window shows the session: in "Manual" mode, the run waits until the user opens the session and answers.
- **RT9.** If the daemon did not run at one or more due times (the computer was off or asleep), the routine runs one time at the next start, not one time for each missed time. A due time while the routine still runs is a "Skipped" run.
- **RT10.** The agent can save a routine with the tool `routine_create` (the user asked for this), and list the routines with `routine_list`. A tool is better than a skill here: the model sees a tool in its tool list and calls it directly. `routine_create` asks for approval, and the request shows the name, the schedule, the mode, the folder, the model, and the prompt. The routine works in the project folder and with the model of the session. Its mode is the mode of the session (Manual for a session in Plan mode), and it cannot be less limited. The new routine shows on the Routines page of each window at once. `cron_create` stays for reminders inside the open session, and its description points to `routine_create`.

## 4. New session screen

- **N1.** The prompt box is at the bottom of the window, at the same place as in a session. The page has no visible heading. (Changed from the "What's up next?" heading near the center: the user wants the page to match the Claude new session page, with the folder block in the center.)
- **N2.** The prompt box placeholder is "Describe a task or ask a question".
- **N3.** A row of pills under the prompt box sets where and how the session runs:
  - The environment pill. Tooltip "Where Claude runs". Items: "Local", then remote computers ("SSH", "Add SSH connection…").
  - The folder pill: "Select folder…", "Recent", "Open folder…", "Choose a folder to work in".
  - The branch and worktree option: "Work in an isolated copy of the repository", "Branch to start from". As in Claude, a "Worktree" check box is to the right of the folder chip (the user asked for this). When the box is on, a chip after it chooses the branch to start from (`WorktreeMenu.tsx`). The box and the chip show only for a project in a git repository.
  - The permission mode and the model, as in the session prompt box (section 5).
- **N4.** The page shows no recent sessions. The sidebar lists them. (Changed from a list under the pills: the prompt box is now at the bottom, so there is no room under it.)
- **N5.** When the app opens, and after "New session" (Ctrl+N), a block in the center lists the 3 most recent project folders, with "Show more" under them (`RecentFolders.tsx`). Under the block, two small text buttons show: "Open folder…" on the left and "New project…" on the right. "Show more" shows all the project folders. "New project…" asks for the folder name and its location, and makes the folder. The location stays the same for each new project until the user changes it. A folder from the block gets the check mark, and the prompt box gets the focus. The block stays until the user starts a session or opens a session (the user asked for this). The "+" of a project in the sidebar also shows the block, with the check mark on that project. In the IDE view, the same block shows in the editor of the empty session (V6g) until the user opens a file or sends a prompt. A folder from it moves the empty session to that folder, so the Files pane and the terminal show that folder. A worktree session cannot move: a new empty session starts in the folder.

## 5. Prompt box

### 5.1 Layout

- **C1.** The prompt box is one card with a large radius (`--cds-radius-composer`, 14px in comfortable density). The text area grows to `min(24rem, 40svh)`.
- **C2.** The action row inside the card, left to right: the "+" button, the text area, then Send / Stop at the right.
- **C3.** The "chin" bar under the card, left to right: the permission mode picker; then, at the right, the model picker (with effort), then the context ring.
- **C4.** The same prompt box shows on the start screen and in a session (see the memory rule "Prompt boxes have the same features").

### 5.2 The "+" menu

Items, in this order:

1. "Add files or photos" (Ctrl+U)
2. "Add folder"
3. "Slash commands"
4. "Connectors" > the MCP servers, with checkboxes, then "Manage connectors"
5. "Plugins" > the skills, then "Manage plugins"

Harness has no "+" button now. Add it.

### 5.3 Text and keys

- **C5.** The placeholder in a session is "Type / for commands".
- **C6.** Enter sends. Shift+Enter adds a new line.
- **C7.** While Claude works:
  - Stop replaces Send. Its tooltip is "Stop" with the key Esc.
  - Enter sends the message now. Ctrl+Enter queues it ("Queue for later"). The Send tooltip lists both keys.
  - A queued message shows "Queued. Claude will read this after the current turn." with "Send queued message" and "Remove queued message".

  Harness now has a setting "Send while the agent works" (Queue / Interrupt / Steer). Claude has no setting for this. Remove the setting and use the two keys.
- **C8.** The box has a bash mode: "Bash mode. Press Escape to return to chat." The placeholder is "Enter a shell command". (The key that starts bash mode is not in the bundles. The Claude Code CLI uses "!".)
- **C9.** The box has a history search: "Search history:" with "↑↓ cycle · esc cancel". (The key that starts it is not in the bundles.)
- **C10.** A prompt suggestion shows as grey text in the box after Claude replies.
- **C10a.** The box has a row of attachments above the text. A pasted or dropped image shows as a 56px thumbnail (the long side of a large image becomes 1568px). A browser annotation shows as a small code chip with the element and the note. The x of an attachment shows on hover at its top right. Backspace at the start of the box removes the last attachment. The chat shows the images of a message above its text.

### 5.4 Permission mode picker

- **C11.** The menu header is "Mode". Modes, in this order, with these descriptions:

  | Label | Description |
  |---|---|
  | "Manual" | "Always ask before making changes" |
  | "Accept edits" | "Automatically accept all file edits" |
  | "Plan" | "Create a plan before making changes" |
  | "Auto" | "Claude handles permission decisions" |
  | "Bypass permissions" | "Accepts all permissions" (warning color) |

- **C12.** "Bypass permissions" shows only after the user turns on "Allow bypass permissions mode" in Settings.
- **C13.** Harness names "Ask permissions", "Plan mode" and "Auto mode" change to "Manual", "Plan" and "Auto". Keep Shift+Tab to go to the next mode (the Claude Code CLI uses it).

### 5.5 Model picker

- **C14.** The menu header is "Model · this session". Each model has a one-line description.
- **C15.** Effort is a control in the same menu: "Low", "Medium", "High", "Extra high", "Max". Help text: "Higher effort means more thorough responses, but takes longer and uses your limits faster."
- **C16.** A change in the middle of a session asks first: "Switch model?" or "Change effort?", with "Don't ask again".
- **C17.** Ctrl+Shift+. opens the model menu.
- **C17a.** A model switch shows only in the model label under the prompt box. The chat shows no message for it (the user asked for this). A warning about the new model (for example, no API key) still shows in the chat. A typed `/model <provider>/<model>` still shows as a user message, as each typed command does.
- **C17b.** When no provider gives the model of a session, the end of the chat shows a prompt (`ModelUnavailable.tsx`, in the end-of-turn box style): "The model {provider/model} is not available", the reason, and "Switch this session to an available model?". It has a model menu (the start screen model, else the first model of the list), "Switch", and "Not now" (the user asked for this). The daemon tells when the provider is gone or off (`model_unavailable`). The client also asks when the provider lists models but not this one. A provider that does not answer is not a reason to ask. With "Preferred providers" on, the session switches to that model and does not ask.

### 5.6 Context ring

- **C18.** The ring tooltip is "Context {summary}". A click opens a panel with the usage parts and two actions: "Compact this session" and "New session".

## 6. Transcript

### 6.1 Messages

- **M1.** The user message is a bubble with a light tint. On hover it shows a toolbar, in this order: "Copy message", "Rewind to here", "Fork from here", then the time.
- **M2.** Right-click on a message gives "Copy message", "Copy message as Markdown", "Rewind to here", "Fork from here".
- **M3.** "Rewind to here" asks "Rewind to this message?" with "Code and conversation", "Conversation only", "Code only". After a rewind, show "Undo rewind".
- **M4.** "Fork from here" tooltip: "Starts a new session from this point. This one stays as it is."

### 6.2 Tool rows

- **M5.** A tool row is "{verb} {object}". It has no border and uses the muted text color. The verb has a done, a running and a failed form:

  | Tool | Done | Running | Failed |
  |---|---|---|---|
  | Bash | "Ran" | "Running" | "Failed to run" |
  | Read | "Read" | "Reading" | — |
  | Write | "Created" / "Updated" | — | — |
  | Edit | "Edited" | "Editing" | — |
  | Grep, Glob | "Searched" | — | — |
  | LS | "Listed" | — | — |
  | WebFetch | "Fetched" | — | — |
  | WebSearch | "Searched web" | — | — |
  | Agent | "Ran agent" | — | — |
  | Skill | "Ran skill" | — | — |
  | TodoWrite | "Updated todos" | — | — |
  | ExitPlanMode | "Proposed plan" | — | — |

- **M6.** An edit row shows +added and −removed line counts. A click on the file name opens it in the Changes pane.
- **M6a.** A visual of the agent is its own item in the chat, not a tool row, as the `show_widget` visuals of the Claude app. The agent makes it with the tool `show_visual` (an HTML fragment or an `<svg>`). The header line is "Made a visual" with a caret that folds the visual. The visual is open at first. It shows in a sandboxed iframe (`allow-scripts` only, no same-origin) that gets the height of its content. The frame page comes from the daemon (`/visual-frame`) with its own CSP: inline scripts and three CDNs (cdnjs.cloudflare.com, cdn.jsdelivr.net, unpkg.com) can run, and the network is closed. The app gives the theme colors and fonts as CSS variables (`--color-text`, `--color-accent`, and the others in `lib/visual.ts`), and a theme change goes to the visual at once. `sendPrompt(text)` in a click sends the text as the next prompt, as a button of the end-of-turn box. A failed call is a tool row. For a daemon on another computer (not loopback), the frame uses `srcdoc`: the app CSP then blocks its scripts in the installed app.
- **M6b.** When a tool call makes a new file that the Preview pane can show (a PDF or a Word .docx file), a file card shows in the chat right after the tool call, as the file cards of the Claude app (the user asked for this). The card shows a file icon (red for PDF, blue for Word), the file name, the type ("PDF document" or "Word document"), and the folder. "Open" (and a click on the card) opens the file in the Preview pane (V6q). The daemon finds the new files (`created.py`): a tool with a `path` (for example `write` and `office_edit`) makes a new file when the file did not exist before the call. For `bash`, it compares a quick scan of the project before and after the command. The scan skips hidden folders and `node_modules`, and stops for a very large project. A command that runs in the background gets no card. A tool call shows at most 10 cards. The cards stay in the session history: they show again when the user opens the session.

### 6.3 Permission card

- **M7.** Title: "Allow Claude to **{action}** {object}?" (for example "Allow Claude to **run** `npm test`?").
- **M8.** Buttons, left to right:
  1. "Deny" (Esc)
  2. "Always allow" or "Allow for this session" (Ctrl+Shift+Enter). Tooltip: "Don't ask again for this tool".
  3. "Allow once" (Ctrl+Enter). This is the primary button.
- **M9.** A note says where an "Always allow" rule goes: "Applies to this session only", "Saves to project settings", or "Saves to user settings (all projects)".
- **M10.** The card shows above the prompt box. Number keys also pick the buttons.

  Harness now uses the Claude Code CLI form ("Do you want to proceed?" with 1 Yes / 2 Yes, and do not ask again / 3 No). Change it to the desktop form.

### 6.4 Plan card

- **M11.** Header: "Claude proposed a plan", with the link "Open plan".
- **M12.** Buttons: at the left "Reject" and "Revise…" (Esc); at the right "Accept" (Ctrl+Shift+Enter) and the primary "Accept and allow edits" (Ctrl+Enter). The primary button has a menu: "Accept and auto mode", "Accept and bypass permissions".
- **M13.** "Revise…" opens a text area: "What should change? (optional)", with "Back" and "Revise".

### 6.5 Question card

- **M14.** Each option has a number badge. Number keys pick an option. Other controls: "Something else", "Skip", "Submit", "Next", "{current} of {total}".

### 6.6 Working line

- **M15.** The working line shows: the label, "·", the time, "·", "{tokens} tokens", and "{count} running tasks" when tasks run.
- **M16.** Labels: "Thinking…", then "Still thinking…", "Thinking more…" as time goes on. After it: "Thought for {seconds}s". Other labels: "Connecting…", "Running tools…", "Working…", "Stopping…", "Retrying ({attempt}/{maxRetries})", "Compacting session…".
- **M17.** Compaction notices: "Compacted session · saved {tokens} tokens", "Compaction failed".
- **M17a.** Harness puts the working line at the bottom of the chat, after the task list, as the Claude app does (the user asked for this). It scrolls with the chat: nothing shows above the prompt box. It shows a 16px gyroscope in the accent color: 3 rings that turn on 3 axes, each drawn as a comet arc with a tail that fades (`GyroLoader.tsx`, the user chose it). With "reduce motion" on, it is still. Then the step of the task list in progress (or "Writing…", "Running {tool}…", "Waiting for {model}…", "Waiting for your approval…", "Waiting for your answer…"), the time in muted text, and a caret. A click on the label, the time, or the caret shows the details (one button; the user asked for this). The line has no hover tip (the user asked to remove "Esc to interrupt"). The details are: "{tokens} tokens", "{count} running tasks", and the status when a step shows (`WorkingLine.tsx`). During the turn, the tool calls at the end of the chat do not show as a group line above the working line: the caret shows their rows, as in Claude Code (the user asked for this). When the turn ends, they show as a group line again.
- **M17b.** The question card and the plan card (M11–M14) are in the chat as permission cards are. A question card shows one question at a time with a header chip, the options with number badges, then "Something else" (a text field). One choice goes to the next question at once. A multiple choice has checkboxes. The foot has "{current} of {total}", "Back", "Skip", and "Next" / "Submit". An answered card shows the header and the answer of each question. The plan card shows the plan as Markdown in a box. An accepted plan sets the mode of the project.

### 6.7 Error cards

- **M18.** Use these titles: "Service is busy", "Rate limited", "Your context window is full", "Turn failed". Use these buttons: "Try again", "Copy details".

## 7. Panes and status

### 7.1 Pane buttons

- **V1.** The pane buttons are at the right of the session title bar, in this order:

  | Pane | Shortcut | Tooltip |
  |---|---|---|
  | "Terminal" | Ctrl+` | "Show terminal" / "Hide terminal" |
  | "Changes" | Ctrl+Shift+D | "Show changes" |
  | "Browser" | Ctrl+Shift+B | "Show browser" |
  | "Files" | Ctrl+Shift+F | "Show files" |

- **V2.** Buttons that do not fit go into the ⋮ overflow menu. The overflow menu also holds "Side chat" (Ctrl+;), "Background tasks" (with a count), "Plan", and "Artifacts".
- **V3.** Ctrl+\ closes the focused pane.
- **V4.** Harness calls the diff pane "Diff". Rename it "Changes". Harness puts Files in the ⋮ menu. Move it to the pane buttons.

### 7.2 Session title bar

- **V5.** Left side: the origin chip (local or remote, with the folder name), then the title. A click on the title renames it in place. A caret button opens the session menu (the same menu as S7).
- **V6.** The folder chip menu: "Copy" > "Path" / "Branch name", "Change folder…", "Open in terminal".

### 7.2a Session rail

- **V6a.** The session rail is a column at the right of a session (`role="group"`, label "Session details"). An icon button at the right end of the title bar shows or hides it. Tooltip: "Show session rail" / "Hide session rail". Label: "Session rail". Claude has no shortcut for it.
- **V6b.** The View menu has "Show Session Rail" / "Hide Session Rail". The command menu has the same command. (Harness has no app menu yet.)
- **V6c.** Claude sections, in this order: Environment, Goal, Settings, Context, Usage, Connectors, Progress, Outputs, Pull requests, Servers, Background tasks. Each section folds. The user can hide and reorder sections. The app keeps the shown state and the folded sections.
- **V6d.** In a narrow window the rail covers the session. Esc or a click outside closes it.
- **V6e.** Harness shows Environment, Context, Pull requests, Servers, and Background tasks (`SessionRail.tsx`). A section with no data does not show. Harness does not hide or reorder sections yet. Harness has no Settings section: the user asked to keep the mode and model menus only under the prompt box. The Environment section ends with the switch "Keep computer awake", the same switch as in the ⋮ menu: the user asked for it under the environment. It is a small row with an icon and a small switch, as "Remote Control" in the Claude app. Its hover text is "Only for this session".
- **V6v.** The Background tasks section of the rail shows all the running tasks, then the 3 newest ended tasks (the user asked for this). Each row shows the description and "{kind} · {state}": "Command", "Monitor", "Agent", or "Wakeup". A wakeup that waits shows "Wakeup · in {time}".
- **V6w.** When a background task ends, a monitor writes a line, a background agent ends, or a wakeup is due, the agent gets a note, as in Claude Code. The note goes into the running turn, or it starts a new turn. The chat shows the note as a muted line with a bell icon, not as a user message.
- **V6x.** The dev servers are in the Browser pane, as in the Claude app (the user asked for this). The title bar has no Servers menu. The session rail toggle is the first button at the right of the title bar, before the pane buttons. Harness has no Servers pane (the user asked to remove it). The Browser pane header has the Servers menu: start, stop, open, and "Edit launch.json". An empty browser tab shows a block with the servers of `.harness/launch.json`: the name, the port, and a play button. The play button starts the server, and the tab opens it when it runs. The first start of a command asks in the block, with the buttons of the permission card ("Deny", "Always allow", "Allow once"). The chat card asks too. With no launch.json, the block shows the servers that the harness found ("Save to .harness/launch.json"), or "Create launch.json from a template". Under the block: "Run a server to preview your app, or enter a URL. Edit this list in .harness/launch.json."
- **V6y.** The address bar of the Browser pane ends with "Annotate", as in the Claude app. It shows the annotation bar at the bottom of the pane: select an element, "Pen", the shape menu ("Line", "Arrow", "Rectangle", "Ellipse", "Step"), "Text", the color menu, undo, clear, "Done", and "Add to prompt". The marks are on the live page. "Add to prompt" puts a screenshot of the page with the marks into the prompt box (desktop app only). In the annotation mode, the element under the pointer has an outline and a label. A click on it opens a note box ("Add to prompt", "Cancel"). Each note goes into the prompt box with the page, the element, a CSS selector, its size and place, and the note. The element gets a number badge, and the button shows the count. Esc in the page, a new page, another tab, or the button ends the mode. The desktop app annotates all pages. A normal browser (development) annotates only pages of the app origin.
- **V6z.** The close X of a window tab is 22px with a 15px icon (the user asked for a larger X).
- **V6s.** The heading of the folded Context section shows the share of the context window in use, for example "Context 57%". The open Context section shows the usage parts (the same list as the context ring, C18), then "Compact this session".
- **V6u.** Each new session opens the rail in the Code view (the user asked for this). The saved shown state does not change.
- **V6t.** In the Code view, the rail closes when a pane opens next to the chat (Browser, Files, Changes, Terminal, Preview, and the others), so the pane gets the room. When the last pane closes, the rail opens again (the user asked for this). It opens again only if a pane closed it: a rail that the user closed stays closed. The saved shown state does not change, and the title bar button opens the rail at any time.
- The section titles are not in the bundles. The titles above are a guess from the section ids.

### 7.2b View switch (Harness only)

Claude Code has no IDE view. The user asked for one, as in Cursor (P6).

- **V6f.** A switch with "</>" (label "Code view") and "IDE" (label "IDE view"). Its hover tip is "Switch view" with the key Ctrl+E (the user asked for it). It is at the right end of the sidebar head, as the Chat / Code switch of the Claude app. When the sidebar is hidden, it is in the title bar after Back and Forward, but only in the IDE view. In the Code view, a hidden sidebar hides the switch (the user asked for this), and Ctrl+B shows it again. It is a radio group. The arrow keys move the choice. Ctrl+E switches the view from anywhere (the user chose this key).
- **V6g.** The Code view is the Claude layout. The IDE view is laid out as VS Code: the Files pane (the file tree and search) at the left in the full height, the editor in the middle with the terminal under it, and the chat at the right in the full height. A saved IDE layout that is still the old default (the file tree inside the editor pane) gets this default. A layout that the user changed stays. Each view keeps its own layout for each project. The app opens in the view that the user used last (the user asked for this). In the IDE view, the start screen at launch starts an empty session, as a switch to the IDE view does. A switch back to the Code view before the user sends a prompt removes that empty session and shows the start screen again, with the folder block and no session rail: only the view changed (the user asked for this). Back and Forward never open a deleted session. Each new session (New session, or a prompt on the start screen) starts in the Code view. A switch to the IDE view on the start screen starts an empty session in the selected project (with the selected model, mode, and worktree choice), so the Files pane, the editor, the terminal, and the chat show at once. A switch to the Code view closes the Files window (the user asked for this).
- **V6r.** A pane that closes gives its space to the pane next to it, as in VS Code. A pane that opens again (for example the terminal) goes back to its last place and size in that view. In the IDE view, the editor window has no close button. The open files keep their close buttons.
- **V6h.** The IDE view hides the sessions sidebar and the session rail. The Code view shows the sidebar again. Ctrl+B still shows the sidebar in the IDE view.
- **V6j.** Settings > Appearance > "IDE view" sets the layout of the IDE view, from Cursor (named layouts), OpenCode (fixed regions), and Hermes (presets): "Classic", "Focus", "Wide terminal", "Review", then "Chat side" (Right / Left), "Chat width", and "Terminal height". A change resets the saved IDE layout of each project and applies at once. The user can still drag and resize the panes. In the IDE view, a Layout menu in the title bar (to the left of the pane buttons) has the same layouts and chat side, "Reset layout", and "Layout settings…".
- **V6k.** Editor autocomplete, as GitHub Copilot: when the user stops typing (400 ms), the model of the session writes the text at the cursor. The editor shows it as gray text. Tab accepts it, and Esc hides it. "Autocomplete" in the editor status bar turns it on or off (on by default). While it is on, the word list opens only with Ctrl+Space.
- **V6m.** The Files sidebar head has "New file…" and "New folder…". A name field opens at the top of the tree, with the folder of the open file as the start. Enter makes the item (the daemon message `fs.create`), and a new file opens in the editor. Esc closes the field. The edge on the right of the sidebar changes its width. A double-click sets the automatic width.
- **V6n.** The language of the open file is a menu in the editor status bar, with a filter. The choice changes the colors and the editor features of that file. The file on disk does not change.
- **V6o.** The Files sidebar head shows its action buttons when they fit. A narrow sidebar (236px or less) shows one "⋯" menu with the same actions and their names. The sidebar is at least 120px wide: the Files and Search switch and "⋯" stay in view.
- **V6p.** The agent shows a task list and an end-of-turn box, as Claude Code does (daemon tools `update_plan` and `wrap_up`). The chat draws the latest plan under the messages: a check mark for a completed step, a spinner for the step in progress, and a dashed circle for a pending step. At the end of a turn it draws a box with the recap, a question, and one or two answer buttons. A button sends its message as the next prompt. The chat does not show these two tools as tool rows. An unfinished plan of an older turn stays under the messages with no spinner, until the agent sends a new plan. The plan of an interrupted turn does not show after the next prompt.
- **V6l.** The file tree grays out the files that the editor cannot open (binary files, by extension). A click does nothing. The hover hint is "Binary file". PDF and Word (.docx) files are not gray: a click opens them in the Preview pane (V6q).
- **V6q.** The Preview pane shows a PDF (pdf.js) or a Word .docx file (docx-preview) of the session folder, read only. Claude Code has no such pane (P6): it is in the ⋮ overflow menu as "Preview", next to "Background tasks", as Claude puts "Artifacts" there. A click on a .pdf or .docx file in the file tree or in the chat opens it. The agent opens it with the tool `show_document`. The window header shows the file name. A PDF has "Zoom out", "Fit to width", and "Zoom in" (also Ctrl+wheel), and both types have "Reload". The renderers are in the app bundle: the pane works offline.
- **V6i.** In the editor, Ctrl+K opens the inline edit box, as in Cursor: the instruction goes to the agent with the selected lines. Outside the editor, Ctrl+K opens the command menu. Ctrl+L adds the selection to the chat.

### 7.3 Split view

- **V7.** "Open in" > "Split view" in the row menu, or a drag of a row to the side, opens a split. Shortcuts: "New session on the right" Ctrl+Alt+\, "New session below" Ctrl+Alt+-, "Focus next split view" Ctrl+], "Focus previous split view" Ctrl+[.
- **V7a.** Harness shows one split pane at the right of the shown session (`SplitView.tsx`, `lib/split.ts`). The split pane is a full chat with its own prompt box, mode menu, model name, and context ring. Its header shows the title, the folder, and an X ("Close split view").
  - A drag of a session row over the right half of the main view shows the drop zone: a blue outline over that half with the label "Split view", as in the Claude app. A release there opens the session in the split pane. A drop of another row replaces the session of the split pane. The session of the main view cannot go into the split pane: no drop zone shows for it, and its "Split view" menu item is off.
  - "Open in" is the first item of the row menu, with a submenu: "Split view". The pointer or ArrowRight opens the submenu. ArrowLeft or Esc closes it. With no session in the main view, or in the IDE view, "Split view" opens the session in the main view.
  - The edge between the panes changes their widths. The split pane gets 25% to 75% of the width. A double-click sets equal widths. ArrowLeft and ArrowRight move the edge. The width is saved.
  - The session rail does not show while the split pane shows: the split pane gets its room, as a pane does (V6t).
  - A click on the sidebar row of the split session puts the focus in the prompt box of the split pane. If the main view opens that session (Back, search), the split pane closes.
  - The split pane has its own connection to the daemon: the daemon sends the events of one session to each connection. The X gives a running turn to the main connection first (`session.adopt`), so the turn continues and the sidebar keeps its mark. The split pane shows only in the Code view. It closes when the connection to the daemon changes.
  - Ctrl+Enter on a permission card or a plan card is for the pane that has the focus. After an answer, the focus goes to the prompt box of the same pane.
  - Harness has no split below and no split shortcuts yet.

### 7.4 Updates and notifications

- **V8.** An update shows as a strip at the bottom of the sidebar, not as a toast: "Relaunch to update · v{version}". Other states: "Update available", "Downloading update...". If sessions run, ask before the relaunch. Harness now uses a toast (`UpdateToast.tsx`) at the bottom right of the app (the user asked for this place), with the version and daemon update toasts above it. Change it to the strip later.
- **V9.** Help > "Check for Updates…" checks for an update.
- **V10.** System notifications have three types: permission request, question, task complete. Titles: "Claude needs your input to continue", "Claude is waiting for your input", "Claude finished a task". On Windows, flash the taskbar button when the app is not in focus.
- **V10t.** Harness shows the task complete notification now (the user asked for it). The title is the session title, and the text is a short summary of the turn: the first sentence of the last reply, or the reason of an early stop ("Stopped: a permission request was denied."). It shows when the user does not see the session: the window is hidden in the tray or minimized, Harness is not the active app, or the window shows another session. A turn that the user stopped gives no notification. The permission request and question notifications, and the settings of section 9.3, are still missing.
- **V10a.** When the user closes the app while the agent works on this computer, a dialog asks first, as in the Claude app: "Harness is still working", "The agent is working in {n} session(s). Quitting now will interrupt that work.", with "Quit anyway", "Wait for the agent", and "Cancel". Only a running turn counts: an idle session, a session that waits for an answer, and a background command do not. A remote daemon does not ask: its turns go on. "Wait for the agent" shows "Harness quits when the agent is done." and closes the app when the last turn ends. With "Keep running in the background" on, a close hides the window and does not ask: the agent continues. "Quit Harness" in the tray menu shows the window and asks the same question.
- **V11.** A toast is short and has one action at most, for example "Unpinned {name}" with "Undo".

## 8. Keyboard shortcuts (Windows)

Use these keys. Do not give a key to a different command.

| Command | Key | Harness now |
|---|---|---|
| New session | Ctrl+N | same |
| New session with current settings | Ctrl+Shift+N | missing |
| Command menu / search | Ctrl+K | same |
| Search sessions and projects | Ctrl+Shift+K | missing |
| Settings | Ctrl+, | same |
| Keyboard shortcuts | Ctrl+/ | missing (table in Settings) |
| Toggle sidebar | Ctrl+B | same |
| Switch the Code / IDE view (Harness only) | Ctrl+E | same (the user chose it) |
| Back / Forward | Alt+Left / Alt+Right | same |
| Previous / next session | Ctrl+Shift+Tab / Ctrl+Tab | missing |
| Terminal | Ctrl+` | same |
| Changes | Ctrl+Shift+D | same |
| Browser | Ctrl+Shift+B | same |
| Files | Ctrl+Shift+F | same |
| Side chat | Ctrl+; | same |
| Close pane | Ctrl+\ | missing |
| Close session or pane | Ctrl+W | browser tab only |
| Reopen closed session | Ctrl+Shift+T | missing |
| Add files or photos | Ctrl+U | in the prompt box: files as `@path` references (no photos yet) |
| Open model menu | Ctrl+Shift+. | missing |
| Jump to previous / next prompt | Alt+Up / Alt+Down | used for "move project" |
| Rename session | Ctrl+Alt+R | R in the row menu |
| Pin session | Ctrl+Alt+P | P in the row menu |
| Mark read / unread | Ctrl+Alt+U | U in the row menu |
| Archive session | Ctrl+Alt+A | A in the row menu |
| Fork session | Ctrl+Alt+O | missing |
| Open session PR | Ctrl+Alt+G | missing |
| Find | Ctrl+F, F3, Shift+F3 | missing |
| Stop Claude | Esc | same |
| Help | F1 | missing |

Notes:

- Harness uses Alt+Up / Alt+Down to move a project. Claude uses them to jump between prompts. Give the project move another key or a menu item only.
- The Claude Code CLI uses Shift+Tab for the next mode. Keep it.
- The "Keyboard shortcuts" dialog (Ctrl+/) lists every key in this table.

## 9. Where settings live

### 9.1 How the user opens Settings

- Ctrl+, opens Settings at the Claude Code page.
- The account menu at the bottom of the sidebar has "Settings".
- File > "Settings" in the app menu.

### 9.2 Settings layout

- **G1.** Settings is a page with a left nav in groups and a search field. Claude groups: "Account", "Customize" (Plugins, Skills, Connectors), "Products" (Claude Code), "This computer" (System, Extensions, Developer).
- **G2.** Harness groups, in this order:
  1. "Claude Code": the page with sections in G3.
  2. "Customize": "Permission rules". The skills, the MCP servers, and the plugins are not in Settings: they are on the Capabilities page (section 3.4).
  3. "Models": "Providers" (the model providers) and "Local models". These are Harness-only (P6). The user asked for the name "Providers" (it was "Connections").
  4. "This computer": "System", "Computers" (remote daemons).
  5. The changelog moves to the account menu ("View changelog").
- **G3.** The Claude Code page has sections in this order: "General", "Appearance", "Code appearance", "Sessions", "Browser", "Pull requests".

  Harness now has "Appearance" as its own page after "General". The page holds the "Appearance" rows and the "Code appearance" rows. When Settings changes to the groups in G2, move these rows into the Claude Code page.

- **G4.** Harness has a "Your Harness" page after "General" (the user asked for it, `YourHarnessSettings.tsx`). It has two sections: "Agent instructions" and "Memory". The Memory rows use the labels of the claude.ai Settings > Memory page, in this order:
  1. "Search and reference chats" (switch, default on). The agent gets the `conversation_search` tool. It searches the past sessions of the same project.
  2. "Generate memory from chats" (switch, default on). This is the auto memory switch.
  3. "Include sensitive topics in memory" (switch, default off). It is locked while "Generate memory from chats" is off.
  4. "Project" (select). Each project has its own memory, so the next three rows apply to the selected project. The default is the project of the open session, else the last project.
  5. "Your memory" with "Manage". The view lists the memories with their type, and has "Add memory". A click on a row opens its editor: "Name", "Type", "Description", "Content", "Delete…", "Cancel", "Save". "Your Harness" goes back.
  6. "Import memory from other AI providers" with "Start import". The view shows the prompt with "Copy prompt", a field for the reply, "Preview", the facts with checkboxes, and "Import {n} memories". After the import, the Manage view opens.
  7. "Export memory" with "Export". The app asks where to save the `.zip` of the Markdown files.

### 9.3 Setting map

| Option | Claude location and label | Control | Harness now |
|---|---|---|---|
| Theme | Appearance | Light / Dark / System | Appearance > Theme |
| Interface font | Appearance: "Font for the whole interface — menus, sidebars, and panels." | select | Appearance > Interface font |
| Text size and width | Appearance (transcript text size, transcript width with reset) | select | Appearance > Text size, Transcript width |
| Density | (the `data-density` attribute: compact or comfortable) | segmented | Appearance > Density |
| Code theme | Code appearance: "Light code theme", "Dark code theme" | select with a diff preview | Appearance > Code appearance (a code sample, no diff preview) |
| Code font | Code appearance, placeholder "e.g. JetBrains Mono" | text field | Appearance > Code appearance |
| Allow bypass mode | Sessions: "Allow bypass permissions mode" | switch, default off | Default permission mode list |
| Default permission mode | per session in the mode picker | menu | General > The agent |
| Notifications | Sessions: "Permission request notifications", "Question notifications", "Task complete notifications" | Off / Badge only / Banners | missing |
| Notification sound | Sessions: "Notification sound" | system / none | missing |
| Taskbar flash | Sessions: "Draw attention on notifications" | switch, default off | missing |
| Keep awake | Sessions: "Keep computer awake while Claude works", child "Keep awake on battery power" | switch, default on | ⋮ menu, per session |
| Prompt suggestions | Sessions: "Prompt suggestions" | switch, default on | General > The agent |
| Auto-archive | Sessions: "Archive inactive sessions" | Never / 1 / 2 / 7 / 14 / 30 days | missing |
| Worktree folder | Sessions: "Worktree location" | "Inside project" / "Custom…" | always inside the project (`.harness/worktrees/<name>`, branch `harness/<name>`); no setting yet |
| Output style | Sessions: "Output style" (the session menu can change it for one session) | select | missing |
| Chat links | not a Claude setting | "Open links in": "Built-in browser" (default) / "Default browser" | General > Browser (the user asked for it). The same choice as "Open links in built-in browser" in the Browser ⋯ menu. A link that the agent lists opens in the Browser pane by default. |
| Browser tools | Browser: "Browser tools" | switch, default on | Browser ⋮ menu |
| Browser cookies | Browser: "Keep cookies" | Until quit / Shared / Per session | Browser ⋮ > Cookies |
| Allowed sites | Browser: allowed origins list | list | Browser ⋮ > "Manage allowed sites…" |
| Branch prefix | Pull requests: "Branch prefix", default "claude" | text field, saves on blur | missing |
| PR auto-archive | Pull requests: "Auto-archive after PR merge or close" | switch | missing |
| Open PRs outside | Pull requests: "Open pull requests in browser" | switch | missing |
| Run at startup | This computer > System: "Run on startup" | switch | General > System: "Keep running in the background" (switch, default off: closing the window hides it in the system tray), with the child row "Run on startup" (switch, off and locked while the parent is off). The start at sign-in uses `--background`: no window, only the tray icon. |
| Storage | Settings: "Storage", "See how much space Claude uses on this computer.", "Manage" opens the "Storage" dialog | button and dialog | General > System > "Storage" (the user asked for it, `StorageDialog.tsx`). The dialog has "Disk space used" with "Checked {time}.", a bar in parts, a legend, then one row for each category with its size, a summary, and "Details": "Sessions and worktrees", "Local models", "Runtime", "Memory and settings", "App caches and logs". The footer has "Open folder" (a local daemon in the desktop app) and "Refresh". The daemon measures its computer (`disk.usage`, `disk_usage.py`). The desktop app adds the app folder, the webview data, and the Browser pane profile (`app_storage`). The dialog deletes nothing. With a remote daemon, the text says which computer has which data. |
| Update check | Help > "Check for Updates…" and the sidebar strip | menu item | General > Updates |
| Keyboard shortcuts | Help > "Keyboard Shortcuts" (Ctrl+/), a dialog | dialog | General table |
| Preferred providers | not in Claude | switch "Preferred providers" (the user asked for this name, it was "Choose the model by network"), then "Default model" and "Local model" lists | Providers page, at the top (the user asked for this). On: a new session with "Default model" uses the default model when its provider answers (a 1.5 s connection check of the daemon), else the local model, with a warning in the chat. An old session whose model is not available switches to that model when it opens (C17b). Off: the model is manual. The lists are off while the switch is off. The local list has only the models of providers on this computer. |
| Web search | not a Claude setting (Claude Code has its own search) | select "Web search": "DuckDuckGo (no key)" (default), "Brave Search", "Tavily", "SearXNG", "Off", then "API key" (Brave, Tavily: in the keychain) or "SearXNG URL" | General > Web. Off removes `web_search`. `web_fetch` stays. |
| Auto memory | Claude Code: auto memory; claude.ai Memory: "Generate memory from chats" | switch, default on | Your Harness > Memory > "Generate memory from chats" (G4). Off removes the memory tool and the memory part of the prompt. `/memory` lists the memories. |
| Chat search | claude.ai Memory: "Search and reference chats" | switch, default on | Your Harness > Memory (G4). Off removes `conversation_search`. |
| Sensitive memory | claude.ai Memory: "Include sensitive topics in memory" | switch, default off | Your Harness > Memory (G4). Off adds a rule to the memory prompt: save sensitive topics only when the user asks. |
| Manage, import, export memory | claude.ai Memory: "Your memory" (Manage), "Import memory from other AI providers" (Start import), "Export memory" (Export) | buttons | Your Harness > Memory (G4), for the selected project |
| Subagents | Claude has "Dynamic workflows" ("Let Claude run several agents at once on complex tasks. Uses your limit faster.") | switch, default on | General > The agent > "Subagents". Off removes the agent tool. Harness has no workflows: the switch is for subagents (the user asked for it). |
| Agent instructions | not in the Code tab (claude.ai has "personal preferences") | four text areas: "How to think", "How to do research", "How to speak", "Other instructions" | Your Harness > Agent instructions (the user asked for this location, G4). Only the session agent gets them, not a subagent. |
| Tool call limit, command timeout, shell | not in Claude (Claude Code `settings.json`) | — | General > The agent; keep in "Claude Code" > "General" |
| Send while working | not a setting (Enter / Ctrl+Enter) | — | General; remove |

### 9.4 Per-session options

These change the current session only. They are in the session menu (S7) or the prompt box (section 5):

- Permission mode, model, effort, fast mode.
- "Output style": a dialog with "Applies to this session only." and "Apply".
- "Transcript view": "Normal" / "Thinking" / "Verbose".
- "Keep computer awake for this session".

## 10. Settings row patterns

- **R1.** A row has the label at the left, a description under it in the secondary text color, and the control at the right.
- **R2.** A child row is indented. It shows only when its parent switch is on.
- **R3.** The description says the scope: "Applies to new sessions.", "Applies to this session only.", or "…the session menu can override it for a single session."
- **R4.** A change saves at once. If the save fails, put the old value back and show the toast "Couldn't save the setting. Try again." A text field saves when it loses focus and shows its error under the field (for example "Use 1-40 letters, numbers, or . _ -").
- **R5.** A locked row is disabled and its tooltip gives the reason ("Managed by your organization", "Available when Local sandbox is on").
- **R6.** A row that inherits a default shows "Default: {value}" and a reset button.
- **R7.** A destructive action asks first in a dialog with a question title ("Delete SSH connection?") and a danger-color confirm button.
- **R8.** Show skeleton rows while the data loads.

## 11. Visual tokens

The Claude Code tab uses the Claude Design System (CDS) tokens below. The values come from the shipped CSS.

### 11.1 Gray scale

| Token | Value | Token | Value |
|---|---|---|---|
| `gray-0` | `#ffffff` | `gray-450` | `#7b7974` |
| `gray-10` | `#fcfcfb` | `gray-500` | `#6d6b67` |
| `gray-20` | `#f9f9f7` | `gray-600` | `#52514e` |
| `gray-50` | `#f0efec` | `gray-700` | `#383835` |
| `gray-100` | `#e1e0d9` | `gray-800` | `#20201f` |
| `gray-200` | `#c3c2b7` | `gray-830` | `#1a1a19` |
| `gray-300` | `#a5a49a` | `gray-850` | `#151515` |
| `gray-400` | `#898781` | `gray-900` | `#0b0b0b` |

### 11.2 Roles

| Role | Light | Dark |
|---|---|---|
| Page (`surface-0`) | `gray-20` | `gray-900` |
| Sidebar, page body (`surface-1`) | `gray-10` | `gray-850` |
| Panel (`surface-2`) | `gray-0` | `gray-830` |
| Popover (`surface-3`) | `gray-0` | `gray-800` |
| Primary text | `gray-900` | `gray-50` |
| Secondary text | `gray-600` | `gray-200` |
| Muted text | `gray-400` | `gray-400` |
| Border | text color at 10% alpha | text color at 10% alpha |
| Strong border | text color at 20% alpha | text color at 20% alpha |
| Hover fill | text color at 5% alpha | text color at 7.5% alpha |
| Selected fill | text color at 10% alpha | text color at 15% alpha |
| Accent (focus, links, unread) | blue `#2a78d6` | blue `#2a78d6`, text `#6da7ec` |
| Danger | `#d03b3b` | text `#ec7e7e` |
| Success | `#009300` | text `#0ca30c` |
| Warning | `#fab219` | text `#db9300` |
| Brand only (logo, brand buttons) | clay `#c6613f`, hover `#d97757` | same |
| Backdrop | `#00000066` | `#00000080` |

Rules:

- **T1.** Use the accent blue for focus rings, links, selection and the unread dot. Use clay only for the brand.
- **T2.** Make borders and hover fills from the text color with alpha. Do not use fixed gray borders.
- **T3.** Harness dark colors (`#262624`, `#1f1e1d`, `#30302e`) are the older warm claude.ai palette. The move to the CDS palette is a large visual change. Decide it in its own change, and change all the tokens in `styles.css` together.

### 11.3 Type

- **T4.** Fonts: a sans font for the UI (Claude uses Anthropic Sans), a serif only for the brand voice, and a mono font for code. The user can change the interface font and the code font.
- **T5.** Sizes (compact / comfortable density):

  | Token | Compact | Comfortable |
  |---|---|---|
  | caption | 11px | 12px |
  | footnote, code | 12px | 13px |
  | body (UI) | 13px | 14px |
  | prose (transcript) | 14px | 16px |
  | heading | 14px | 15px |
  | title | 20px | 22px |
  | page header | 24px | — |

- **T6.** Weights: regular 400, medium 500, semibold 580, bold 600. In dark mode, the variable font is a little lighter (360 / 460 / 540 / 560).

### 11.4 Size, space, radius

| Token | Compact | Comfortable |
|---|---|---|
| Control height | 24px | 32px |
| Icon | 16px | 20px |
| Radius (controls) | 6px | 8px |
| Radius (prompt box) | 12px | 14px |
| Radius (panel) | 10px | 12px |
| Padding xs / sm / md / lg / xl | 4 / 6 / 8 / 12 / 20px | 6 / 8 / 12 / 16 / 24px |
| Gap xs / sm / md / lg / xl | 6 / 8 / 12 / 20 / 32px | 8 / 12 / 16 / 28 / 40px |

- **T7.** Use these steps. Do not use other padding values.
- **T8.** The app default density is comfortable.

### 11.5 Depth and motion

- **T9.** Shadows: small `0 1px 2px` plus `0 2px 8px`; popover `0 8px 24px #0000001f, 0 2px 6px #00000014` (dark: `#00000052`, `#0003`). A panel has a 1px border ring plus the small shadow.
- **T10.** Focus: a 1px accent ring with a soft 6px accent glow.
- **T11.** Durations: fast 60ms, snap 120ms, base 200ms, sheet 300ms, slow 450ms. Ease out: `cubic-bezier(.165, .84, .44, 1)`. Honor `prefers-reduced-motion`.
- **T12.** Layers: modal 40, popover and tooltip 50, toast 60.

## 12. Wording

- **L1.** Use sentence case for all labels ("New session", not "New Session"). The app menu is the only exception: it uses title case ("New Session", "Check for Updates…").
- **L2.** Put "…" at the end of a menu item that opens a dialog or asks for more input ("Change folder…", "Revise…").
- **L3.** Use a question for a confirm title ("Archive session with uncommitted changes?"). Use a verb for the confirm button ("Archive anyway"), not "OK".
- **L4.** Error text says what failed and what to do: "Couldn't save the setting. Try again."
- **L5.** Use the Claude names: "session" (not "chat"), "Changes" (not "Diff"), "Side chat", "Background tasks", "Fork", "Rewind", "Archive".

## 13. Changes to make in Harness

Do these in separate changes, in this order:

1. Rename the permission modes and add their descriptions (C11, C13).
2. Change the permission card to the desktop form (M7–M10).
3. Add the "+" menu to the prompt box, with Ctrl+U (section 5.2).
4. Add effort to the model menu, and Ctrl+Shift+. (C15, C17).
5. Remove "Send while the agent works". Use Enter and Ctrl+Enter (C7).
6. Rename the "Diff" pane "Changes", and move Files to the pane buttons (V4).
7. Move the session row keys to the Ctrl+Alt chords (S7).
8. Move the update toast to a sidebar strip (V8).
9. Reorganize the sidebar: search field, account menu (section 3.1). The "Capabilities" nav item is done (section 3.4).
10. Reorganize Settings into the groups in G2 and the map in 9.3.
11. Add the notification settings (V10, 9.3).
12. Add the Keyboard shortcuts dialog (Ctrl+/).
13. Decide the CDS palette (T3).

## Unknowns

These details were not in the cached bundles. Check them in the live app before you copy them:

- The layout of the slash command menu rows.
- The labels of the task list under the latest message and of the end-of-turn box.
- The exact labels of some row-menu items (the chunk was not in the cache).
- The labels of these settings rows: interface font, transcript size and width, code font, new task prompt.
- The location of sharing settings and authorization tokens in the newest build.
- The icons of the Plan, Background tasks and Artifacts panes.
- Where toasts show on the screen.
