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
- **P7. Harness does not name Claude in its own UI text.** Where a Claude label says "Claude", Harness says "the agent" (for example "Allow the agent to **run** `npm test`?"). This rule is stronger than P1. Keep real product and model names: a model id such as `claude-sonnet-5-5`, the Anthropic provider, the `CLAUDE.md` file, the `.claude` folder, and Claude Code settings that Harness imports.

## 2. Window and title bar

- **W1.** The window has no system title bar. The app draws its own title row. The Windows caption buttons (minimize, maximize, close) are at the far right.
- **W2.** The left end of the title row holds the sidebar toggle (Ctrl+B) and Back / Forward (Alt+Left, Alt+Right).
- **W3.** Alt alone or F10 opens the app menu at the top left. The app menu has these menus, in this order: File, Edit, View, Go, Help. See section 8 for the items.
- **W4.** Claude has a "Chat / Cowork / Code" switch in the title row. Harness has only Code, so Harness does not show this switch.
- **W5.** A line under the title row separates it from the chat and the panes. The new session screen has no line (the user asked for this).

## 3. Sidebar

### 3.1 Order, top to bottom

1. A "Search" field. It opens the command menu (Ctrl+K). The key hint shows on hover or focus.
2. "New session" (Ctrl+N), with a round "+" icon.
3. Nav items: "Routines", then "Capabilities". Claude shows "Routines" and "Customize". Harness shows "Capabilities" in place of "Customize" (the user asked for this name). "Routines" opens the Routines page (section 3.5). It opens the Capabilities page with the skills, the MCP servers, and the plugins (section 3.4). Permission rules are not on this page yet. See section 9.
4. "Pinned". Show the first 20 items, then "Show more". The empty text is "Tip: you can drag sessions here to pin them".
5. The session sections (projects, date groups, or custom sections).
6. A bottom tray: the update strip (section 7.4), then the account button. The account button opens a menu with "Settings", "View changelog", "Keyboard shortcuts", "Get help".

Harness now has a "More" accordion for Permission rules, and a Settings gear in the footer. Move these to the Capabilities page and the account menu.

- **S18.** The footer of the sidebar is one row, 28px high (the user asked for a compact footer): the status dot (6px), the icon of the computer, the name of the connection, then "· {computer}" in muted text, and the Settings button (28px) at the right. A green dot shows "Connected", so the row does not show that word. A state that is not "Connected" shows as text in place of the computer: "· Connecting" or "· Disconnected". With no connection, the row shows only "No connection". The hover tip has the full state.

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

  Harness now uses the single keys P, U, R, A, D in this menu. Change them to the Ctrl+Alt chords above. Harness has "Open in" > "Split view" (V7a), and "Open PR" for a session with a pull request (S17), but not "New window" yet.
- **S8.** Archive asks first only when the session has uncommitted changes: "Archive session with uncommitted changes?" with "Archive anyway". Delete always asks first, in a dialog as in the Claude app (the user asked for this, `DeleteSessionConfirm.tsx`): the title "Delete session?", the text "“{title}” will be removed from this computer.", "Cancel", and "Delete" with a danger-color outline. The text has no line about a copy on a server: Harness keeps none. For a worktree session, the text adds "The worktree folder is removed. The branch {branch} stays." The focus starts on the "Delete" button of that question, so Enter deletes the session (the user asked for this).
- **S17.** A worktree session row shows the pull request of its branch, as in the Claude app (the user asked for this): the PR icon in the color of its state, at the right of the title, before the status mark. On hover, a small card shows the title, "{state} · {owner}/{name} #{n}", and "+{additions} −{deletions}" (`PrMiniCard`). The row tip does not show while the pointer is on the icon (`data-hover-card`). The row menu then has "Open PR" (G) at the top. With "Show PR status" on, the sidebar asks for the pull requests of the worktree sessions (40 at most) with the project folders. The open session gets its pull request from the Changes section at any time.
- **S13.** The project menu has "Remove from sidebar" under "Archive all" (the user asked for this). It is available only for a saved project with no sessions in the list. The folder, its files, and its sessions stay.
- **S9.** A drag of a row shows a label pill: "Open in split view", "Release to unpin", "Move to {label}". Harness shows "Open in split view" now (V7a). The browser fixes the drag image at the start of the drag, so the pill text does not change during the drag.
- **S12.** The edge at the right of the sidebar changes its width, from 216px to 384px (the widest sidebar of the Claude app, the user asked for it). The default is 264px. A double-click sets the default.
- **S11.** A folded project still shows the open session and its sessions that are running, awaiting input, or unread, under the project name (the user asked for this). The other sessions show when the project opens.
- **S14.** Nested sessions, as the linked sessions of the Claude app. A fork, and a session that the agent starts with the `start_session` tool, show under the session that started them (`parent_id`). A pinned session stays in the Pinned list. A session with a parent that is not in the list shows at the top level. The parent row is closed until the user opens it (the user asked for this): the nested sessions do not show. The number of nested sessions shows at the far right of the parent row, with an arrow to its right (the user asked for this place). The arrow opens and closes the list. The ⋮ button and the status mark move to the left of the number. A closed row opens when the open session is one of its nested sessions. When a hidden nested session (at any depth) works, awaits input, or has an unread response, a muted line with an elbow shows under the closed row, as in the Claude app (the user asked for this): "{n} nested session(s) · {n} working · {n} awaiting input · {n} unread", with only the parts that are not zero. A click on the line opens the row. The open state of each row is saved. A nested session of a nested session cannot start more sessions.
- **S15.** The agent knows the other sessions of the project (the user asked for this). At the start of a turn, when the list changed, it gets a harness note with the 12 newest other sessions (not archived): the first 8 characters of the id, the title, and "a nested session of this session" or "the parent of this session". The tool `session_read` gives the title, the first prompt, and the last 8 messages of one of them.
- **S16.** "When you ask for an unrelated task", as in the Claude app (Settings > General, user setting `new_task_prompt`): "Ask me" (default), "Always do it here", "Always start a new session". Help text: "A task that is not part of the work of a session can run in its own linked session, or in another session that fits it better. Choose whether Harness asks each time, keeps it in the session you typed it in, or opens a linked session for it." The agent calls `offer_session` before it starts such a task. With "Ask me", a question card asks "Start this in its own session?" with "New session" and "Do it here" (the Claude labels). When an existing session fits better (the user asked for this), the card asks "Send this to the session "{title}"?" with "Send to that session", "New session", and "Do it here". "Send to that session" sends the prompt to that session and starts its turn: in its window when it is open, else with no window (it shows as working in the sidebar). A session with a running turn cannot get the prompt.
- **S10.** When the sidebar is hidden, the pointer on the sidebar toggle in the title row shows the sidebar over the view (the user asked for this). It goes away a short time after the pointer leaves it, on Esc, or after a choice in it. A menu or a dialog of the sidebar keeps it. The sidebar toggle in it shows the sidebar again in its usual place. After a click on "Hide sidebar", the sidebar does not show over the view while the pointer stays on the toggle. It shows after the pointer leaves the toggle and comes back (the user asked for this: the pointer is still on the toggle after the click, so the sidebar came back at once). Ctrl+B does not change this.

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
- **K8.** Each connector shows the logo of its service, in the text color (`ConnectorLogo.tsx`): on its Connectors row and on the MCP server row of its server. The user asked for this rule for all connectors. A new connector gets its official logo, with its source and license in `THIRD_PARTY_LICENSES.md`. A connector with no logo shows the plug icon. Exception that the user chose: Microsoft does not permit its product icons without a license, so Microsoft Outlook shows the lucide "Mail" icon with its full name. Outlook (classic) shows the same "Mail" icon. The Email connector serves many mail services, so it shows "Inbox". The Connectors tab has one row for each connector (GitHub, Microsoft Outlook, Outlook (classic), and Email (IMAP)), with "{n} of {m} connected". The row shows the account and the token source ("@login · GitHub CLI") and the pill "Connected" or "Not connected". All rows are collapsed at the start (the user asked for this). A device code opens its row. It has "Use GitHub CLI" (when `gh` is signed in on the daemon computer), a token field with "Connect", and "Create a token". A connected row has "Disconnect". An error shows in the row. The Outlook row has "Personal account" / "Work or school account", a "Read-only" box, and "Sign in with Microsoft". During the sign-in, it shows the device code in large letters, "Copy code", "Open sign-in page", and "Cancel". With accounts, the row lists each account with its type and "Remove", then "Add account" and "Disconnect" ("Disconnect all" for two or more accounts). The summary line is "{login} · {type}", or "{n} accounts · {logins}". The Email row asks for the address, the mail service (chosen from the address), the help of the service and "Make an app password", the server fields for "Other IMAP server" (host, port, security), "App password", "Read-only", and "Connect". Its accounts show as the Outlook accounts, with the name of the mail service. The Outlook (classic) row has three choices, one on each line ("Read-only", "Drafts" (the default), and "Send"), and "Connect". "Drafts" and "Send" also let the agent organize the default mailbox (the user asked for it): make, rename, and move folders (also into a subfolder), move messages to a folder, and mark messages as read or unread. The tools do not delete, and a default folder (Inbox, Drafts, Sent Items, …) cannot move or get a new name. On a computer that is not Windows, it shows only a help line. Its summary line is "{accounts} · {mode}" ("read-only", "drafts", or "can send"). A connected row shows the mode and "Disconnect". The tab needs no session. An MCP server row of a connector with no token has "Connect", which opens this tab.
- **K7.** With no session, the page shows the skills and the configured servers of the project that the new session page selected, with no connection. The restart buttons and "Edit mcp.json" do not show. A note says: "Open a session in this folder to connect the servers, restart them, or edit mcp.json."

### 3.5 Routines page

- **RT1.** The "Routines" nav item is the first nav item, over "Capabilities". It shows at all times, also with no session. A red dot shows when the last run of a routine failed. The page is a full screen in the main area. Back and Forward include it.
- **RT2.** A routine is a prompt that the daemon runs on a schedule, each time in a new session. Each routine is a Markdown file in the `routines` folder of the app data (`~/.harness/routines/<id>.md`, `routine_files.py`): the frontmatter has `name`, `schedule`, `cwd`, `model`, `permission_mode`, and `enabled`, and the body is the prompt (the user asked for one folder named routines). The user can edit, copy, or add a file by hand. The run history stays in the database. The daemon runs the routines also when no window is open (`routines.py`). A routine runs only while the daemon runs: see "Run on startup" (section 9.3).
- **RT3.** The page has the title "Routines", one context line with the path of the routines folder, then the list with a count and "New routine". Each row shows the calendar-clock icon, the name, "{schedule in words} · Next: {time} · {folder}" (or the problem of the file), the pill "Active" or "Inactive" (the user asked for these labels), a second pill for the run state when there is one, a "Run now" icon button (the play icon, tip "Run now"), and a switch that turns the schedule on or off. The user asked for "Run now" on the row, so a run does not need the detail view. The button is off while the routine runs or waits to run, and for a file with a problem. The empty text is "No routines yet. A routine runs a prompt on a schedule, for example a summary of the changes each morning."
- **RT4.** Pills: "Active" (the routine runs on its schedule) or "Inactive" (it is off, or its file has a problem). Run state pills: "File error", "Waiting" (other routines run: at most 3 run at the same time), "Running", "Needs approval" (a permission request waits), "Last run failed". A file error or a failed last run puts a red dot on the nav item.
- **RT5.** A click on a row (or "New routine") opens the detail view with the back link "Routines" (C12a). The view has "Run now", "Duplicate" (the user asked for it), "Delete…" (it asks "Delete this routine?"; the file goes to the Recycle Bin, and the sessions of the runs stay), "Next run: {time}", the path of the file, and the problem of the file if it has one. The form has "Name", "Prompt", "Folder" (the projects and "Choose…"), the model and mode chips of the new session page, "Schedule" ("Hourly", "Daily", "Weekdays", "Weekly", "Custom (cron)", with the time and the day), and "Run on the schedule". The buttons are "Cancel" and "Create routine" (a new routine) or "Save".
- **RT5b.** The "Prompt" box grows with its text (the user asked for this): it shows all the lines of the prompt, with no scroll bar of its own, and the page scrolls. An empty box has 5 lines.
- **RT5a.** "Duplicate" makes a new routine from the values that the form shows, and does not change the open routine. The name of the copy is "{name} (copy)", or "{name} (copy 2)" when a routine has that name. The copy starts with "Run on the schedule" off, so the same schedule does not run two times. It has no API token and no runs. The view of the copy opens at once, and the "Name" field has the focus with its text selected: the user sees the new name and can type another name.
- **RT6.** The view lists the last 20 runs: the time, a status pill ("Running", "Needs approval", "Done", "Failed", "Skipped"), the error, and "Open session".
- **RT7.** A run gets a new session with the name of the routine as its title. Its sidebar row shows the calendar-clock icon. When the run ends or waits for an answer, the row gets the unread dot, and Windows shows a notification ("{name} finished", "{name} failed", "{name} needs your approval") if the window does not show that session.
- **RT8.** The mode of the routine applies to its sessions only. The project settings do not change. No one can answer a permission request while no window shows the session: in "Manual" mode, the run waits until the user opens the session and answers.
- **RT9.** If the daemon did not run at one or more due times (the computer was off or asleep), the routine runs one time at the next start, not one time for each missed time. A due time while the routine still runs is a "Skipped" run.
- **RT10.** The agent can save a routine with the tool `routine_create` (the user asked for this), and list the routines with `routine_list`. A tool is better than a skill here: the model sees a tool in its tool list and calls it directly. `routine_create` asks for approval, and the request shows the name, the schedule, the mode, the folder, the model, and the prompt. The routine works in the project folder and with the model of the session. Its mode is the mode of the session (Manual for a session in Plan mode), and it cannot be less limited. The new routine shows on the Routines page of each window at once. `cron_create` stays for reminders inside the open session, and its description points to `routine_create`.
- **RT11.** The API trigger, as in the Claude app (the user asked for this). The detail view of a saved routine has the section "API access", with "Active" or "Inactive" at the right: "Trigger from your own code by sending a POST request.", "Fire URL" (read-only, "Copy"), the token ("Generate token"; when active: "Regenerate" and "Delete token", with "Regenerating makes the previous token stop working. Delete the token to turn off API access."), and "Example request" (a curl command, "Copy curl"). A new token shows one time in a box: "Token generated", the token, "Copy token", "Copy this token now. It is not shown again. Use it as the Bearer credential.", and "Done". A new routine shows "Save the routine to add an API trigger". The daemon endpoint is `POST /routines/{id}/fire` with `Authorization: Bearer <token>` and an optional JSON body `{"text": "..."}` (20000 characters or less): the run gets the prompt, then the text. The daemon keeps only the SHA-256 of the token (`routine_state`), and gives 401 for an unknown routine or a bad token, and 409 while the routine runs. The call works also when "Run on the schedule" is off. The desktop app starts the daemon with `--prefer-port 47615`, so the fire URL stays the same after a restart when that port is free.

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

- **C1.** The prompt box is one card with a large radius. Claude uses `--cds-radius-composer` (14px in comfortable density). Harness uses `--prompt-radius` (2px, the one corner radius of the app, see section 11.4). The text area grows to `min(24rem, 40svh)`.
- **C2.** The action row inside the card, left to right: the "+" button, the text area, then Send / Stop at the right.
- **C3.** The "chin" bar under the card, left to right: the permission mode picker; then, at the right, the model picker (with effort), then the context ring.
- **C3a.** The chips under the prompt box (mode, project, model) are text with no border and no arrow. On hover and while the menu is open, the full chip gets the hover background (the user asked for this). The model chip has no icon: it shows the model name, a bar, then the effort level, for example "qwen3 | High" (the user asked for the bar). It has the same text color as the other chips under the prompt box (the user asked for this). Its class is `model-button`: the `model-chip` class of the Providers page has other colors.
- **C3b.** The chin bar is 6px above the bottom edge of the window (the user asked for the prompt box nearer to the edge). Its chips are on the same line as the footer row of the sidebar (S18): the center of each is 18px above the edge (the user asked for this). A change to the height or the padding of one needs the same change to the other.
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
  - Stop replaces Send. Its tooltip is "Stop" with the key Esc. Harness shows Stop during the whole turn: when the box has text, Send shows to the right of Stop, so the user can stop the agent and queue a message (the user asked for this). While a card waits, the Stop tooltip has no key, because Esc answers the card (M10a).
  - Enter sends the message now. Ctrl+Enter queues it ("Queue for later"). The Send tooltip lists both keys.
  - A queued message shows "Queued. Claude will read this after the current turn." with "Send queued message" and "Remove queued message".
  - Harness shows a queued message as a muted bubble with a dashed edge, and not as a sent message (audit U11). Under it, always (not only on hover): "Queued" with a clock icon (tip "Queued. The agent reads this message after the current turn."), "Remove", and "Send now". A steered message shows "Steering" and "Send now".
  - A sent message that waits (queued or steering) shows above the task list, and the working line is under the task list, as in the Claude app (the user asked for this).
  - Each hover tip shows at most 6 lines and 300 characters (`Tooltips.tsx` `limitTip`). The tip of a tool row and of a pasted-text chip has only the first line, 160 characters or less (`shortTip`): a tip never shows the full content of a file, for example a .py file, or of a long command (the user asked for this).

  Harness now has a setting "Send while the agent works" (Queue / Interrupt / Steer). Claude has no setting for this. Remove the setting and use the two keys.
- **C8.** The box has a bash mode: "Bash mode. Press Escape to return to chat." The placeholder is "Enter a shell command". (The key that starts bash mode is not in the bundles. The Claude Code CLI uses "!".)
- **C9.** The box has a history search: "Search history:" with "↑↓ cycle · esc cancel". (The key that starts it is not in the bundles.)
- **C10.** A prompt suggestion shows as grey text in the box after Claude replies.
- **C10a.** The box has a row of attachments above the text. A pasted or dropped image shows as a 56px thumbnail (the long side of a large image becomes 1568px). A browser annotation shows as a small code chip with the element and the note. The x of an attachment shows on hover at its top right. Backspace at the start of the box removes the last attachment. The chat shows the images and the annotation chips of a message above its text, in the same chip style as the box (the user asked for this). A queued message shows them too. Harness only: when the model cannot read images, a muted line with a warning icon under the thumbnails says "{model} cannot read images. The agent gets a note in place of each image." Both prompt boxes show it. Claude models always read images, so Claude has no such line (the user asked that an image never drops with no notice).

### 5.4 Permission mode picker

- **C11.** The menu header is "Mode". Modes, in this order, with these descriptions:

  | Label | Description |
  |---|---|
  | "Manual" | "Always ask before making changes" |
  | "Accept edits" | "Automatically accept all file edits" |
  | "Plan" | "Create a plan before making changes" |
  | "Auto" | "Claude handles permission decisions" (Harness: "The model handles permission decisions", the user asked for this) |
  | "Bypass permissions" | "Accepts all permissions" (warning color) |

- **C12.** "Bypass permissions" shows only after the user turns on "Allow bypass permissions mode" in Settings.
- **C13.** Harness names "Ask permissions", "Plan mode" and "Auto mode" change to "Manual", "Plan" and "Auto". Keep Shift+Tab to go to the next mode (the Claude Code CLI uses it).

### 5.5 Model picker

- **C14.** The menu header is "Model · this session" (on the start screen: "Model"). Each model has a one-line description (Harness has no model descriptions yet). Harness (`ModelMenu.tsx`, the user asked for this layout): the top list has the models of the online providers that are on, with the keys 1 to 9 at the right and a check mark on the current model. A provider heading shows only when two or more online providers give models. Then "Effort" and "Local models" rows, each with the current value and an arrow that opens a submenu next to the menu (on the left for a menu at the right edge). "Local models" lists the models of the providers on the computer of the daemon (Ollama, llama.cpp: `isLocalProvider`). The last row is "Show providers" (the user asked for this name): it opens the Providers page (P6).
- **C15.** Effort is a control in the same menu: "Low", "Medium", "High", "Extra high", "Max". Help text: "Higher effort means more thorough responses, but takes longer and uses your limits faster." The default level is "High", as in the Claude app (the user asked for this). The level is the user setting `effort`: the daemon saves it in its settings file, so the app keeps the choice of the user after a restart. The daemon sends it as `reasoning_effort` ("Max" sends "xhigh": the API has no higher level). When the endpoint rejects it, the daemon sends the request again with no effort, and the session does not send it again.
- **C14a.** The start screen chip shows the model that the user chose last: on the start screen, in a session menu, in "Switch", or with "Use" (Local models). Each project keeps its own choice. A saved model of a provider that is gone or off, or that its provider does not list, shows as "Default model". While the model list loads, the saved model stays.
- **C16.** A change in the middle of a session asks first: "Switch model?" or "Change effort?", with "Don't ask again".
- **C17.** Ctrl+Shift+. opens the model menu.
- **C17a.** A model switch shows only in the model label under the prompt box. The chat shows no message for it (the user asked for this). A warning about the new model (for example, no API key) still shows in the chat. A typed `/model <provider>/<model>` still shows as a user message, as each typed command does.
- **C17b.** When no provider gives the model of a session, the end of the chat shows a prompt (`ModelUnavailable.tsx`, in the end-of-turn box style): "The model {provider/model} is not available", the reason, and "Switch this session to an available model?". It has a model menu (the start screen model, else the first model of the list), "Switch", and "Not now" (the user asked for this). The daemon tells when the provider is gone or off (`model_unavailable`). The client also asks when the provider lists models but not this one. A provider that does not answer is not a reason to ask. With "Preferred providers" on, the session switches to that model and does not ask.

### 5.6 Context ring

- **C18.** The ring tooltip is "Context {summary}". A click opens a panel with the usage parts and two actions: "Compact this session" and "New session".
- **C18a.** The usage parts are in the order of Claude Code /context (the user asked for this): System prompt, Built-in tools, MCP tools, Project instructions, Skills, Plugins, Summary of earlier turns, Messages, Tool results, then Free space and Compaction buffer. Messages are blue (the user asked for this). Built-in tools are vermilion.
- **C18b.** A token count has one decimal place when it is not a whole number, as in Claude (the user asked for this): "512", "1.2k", "130.8k", "200k", "1M", "1.5M".
- **C18c.** The ring shows only while the session rail is hidden (the user asked for this). The open rail has the Context section, so the ring does not show. The split pane has no rail, so it always shows its ring.

## 6. Transcript

### 6.1 Messages

- **M1.** The user message is a bubble with a light tint. On hover it shows a toolbar, in this order: "Copy message", "Rewind to here", "Fork from here", then the time. The bubble has the corner radius of the prompt box (`--prompt-radius`, 2px; the user asked for this). The bubble is tight on its words (the user asked for this): 7px of space above and below the text, 10px at the left and the right, and a line height of 1.5. The images of a message have the same radius.
- **M1b.** In place of the check icon of the Claude app ("Read by Claude"), the toolbar of a user message shows the text "Read" or "Sent", then "|", then the time (the user asked for this). "Sent": the turn runs and nothing came after the message yet (no reply, no tool call, no card). "Read": all other messages. The tip of "Read" is "Read by the agent".
- **M1a.** The round button that scrolls to the bottom shows three moving dots while the agent works. On hover it shows a down arrow, the jump to the agent, and the button gets a highlight: a lighter fill and a brighter ring (the user asked for both). The button shows only when the end of the chat is out of view: while the agent works, the working line; else the bottom of the chat (the user asked for this). A scroll up stops the follow, but the button stays hidden while the working line is in view.
- **M1c.** A click that opens a dropdown in the chat (a tool row, a tool group, the working line, the task list, a visual, or a menu such as the ⋯ of a card) scrolls the chat down so the opened part is in view, with 12px of room (the user asked for this). The chat scrolls only as far as needed, never up, and the clicked row stays in view (`revealScroll` in `MessageList.tsx`).
- **M2.** Right-click on a message gives "Copy message", "Copy message as Markdown", "Rewind to here", "Fork from here".
- **M2a.** Copy commands of a reply (audit U10). A finished reply has a row under its last text with "Copy message" (it shows on hover and on keyboard focus, as the row of a user message). It copies the Markdown of all the text of the reply: the text of the agent between two messages of the user. Each code block of a reply has "Copy code" at its top right, on hover and on keyboard focus. Harness has no right-click menu on a message yet (M2).
- **M3.** "Rewind to here" does not ask a question. A rewind always restores the code and the conversation (the user asked for this). After a rewind, show "Undo rewind".
  - Harness shows one info line after a rewind, for example "Rewound the code. 1 file restored. Changes of commands are not restored." The line has the button "Undo rewind" (daemon message `rewind.done`).
  - "Undo rewind" brings back the removed messages and the files as they were before the rewind (`session.rewind_undo`). The line "The rewind is undone." follows. When the prompt box still has the text that the rewind put there, the box becomes empty.
  - There is one undo, for the last rewind. The button shows only on the last rewind line, while no turn runs, and until the next message of the user. A new turn, /clear, or a summary of the context ends the undo.
- **M3a.** Esc two times (in 500 ms) opens the "Rewind" dialog, as in Claude (the user asked for this): "Restore the code and the conversation to the time before a message. Changes of commands are not restored." and the messages of the user, the oldest first, with the newest selected. Up and Down select, and Enter or a click rewinds to the message (the code and the conversation, as in M3). Esc closes the dialog. Not during a turn (then Esc stops the agent), and not from a text field other than the prompt box, the terminal, the editor, or the split pane (`RewindDialog.tsx`).
- **M4.** "Fork from here" tooltip: "Starts a new session from this point. This one stays as it is."
- **M4a.** A Markdown table in the chat looks as in the Claude app (the user asked for this): the full width of the message, a line below each row, no vertical lines, a header in bold at the left, 12px of space above and below the text, and the text at the top of each cell. A cell keeps each word whole. A table that is wider than the chat scrolls in its own box (`.md-table`).
- **M4b.** The chat shows equations with KaTeX (the user asked for this): `$...$` and `\(...\)` in a line, and `$$...$$` and `\[...\]` as a display equation. A `$` that does not start an equation stays text, for example "$5 and $10" (`lib/math.ts`). Code spans and code blocks do not change. An equation with an error shows its LaTeX source in muted text.

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
- **M6a.** A visual of the agent is its own item in the chat, not a tool row, as the `show_widget` visuals of the Claude app. The agent makes it with the tool `show_visual` (an HTML fragment or an `<svg>`). The header line is "Made a visual" with a caret that folds the visual. The visual is open at first. It shows in a sandboxed iframe (`allow-scripts` only, no same-origin) that gets the height of its content. The frame page comes from the daemon (`/visual-frame`) with its own CSP: inline scripts and three CDNs (cdnjs.cloudflare.com, cdn.jsdelivr.net, unpkg.com) can run, and the network is closed. The app gives the theme colors and fonts as CSS variables (`--color-text`, `--color-accent`, and the others in `lib/visual.ts`), and a theme change goes to the visual at once. `sendPrompt(text)` in a click sends the text as the next prompt, as a button of the end-of-turn box. A failed call is a tool row. For a daemon on another computer (not loopback), the frame uses `srcdoc`: the app CSP then blocks its scripts in the installed app. As `show_widget` of the Claude app, the tool takes optional `loading_messages` (1 to 4 short lines): they show one after the other, with the gyroscope, until the visual has its size. A download button shows at the right of the header line on hover or focus (tip "Download"): it saves an `<svg>` as `{title}.svg` and other code as `{title}.html` (the user asked for all the functions of the Claude content cards).
- **M6b.** When a tool call makes a new file that the Preview pane can show (a PDF or a Word .docx file), a file card shows in the chat right after the tool call, as the file cards of the Claude app (the user asked for this). The card shows a file icon (red for PDF, blue for Word), the file name, the type ("PDF document" or "Word document"), and the folder. "Open" (and a click on the card) opens the file in the Preview pane (V6q). The daemon finds the new files (`created.py`): a tool with a `path` (for example `write` and `office_edit`) makes a new file when the file did not exist before the call. For `bash`, it compares a quick scan of the project before and after the command. The scan skips hidden folders and `node_modules`, and stops for a very large project. A command that runs in the background gets no card. A tool call shows at most 10 cards. The cards stay in the session history: they show again when the user opens the session.
- **M6c.** The agent sends files to the user with the tool `send_file`, as `SendUserFile` of the Claude app (the user asked for this): 1 to 10 files of the project, an optional one-line caption, `display` ("render" or "attach"), and `status` ("normal" or "proactive"). The chat shows the caption in muted text, then one file card for each file (`ShareCards.tsx`): an icon and a color by the file type, the name, "{type} · {size} · {folder}", a "Show in folder" button (a daemon on this computer only), and "Open". "render" opens the first file at once in a pane: the Preview pane (PDF, Word), the Browser pane (HTML, images), or the editor (text and code). "attach" and a file that no pane shows (for example a spreadsheet) open in the default app of the computer. The app opens the file with its own command (`open_file_in_app`): an absolute path of a file that exists, and never a program or a script (for example .exe, .bat, .ps1, .js, .lnk). A file that does not open shows an error popup. "proactive" shows a Windows notification "The agent sent a file" when the user does not see the session. The daemon puts the data of the card on the tool result (`card`), so the card shows again after a reload. The tool row shows only for a failed call.
- **M6d.** The agent publishes an HTML page as an artifact with the tool `artifact`, as the Artifact tool of the Claude app (the user asked for this). Harness has no claude.ai, so the artifacts are local: the daemon keeps a copy of the page in `~/.harness/artifacts/<id>/` and serves it at `/artifacts/<id>/` with a sandbox CSP (no same origin). The random id is the secret of the link. A new publish of the same file, or with the `id`, makes a new version of the same artifact. Actions: "publish" (the default), "list", "read", and "delete". Delete asks first: "Allow the agent to **delete** the artifact {title}?". The chat shows an artifact card: the title, the description (2 lines at most), "Artifact · Version {n} · {time}", "Open in your browser" (a daemon on this computer only), and "Open", which opens the page in the Browser pane.
- **M6e.** When the agent opens a page (`preview_navigate`), the chat shows only the tool row. It shows no browser card (the user asked for this: the card was removed). The page shows in the Browser pane and in the Browser section of the session rail. A browser card in an older session shows nothing.

### 6.3 Permission card

- **M7.** Title: "Allow the agent to **{action}** {object}?" (for example "Allow the agent to **run** `npm test`?").
- **M8.** Buttons, left to right:
  1. "Deny" (Esc)
  2. "Always allow" or "Allow for this session" (Ctrl+Shift+Enter). Tooltip: "Don't ask again for this tool".
  3. "Allow once" (Ctrl+Enter). This is the primary button.
- **M9.** A note says where an "Always allow" rule goes: "Applies to this session only", "Saves to project settings", or "Saves to user settings (all projects)".
- **M10.** The card shows above the prompt box. Number keys also pick the buttons.
- **M10b.** A request shows in one place (audit R1, R3; `foldCards` in `MessageList.tsx`). While a permission card waits, the row of its tool call does not show: the card says what the call does. After the answer, the card goes, and the row of the call shows the answer as a mark at its right: "Allowed once", "Always allowed", or "Denied" (in the danger color). A card that expired stays, with its row. A question card and a plan card hide the row of their call ("Asked 2 questions"). The mark is not in the session history: after a reload, the row shows with no mark.
- **M10a.** The keys of a waiting card work also from the prompt box, so the user does not have to click the card first (`lib/cardKeys.ts`, the user asked for this). This applies to the permission card, the question card, the plan card, and the diff review pane of a request.
  - Esc answers the oldest waiting card: "Deny" on a permission card, "Skip" on a question card, "Revise…" on a plan card. It works from the prompt box (also with text in the box) and from any place with no keys of its own. A text field, an open menu (also the / and @ menus of the prompt box), a dialog, the terminal, and the editor keep their Esc. While a card waits, Esc does not stop the turn: the Stop button does.
  - The number keys answer the oldest waiting card from the same places, but from the prompt box only while the box is empty. A number in a message stays text.
  - While a card waits, the empty prompt box names the keys: "Press 1, 2, or 3 to answer the request, or Esc to deny it." ("1 or 2" with no "Always allow"), "Press a number to choose an answer, or Esc to skip the questions.", or "Press Ctrl+Enter to accept the plan, or Esc to revise it."
  - The "Skip" button of the question card shows the key Esc.

  Harness now uses the Claude Code CLI form ("Do you want to proceed?" with 1 Yes / 2 Yes, and do not ask again / 3 No). Change it to the desktop form.

### 6.4 Plan card

- **M11.** Header: "The agent proposed a plan", with the link "Open plan".
- **M12.** Buttons: at the left "Reject" and "Revise…" (Esc); at the right "Accept" (Ctrl+Shift+Enter) and the primary "Accept and allow edits" (Ctrl+Enter). The primary button has a menu: "Accept and auto mode", "Accept and bypass permissions".
- **M13.** "Revise…" opens a text area: "What should change? (optional)", with "Back" and "Revise".

### 6.5 Question card

- **M14.** Each option has a number badge. Number keys pick an option. Other controls: "Something else", "Skip", "Submit", "Next", "{current} of {total}".
- **M14a.** An option can have a `preview`, as in `AskUserQuestion` of Claude Code (the user asked for this): an ASCII mockup, a code snippet, or a short comparison, 4000 characters or less. When a question has previews, the options are at the left, and the preview of the option under the pointer or the focus (else the picked option, else the first) is at the right in a monospace box. A preview with a Markdown code fence shows as Markdown. In a narrow pane the preview goes under the options. Under the preview, the field "Add notes (optional)" adds a note to the answer: the agent gets it after the answer. A pick does not go to the next question at once when the question has previews: the user compares, adds a note, then clicks "Next" (or Ctrl+Enter in the notes). An answered card shows each note under its answer.

### 6.6 Working line

- **M15.** The working line shows: the label, "·", the time, "·", "{tokens} tokens", and "{count} running tasks" when tasks run.
- **M16.** Labels: "Thinking…", then "Still thinking…", "Thinking more…" as time goes on. After it: "Thought for {seconds}s". Other labels: "Connecting…", "Running tools…", "Working…", "Stopping…", "Retrying ({attempt}/{maxRetries})", "Compacting session…".
- **M17.** Compaction notices: "Compacted session · saved {tokens} tokens", "Compaction failed".
- **M17a.** Harness puts the working line at the bottom of the chat, after the task list, as the Claude app does (the user asked for this). It scrolls with the chat: nothing shows above the prompt box. It shows a 16px gyroscope in the accent color: 3 rings that turn on 3 axes, each drawn as a comet arc with a tail that fades (`GyroLoader.tsx`, the user chose it). With "reduce motion" on, it is still. Then the step of the task list in progress (or "Writing…", "Running {tool}…" with the words of its tool row, for example "Running git status…", "Thinking…", "Waiting for {model}…", "Waiting for your approval…", "Waiting for your answer…"). "Thinking…" shows while the reasoning of the model streams (the user asked for this): the daemon sends one `thinking` event when the first reasoning text comes (`reasoning_content` or `reasoning`), and the first text or tool call ends it. "Waiting for {model}…" shows only before the model sends anything, the time in muted text, and a caret. A click on the label, the time, or the caret shows the details (one button; the user asked for this). The line has no hover tip (the user asked to remove "Esc to interrupt"). The details are: "{tokens} tokens", "{count} running tasks", and the status when a step shows (`WorkingLine.tsx`). During the turn, the tool calls at the end of the chat do not show as a group line above the working line: the caret shows their rows, as in Claude Code (the user asked for this). When the turn ends, they show as a group line again.
- **M17b.** The question card and the plan card (M11–M14) are in the chat as permission cards are. A question card shows one question at a time with a header chip, the options with number badges, then "Something else" (a text field). One choice goes to the next question at once. A multiple choice has checkboxes. The foot has "{current} of {total}", "Back", "Skip", and "Next" / "Submit". An answered card shows the header and the answer of each question. The plan card shows the plan as Markdown in a box. An accepted plan sets the mode of the project.

### 6.7 Error cards

- **M18.** Use these titles: "Service is busy", "Rate limited", "Your context window is full", "Turn failed". Use these buttons: "Try again", "Copy details". Harness shows the card for the error of a failed turn (`ErrorCard` in `MessageList.tsx`): the title comes from the text of the daemon (`errorKind` in `lib/errorRoute.ts`), then the text, then the buttons. A failed context summary has the title "Compaction failed" (M17). "Try again" sends the last prompt of the session again. It shows only on the last error, when no message of the user came after it, when no turn runs, and when the same prompt can get a reply (not for a full context window, a failed summary, or a prompt that a hook blocked). The app keeps the last prompt only while it runs: after a restart the card has only "Copy details".
- **M18a.** Only an error of the conversation goes into the chat (`errorRoute` in `lib/errorRoute.ts`). The daemon puts the type of the failed request in `ref`. An error with no `ref` is the error of a turn. An error of a chat request (`prompt`, `command`, `steer`, `interrupt`, a card reply, `session.rewind`, `session.rewind_undo`, `session.fork`) is a line in the chat. All other errors stay out of the chat, so an error never goes into the middle of a reply:
  - The view that sent the request shows the error next to its control, with "Try again" when a new request can help. The Changes pane shows a red line under its header ("Couldn't load the changes. {text}", "Try again"), and it does not stay on "Loading the changes…". Settings > Operating Harness shows "Couldn't load the list of harnesses." with "Try again" in place of the skeleton rows.
  - A request that repeats with no action of the user (`git.status`, `git.changes`, `git.pr_info`, `context.get`, `tasks.list`, and the typing helpers) shows nothing: the next request tries again. The text goes to the console.
  - Each other error shows in an error popup at the bottom right (`ErrorToasts.tsx`, in the toast stack of V8a): a failed sidebar command, a failed request of a page, a closed connection, or an error of the Browser pane. The popup has the text and the X of V8b, and no action. It goes away after 8 seconds, and the time stops while the pointer or the focus is on it. At most 3 popups show.
  - The same text does not show two times: a chat line and a popup get a count ("×3"). The line "The connection to the daemon closed." shows one time for all failed reconnects.
  - A new request type needs no entry: with no entry, its error is a popup. Add it to `errorRoute.ts` only when a view shows its error, or when it repeats.
- **M18b.** An error never takes away the text of the user (audit U5, U6):
  - A failed save keeps the editor and its text. A red bar above the editor says "Couldn't save {file}. {text}" and has "Try again". A file that did not open shows the red bar with no editor.
  - A session start with a closed connection does not lock the start screen. The prompt box keeps its text, the error shows above it, and the error goes away when the connection opens again.
  - The banner "The connection to the daemon closed." with "Reconnect" shows on the start screen, the Routines page, the Capabilities page, and in the chat. It stays during an automatic retry ("Reconnecting…", "Reconnect now"). "Reconnect" is off only while a connection attempt runs.

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
- **V4.** The diff pane is "Changes", as in Claude (the user asked for this): its title, its pane button, its shortcut row, and its texts. Files is a pane button with a folder icon, to the right of Browser (the user asked for this). The ⋮ menu has "Side chat" with its key Ctrl+; at the top, then "IDE view" (V6f), "Background tasks", and "Preview".
- **V4a.** With no single change in review, the Changes pane shows all the changes of the branch, as in the Claude app (the user asked for this, `ChangesView.tsx`, daemon `git.diff`). The window header has "{base} → {branch}" with a ⌄ menu ("All changes of the branch", "Uncommitted changes"), then "Search" (it finds files and changed lines), the file list switch, and ⋯ ("Expand all files", "Collapse all files", "Refresh"). Each file has a section: a head that stays at the top while its lines scroll (the fold chevron, the file icon, the name, the folder, "+{added} −{removed}", "Viewed" (a viewed file folds), "Open file", and ⋯ with "Copy path" and "Open file"), then the lines with the old and the new line numbers. A removed line has a red tint and a striped bar at the left. An added line has a green tint and a solid green bar. The changed words of a changed line are marked, and the lines have the syntax colors of the code theme. A row "{n} unmodified lines" shows where the diff skips lines. The file list at the right shows each file with its counts: a click goes to its section. A pane narrower than 640px hides the list. The pane asks for the changes when it shows, and at the start and the end of each turn. A click on the Changes section of the session rail opens this view, not an older single change.

### 7.2 Session title bar

- **V5.** Left side: the folder name, a "|" line, then the title (`SessionTitle.tsx`). The folder name is plain text, not a chip (the user asked for this). A click on it opens the folder menu (V6). A click on the title renames it in place. A caret button at the right of the title opens the session menu (the same menu as S7).
- **V6.** The folder chip menu: "Copy" > "Path" / "Branch name", "Change folder…", "Open in terminal".

### 7.2a Session rail

- **V6a.** The session rail is a column at the right of a session (`role="group"`, label "Session details"). An icon button at the right end of the title bar shows or hides it. Tooltip: "Show session rail" / "Hide session rail". Label: "Session rail". Claude has no shortcut for it.
- **V6b.** The View menu has "Show Session Rail" / "Hide Session Rail". The command menu has the same command. (Harness has no app menu yet.)
- **V6c.** Claude sections, in this order: Environment, Goal, Settings, Context, Usage, Connectors, Progress, Outputs, Pull requests, Servers, Background tasks. Each section folds. The user can hide and reorder sections. The app keeps the shown state and the folded sections.
- **V6d.** In a narrow window the rail covers the session. Esc or a click outside closes it.
- **V6e.** Harness shows Environment, Context, Changes, Pull requests, Servers, Browser, and Background tasks, in this default order (`SessionRail.tsx`). Browser is under Servers (the user asked for this). A section with no data does not show. The user can drag a section heading to move the section, or press Alt+Up or Alt+Down on the heading (the user asked for this). On hover, a grip (six dots) shows at the far right of the heading, as in the Claude app. While the user drags, the held section follows the pointer with an accent ring, and the other sections slide out of the way to show its new place (the user asked for this, `useSortable.ts`). The sidebar projects move the same way. A move of less than 4 px is a click. The order is a preference (`sessionRail.order`): it stays for new sessions and after an update. A new section of an update goes after its neighbor of the default order. Harness does not hide sections yet. Harness has no Settings section: the user asked to keep the mode and model menus only under the prompt box. The "Worktree" row of the Environment section shows only for a session in a worktree, or when the "Worktree" box of the start screen is on for the project of the session (the user asked for this). The Environment section ends with the switch "Keep computer awake", the same switch as in the ⋮ menu: the user asked for it under the environment. It is a small row with an icon and a small switch, as "Remote Control" in the Claude app. Its hover text is "Only for this session".
- **V6e2.** A section heading of the rail is 32px high: a 24px button with 4px of space above and below it. The hover fill of the button stays inside the lines between the sections (the user asked for this, and for the 32px height). The button keeps 26px of space at its right for the grip, so a value in the heading (for example the context share) never goes under the grip (the user asked for this).
- **V6v.** The Background tasks section of the rail shows only the running tasks, the newest first (the user asked for this). A task that ends goes away from the rail. With no running task, the section does not show. The Background tasks pane lists the running tasks first. The ended tasks go into a "Finished" group with a count, under the running tasks. The group starts folded, and a click on its heading opens it (the user asked for this, `TasksPane.tsx`). Each row shows the description and "{kind} · {state}": "Command", "Monitor", "Agent", or "Wakeup". A wakeup that waits shows "Wakeup · in {time}".
- **V6w.** When a background task ends, a monitor writes a line, a background agent ends, or a wakeup is due, the agent gets a note, as in Claude Code. The note goes into the running turn, or it starts a new turn. The chat shows the note as a muted line with a bell icon, not as a user message.
- **V6x.** The dev servers are in the Browser pane, as in the Claude app (the user asked for this). The title bar has no Servers menu. The session rail toggle is the first button at the right of the title bar, before the pane buttons. A thin vertical line separates it from the pane buttons (the user asked for this). Harness has no Servers pane (the user asked to remove it). The Browser pane header has the Servers menu: start, stop, open, and "Edit launch.json". An empty browser tab shows a block with the servers of `.harness/launch.json`: the name, the port, and a play button. The play button starts the server, and the tab opens it when it runs. The first start of a command asks in the block, with the buttons of the permission card ("Deny", "Always allow", "Allow once"). The chat card asks too. With no launch.json, the block shows the servers that the harness found ("Save to .harness/launch.json"), or "Create launch.json from a template". Under the block: "Run a server to preview your app, or enter a URL. Edit this list in .harness/launch.json."
- **V6x2.** Servers and the agent (the user asked for all of these):
  - In auto mode, `preview_start` starts a server of `.harness/launch.json` with no question (a fast path of auto mode). A change of launch.json still gets the check of auto mode, so its commands are checked.
  - The agent calls `preview_servers` first: the name, the state, the URL, the command, and who started each server. It uses a running server when it serves what it needs, and starts or adds a server only when none does.
  - While a server of the project runs, the Browser pane header shows a power button before the Servers menu: "Stop all servers".
  - The server list loads again when `.harness/launch.json` changes (an edit of the agent, a save in the editor, or a status of a server that the list does not have), so a new server shows at once.
  - The daemon keeps who started each server (`started_by`). When the window closes and the app stays in the tray, and the agent started servers that run, the app asks first: "Stop the servers that the agent started?", "The agent started a server (web). They keep running while Harness is in the tray.", with "Cancel", "Keep running", and "Stop servers".
- **V6x3.** The tabs of the Browser pane and the terminal never scroll sideways (the user asked for this). They share the room and get smaller. A tab narrower than 70px shows only its icon (the open tab keeps its close button). When even the icons do not fit, a ⌄ button after the tabs lists all tabs, as in the Claude app: the icon, the title, the URL, and a close button. The open tab always shows in the strip. A new tab of the user ("New tab" or Ctrl+T) puts the focus in the address bar, so the user can type an address at once (the user asked for this).
- **V6x4.** The Browser pane header has "Minimize" (tooltip "Minimize to the session rail"), after the ⋮ menu and before the window buttons, as in the Claude app (the user asked for this). In the Code view, it closes the pane, opens the session rail, and the Browser section of the rail shows a small live view of the open tab. A click on the view opens the tab in the Browser pane again. The IDE view has no rail, so it has no Minimize button. A double-click on the divider next to the Browser pane does the same as "Minimize" (the user asked for this). A divider between two other panes does nothing on a double-click.
- **V6x5.** The X of the Browser pane closes the pane, and the Browser section of the session rail stops its view of the agent page (the user asked for this, `hideRailBrowser`). The tab stays open, and the agent can go on in it. The next agent call in the browser shows the view in the rail again. "Minimize" still keeps the view in the rail.
- **V6y.** The address bar of the Browser pane ends with "Annotate", as in the Claude app. It shows the annotation bar under the page, as in the Claude app (the user asked for this): the pane gives the bar its own row at the bottom, so the page gets smaller and the bar covers no part of it. The bar is not in the page, and it has no drawer. It is in the app (`AnnotateBar.tsx`), and it sends each choice to the page script (`annotate.ts`). The page script draws the marks, the outline, the note box, and the hint. The hint of the current tool is at the top of the page. The screenshot of "Add to prompt" has only the page. The menus of the bar open up over the page: the page hides, and a still picture of it shows, as for the other menus of the pane. A hover tip does not show on the page (a native window): a tip of the bar shows next to its button (`placeTip` in `Tooltips.tsx`). The bar has: select an element, "Pen", the shape menu ("Line", "Arrow", "Rectangle", "Ellipse", "Step"), "Text", undo, clear, "Add to prompt", and a close button ("Done", Esc). No tool is on when the bar opens: the user picks one, and a click on the tool that is on turns it off. The color menu shows only for the pen, the shapes, and text. The line width menu ("Thin", "Medium", "Thick", "Extra thick", with a check on the current width) shows only for the pen and the line shapes (the user asked for both). The marks are on the live page. "Add to prompt" puts a screenshot of the page with the marks into the prompt box (desktop app only). In the annotation mode, the element under the pointer has an outline and a label. A click on it opens a note box ("Add to prompt", "Cancel"). Each note goes into the prompt box with the page, the element, a CSS selector, its size and place, and the note. The element gets a number badge, and the button shows the count. Esc in the page, a new page, another tab, or the button ends the mode. The desktop app annotates all pages. A normal browser (development) annotates only pages of the app origin.
- **V6c2.** The Changes section, as in the Claude app (the user asked for it, `RailChanges.tsx`, `lib/pr.ts`). From top to bottom:
  - The pull requests of the session, as in the Claude app (the user asked for this, `RailPrList` in `RailChanges.tsx`, `sessionPrUrls` in `lib/pr.ts`): the pull requests that the agent made in the session (the output of `gh pr create`, or of a tool that makes a pull request, for example `mcp__github__create_pull_request`), the newest first, then the pull request of the branch (daemon `git.changes` `pr`) when the list does not have it. A link that the agent only reads or names does not count. Each row has the PR icon in the color of its state, the title, "{repository name} #{n}" (for example "Harness #18"), and a "⋯" menu with "Open pull request" and "Copy link". A click opens the pull request. The hover card of V6c3 shows on it. The state icon follows GitHub soon, as in the Claude app (the user asked for this): the rail asks `git.pr_info` with `fresh` for each pull request of the list (also the pull request of the branch) when it opens, every 30 seconds while the window shows, when the window comes back (focus), and at the start and the end of a turn (`usePrRefresh`). A `fresh` request uses a 10-second daemon cache (`FRESH_SECONDS`) in place of 60 seconds. This reply replaces the branch status of `git.changes`, which is older. The Pull requests section shows the same list only for a folder with no Changes section.
  - The work in three parts, each in its own color with its own icon and a color bar at the left (the user asked that uncommitted, committed, and pushed work look different): "Uncommitted" ({n} files, orange: the color of a changed file in the file tree), "Not pushed" ({n} commits that the remote branch does not have, blue), and "Pushed" ({n} commits on the remote branch that the base does not have, green). The colors are hues of the Clear Sight palette (the user asked for this): `--orange`, `--info`, and `--success`. Each row has "+{added} −{removed}". A part with no work does not show. A click opens the Changes pane. When the remote branch has commits that the folder does not have, a warning line says "{n} commits to pull from {upstream}".
  - The total row: the diff icon and "+{added} −{removed}" of the folder against its base branch (the commits that the base does not have, the uncommitted changes, and the new files). A click opens the Changes pane. With no work, it says "No changes", or "All work is in the pull request".
  - The git button at the right of the total row, with a menu button (⌄) at its right. The menu has the labels of the Claude app (the user gave them): "View changes" (it opens the Changes pane), the actions, "Manually create PR", and "Dismiss", with a line between the groups. The check mark is on the action of the button. A click on an action checks it, as on GitHub, and the button then does it: the button does not run at once. The choice stays (`gitAction.chosen`). The actions depend on the work. A GitHub repository (`gh`) with work and no open pull request: "Create PR" and "Create draft PR". Then "Manually create PR" opens the GitHub page that makes a pull request of the branch (`https://github.com/{owner}/{name}/compare/{base}...{branch}?expand=1`). It is off until the branch is on the remote. An open pull request with uncommitted work: "Commit and push" and "Commit". Only commits that are not pushed: "Push". No GitHub remote: "Commit and push" and "Commit" with a remote, else "Commit". No button when there is nothing to do. "Dismiss" hides the button for this session until the work changes (`gitAction.dismissed`). Each action sends a prompt to the agent, and the chat shows the label ("Create PR"). The agent never forces a push. The button goes away at the click of an action and while a turn of the session runs, so the user cannot ask for the same pull request two times (the user asked for this). After the turn it shows again if there is still something to do. If no turn starts in 10 seconds, it shows again.
  - The client asks for the changes when a session opens, when a turn starts and ends, and when the rail opens. The pull request of `git.changes` also updates the sidebar at once.
- **V6c3.** The pull request hover card, as in the Claude app (`PrCard.tsx`). It shows on the PR row of the rail and on a pull request link in the chat: a state pill ("Open", "Draft", "Merged", "Closed", with its icon), "{owner}/{name} #{n}", the time ("2m ago": of the merge, the close, or the last update), the title, the author (a round initial and the login), "+{additions} −{deletions}", and "{n} files". The colors are hues of the Clear Sight palette (the user asked for this): open green (`--success`), draft gray (`--text-muted`), merged purple (`--purple`), closed vermilion (`--danger`). The line about commits to pull is yellow (`--warning`). A pull request link in the chat (a `github.com/{owner}/{name}/pull/{n}` URL) shows the PR icon in the color of its state before its text. The daemon reads the pull request with `gh pr view <url>` (`git.pr_info`, 60 s cache). Without `gh`, the card says that it has no details. The card stays while the pointer is on the link or on the card.
- **V6b2.** The agent and the user use the same browser (the user asked for this). Each session has its own tabs (the user asked for this): the pane shows only the tabs of the open session, and the tabs of the other sessions stay open and hidden. All sessions use one browser engine with the same cookies, so a session costs no more memory than its own tabs. The agent and the user use the same tabs, with no difference (the user asked for this): no "Agent:" label, no bot icon, and no agent browser button in the address bar. The tool `preview_tabs` lists the tabs of the session (id, URL, title, "shown", "used"), and switches to one. The agent continues in a tab of the user that is about the task, else it opens a new tab (`preview_navigate` with `tab: "new"`). With no choice, it uses the shown tab when that tab has no page, else a new tab. A new tab does not take the keyboard focus, so a page that the agent opens does not stop the user who types in the prompt box (the user asked for this). The client answers the pseudo calls `Harness.listTabs`, `Harness.useTab`, and `Harness.newTab` of `browser.call` itself. A navigation of the agent shows its tab in the open pane. When the agent starts to work in the browser and the Browser pane is closed, the session rail opens with the "Browser" section, as in the Claude app (the user asked for this): a head with a globe icon, the page title, and a ⌄ menu of the tabs of the session ("Browser tabs"; a choice shows that tab in the section), "Open in the Browser pane", and "Close tab", then a small live picture of the page. The picture is live while the agent works (it stops one minute after its last action). While the agent uses the page (15 seconds after each of its browser calls), the picture has an outline in the accent color, as in the Claude app (the user asked for this). A click on the picture opens the page in the Browser pane ("Open in the Browser pane"). With the headless agent browser (a remote daemon), the section shows its live frames, and a click shows them in the pane.
- **V6z.** The close X of a window tab is 22px with a 15px icon (the user asked for a larger X). It is at the right edge of the tab, not next to the title (the user asked for this). A tab is 240px wide at most. The tabs get smaller to share the room of the header (the user asked for this).
- **V6s.** The heading of the Context section shows the share of the context window in use, for example "Context 57%", when the section is open and when it is folded, as in the Claude app (the user asked for this). The open Context section shows "{tokens} / {length}" at the right (for example "130.8k / 1M"), the usage parts (the same list as the context ring, C18), then "Compact" (the user asked for the short label). The Context section starts folded in each session and each time the rail opens (the user asked for this).
- **V6u.** Each new session opens the rail in the Code view (the user asked for this). The saved shown state does not change.
- **V6t.** In the Code view, the rail closes when a pane opens next to the chat (Browser, Files, Changes, Terminal, Preview, and the others), so the pane gets the room. When the last pane closes, the rail opens again (the user asked for this). It opens again only if a pane closed it: a rail that the user closed stays closed. The saved shown state does not change, and the title bar button opens the rail at any time.
- The section titles are not in the bundles. The titles above are a guess from the section ids.

### 7.2b View switch (Harness only)

Claude Code has no IDE view. The user asked for one, as in Cursor (P6).

- **V6f.** The ⋮ menu has "IDE view" with the key Ctrl+E, after "Side chat" (the user asked for this). It is a check item: on (a check mark) is the IDE view, off is the Code view. The title bar and the sidebar head have no Code / IDE switch now (the user asked to remove it for now). Ctrl+E switches the view only on the chat screen (the user chose this key). On other screens Ctrl+E does nothing (the user asked for this).
- **V6g.** The Code view is the Claude layout. The IDE view is laid out as VS Code: the Files pane (the file tree and search) at the left in the full height, the editor in the middle with the terminal under it, and the chat at the right in the full height. A saved IDE layout that is still the old default (the file tree inside the editor pane) gets this default. A layout that the user changed stays. Each view keeps its own layout for each project. The app opens in the view that the user used last (the user asked for this). In the IDE view, the start screen at launch starts an empty session, as a switch to the IDE view does. A switch back to the Code view before the user sends a prompt removes that empty session and shows the start screen again, with the folder block and no session rail: only the view changed (the user asked for this). Back and Forward never open a deleted session. Each new session (New session, or a prompt on the start screen) starts in the Code view. A switch to the IDE view on the start screen starts an empty session in the selected project (with the selected model, mode, and worktree choice), so the Files pane, the editor, the terminal, and the chat show at once. A switch to the Code view closes the Files window (the user asked for this).
- **V6r.** A pane that closes gives its space to the pane next to it, as in VS Code. A pane that opens again (for example the terminal) goes back to its last place and size in that view. In the IDE view, the editor window has no close button. The open files keep their close buttons.
- **V6h.** The IDE view hides the sessions sidebar and the session rail. The Code view shows the sidebar again. Ctrl+B still shows the sidebar in the IDE view.
- **V6j.** Settings > Appearance > "IDE view" sets the layout of the IDE view, from Cursor (named layouts), OpenCode (fixed regions), and Hermes (presets): "Classic", "Focus", "Wide terminal", "Review", then "Chat side" (Right / Left), "Chat width", and "Terminal height". A change resets the saved IDE layout of each project and applies at once. The user can still drag and resize the panes. In the IDE view, a Layout menu in the title bar (to the left of the pane buttons) has the same layouts and chat side, "Reset layout", and "Layout settings…".
- **V6k.** Editor autocomplete, as GitHub Copilot: when the user stops typing (400 ms), the model of the session writes the text at the cursor. The editor shows it as gray text. Tab accepts it, and Esc hides it. "Autocomplete" in the editor status bar turns it on or off (on by default). While it is on, the word list opens only with Ctrl+Space.
- **V6m.** The Files sidebar head has "New file…" and "New folder…". A name field opens at the top of the tree, with the folder of the open file as the start. Enter makes the item (the daemon message `fs.create`), and a new file opens in the editor. Esc closes the field. The edge on the right of the sidebar changes its width. A double-click sets the automatic width.
- **V6n.** The language of the open file is a menu in the editor status bar, with a filter. The choice changes the colors and the editor features of that file. The file on disk does not change.
- **V6o.** The Files pane of the IDE view has one header row (the user asked for a compact header): the window header holds the title "Files", then the Files and Search switch (two icon buttons, the pressed one has the fill of an active button), the "⋯" menu with the file actions and their names, and the window buttons. The pane has no second row. A file action from the "⋯" menu shows the file tree. A window header is 32px high, and each of its buttons is 28px. In a narrow window, the title gets narrower before a button goes out of view. The editor shows no empty tab row: with no open file, the "Editor" header is the only row above the editor (the user asked for this).
- **V6p0.** Esc stops the agent from anywhere in the window, not only in the prompt box (the user asked for this). An open menu or dialog closes first. A waiting card takes Esc before the agent stop (M10a). A text field, the terminal, the editor, and the split pane keep their own Esc.
- **V6p.** The agent shows a task list and an end-of-turn box, as Claude Code does (daemon tools `update_plan` and `wrap_up`). The chat draws the latest plan under the messages: a check mark for a completed step, a spinner for the step in progress, and a dashed circle for a pending step. At the end of a turn it draws a box with the recap, a question, and one or two answer buttons. A button sends its message as the next prompt. The chat does not show these two tools as tool rows. An unfinished plan of an older turn stays under the messages with no spinner, until the agent sends a new plan. The plan of an interrupted turn does not show after the next prompt. Exception: "Send now" of a queued message also stops the turn, but the plan stays (the user asked for this). When the user writes during a turn (a queued or steered message), or after the turn, the plan shows the muted heading "Plan from before your last message" at once, and its step in progress shows a "⋯" circle in place of the spinner, as in Claude Code (the user asked for this). A finished plan (all steps completed, or a `wrap_up` after it) folds into one line, "Plan finished · {n} steps", with a chevron (the user asked for this). A click opens the steps, and "Plan finished" at the top folds them again. The caret stays at the far right in both states: it points right on the folded line and down on the open list (the user asked for this). Each completed step shows its time at the right, in muted text ("8s", "1m 11s"), and the folded line and "Plan finished" show the total time of the plan (the user asked for this). The daemon puts the end time (`ts`) on each tool result, so the times stay after a reload. A step starts at the first `update_plan` that shows it in progress (or else at the call before the one that completes it), and ends at the first call that completes it. A step in progress at a `wrap_up` ends at the `wrap_up`. The total is the time from the first `update_plan` of the turn to the end of the plan. An old session with no times shows no times. When the turn has an end-of-turn box, the finished plan line is at the top of the box, over a line, so the plan and the recap are one card (the user asked for this). The recap is 300 characters or less (about 40 words), and the question 100 characters or less, as in the Claude app: `wrap_up` gives an error for a longer text, and the agent writes it again.
- **V6q.** The agent must keep the task list current (the user asked for this). The system prompt has a "Task list" rule: a plan in the first reply of a task of more than one step, one step in progress, an `update_plan` as soon as each step finishes, a new whole list after each new message of the user, and `wrap_up` at the end. The daemon adds harness notes (`agent.py` `_plan_note`): after 3 tool calls in a turn with no plan (one time in the turn), after each 8 tool calls with no `update_plan` while the plan has open steps (the user asked for this: some models mark all steps completed at the end, so the step times are wrong), after a message of the user during the turn when a plan exists, and at a new prompt when the last plan has steps that are not completed (the note names them).
- **V6k2.** The Files pane of the Code view, as in the Claude app (the user asked for this): the editor at the left, and the file tree at the right. With no open file, the editor shows a folder icon, "Open files appear here", and "Pick a file in the tree, or click a file path in the conversation." The top of the tree has the field "Filter, or ? to search in files": text finds files and folders by name, and text after "?" searches in the files (Enter). The window header has, from left to right: search ("Search in the files": the filter gets "?"), "Collapse all folders", the file tree switch ("Hide the file tree" / "Show the file tree"), and "⋯" (New file, New folder, Open folder, Refresh), then the window buttons. When no folder is open, the collapse button is dim, and its tip says "There are no open folders to collapse." The Files pane of the IDE view has "Collapse all folders" too, as the first button of its head.
- **V6k3.** The file tree shows the git state of the files in both views (the user asked for this). A changed file has a color and a letter at the right: M (modified), A (added), U (untracked), R (renamed), D (deleted), ! (conflict). A folder that holds changed files has the color and a dot at the right. The colors are hues of the Clear Sight palette (the user asked for this): changed files are orange (`--orange`, the color of uncommitted work in the Changes section), new files are green (`--success`), and deleted files and conflicts are vermilion (`--danger`). The daemon message `git.status` gives the states. The tree asks again after a save, a new file, a delete, a rename, a change on disk, Refresh, and each 20 seconds.
- **V6k4.** A file opens in an unpinned tab, as in the Claude app (the user asked for this). The name of an unpinned tab is in italics, and the tab has a pin button with the tip "Keep open" to the left of its close button. The next file that opens takes the place of the unpinned tab, so the editor has one unpinned tab at most. A pinned tab stays until the user closes it. These actions pin a tab: "Keep open", a double-click on the tab, a double-click on the file in the tree or in the filter list, and a change in the file. A new file from "New file…" opens in a pinned tab. A file that is open only gets the focus (`tabs.ts`). The file tabs look as the tabs of the browser (the user asked for this): a rounded tab with no file icon, a fill on the open tab, and a 22px close X. The X of a file tab shows at all times.
- **V6k5.** A drag changes the order of the file tabs and of the browser tabs (the user asked for this, `lib/tabDrag.ts`). The held tab follows the pointer in its tab row and gets the focus. Each other tab slides out of the way (160 ms) when an edge of the held tab goes past its center. After the drop, the held tab slides into its new place. Esc ends the drag, and the order does not change. A drag starts after 4px, so a click still selects the tab. With one browser tab only, a drag of the tab moves the pane, as a drag of the window header does.
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

- **V8.** An update shows as a strip at the bottom of the sidebar, not as a toast: "Relaunch to update · v{version}". Other states: "Update available", "Downloading update...". If sessions run, ask before the relaunch. Harness now uses a toast (`UpdateToast.tsx`) at the bottom right of the app (the user asked for this place), with the version and daemon update toasts above it. Change it to the strip later. Each start of an install (the toast and Settings > Updates) asks first while the agent works in a session of the daemon of this computer (`UpdateGuard.tsx`, the user asked for this): "Update while the agent works?", "The agent is working in {n} sessions. The update restarts Harness and stops that work.", with "Update now", "Wait for the agent" (the default button), and "Cancel". "Wait for the agent" shows "Harness updates when the agent is done." with "Cancel" and "Update now", and the install starts when the last turn ends. The "Wait for the agent" notes show at the top of the window, under the title bar, so they do not cover the prompt box (the user asked for this).
- **V8a.** The popups at the bottom of the window and the "Wait for the agent" notes at the top always show, whatever panes are open (the user asked for this). These popups are the update toast, the daemon version warning, the daemon update toast, and the "Wait for the agent" notes (V8, V10a). The Browser pane webview is a native window over the app, so it can cover a popup. A popup that the webview would cover moves to the left of the webview (`useClearOfNative` in `lib/overlay.ts`). When there is no room at the left, the webview hides and a still picture of the page shows, as for a menu.
- **V8b.** Each of these popups has an X at its top right (the user asked for this). The tooltip is "Close" with the key "Esc", and Esc in the popup also closes it. The X of the update toast hides the offer of this version. The X of the version warning hides it for this daemon and these versions. The X of a running daemon update hides the progress: the update goes on, and an error shows again. The X of a "Wait for the agent" note stops the wait, as "Cancel" does.
- **V9.** Help > "Check for Updates…" checks for an update.
- **V10.** System notifications have three types: permission request, question, task complete. Titles: "The agent needs your input to continue", "The agent is waiting for your input", "The agent finished a task" (P7). On Windows, flash the taskbar button when the app is not in focus.
- **V10t.** Harness shows the task complete notification now (the user asked for it). The title is the session title, and the text is a short summary of the turn: the first sentence of the last reply, or the reason of an early stop ("Stopped: a permission request was denied."). It shows when the user does not see the session: the window is hidden in the tray or minimized, Harness is not the active app, or the window shows another session. A turn that the user stopped gives no notification. A click on a notification (a turn or a routine run) shows the window, also from the tray, and opens the session of the notification (the user asked for this): the notification has the session id in `extra`, the desktop app has a click handler (`on_action` in `lib.rs`) that shows the window and sends `notification-open`, and the UI opens the session. The permission request and question notifications, and the settings of section 9.3, are still missing.
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
| Rewind | Esc Esc | same |
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

- **G0.** Settings keeps the text that the user types in a form (`SettingsDialog.tsx`, audit U9):
  - A form that opens on a click (for example "Add a provider") scrolls into view, and its first field gets the focus (`lib/formFocus.ts`).
  - Esc closes the open form first, with its "Cancel" button (`data-form-cancel`). The next Esc closes Settings. A field or a menu that uses Esc keeps it.
  - When the form has typed text, Esc asks "Discard the changes in the form?". A close of Settings (Esc, the X, a click outside, Ctrl+,) asks "Close the settings?", and another page asks "Leave this page?". The buttons are "Cancel" and "Discard". "Cancel" puts the focus back in the field.
  - Esc in a setting field outside a form saves the field first (it saves when the focus leaves it).
  - When a form closes, the focus goes to the current page in the nav, so Esc still works.

- **G1.** Settings is a page with a left nav in groups and a search field. Claude groups: "Account", "Customize" (Plugins, Skills, Connectors), "Products" (Claude Code), "This computer" (System, Extensions, Developer).
- **G2.** Harness groups, in this order:
  1. "Claude Code": the page with sections in G3.
  2. "Customize": "Permission rules". The skills, the MCP servers, and the plugins are not in Settings: they are on the Capabilities page (section 3.4).
  3. "Models": "Providers" (the model providers) and "Local models". These are Harness-only (P6). The user asked for the name "Providers" (it was "Connections").
  4. "This computer": "System", "Computers" (remote daemons).
  5. The changelog moves to the account menu ("View changelog").
- **G3.** The Claude Code page has sections in this order: "General", "Appearance", "Code appearance", "Sessions", "Browser", "Pull requests".

  Harness now has "Appearance" as its own page after "General". The page holds the "Appearance" rows and the "Code appearance" rows. When Settings changes to the groups in G2, move these rows into the Claude Code page.

- **G4.** Harness has a "Your Harness" page after "General" (the user asked for it, `YourHarnessSettings.tsx`). It has three sections: "Global instructions", "Project instructions", and "Memory". "Global instructions" starts with the row "Output style" (the user asked for it here, `OutputStyle.tsx`): a select with "Default", "Concise", "Explanatory", "Learning", "Proactive", the custom styles under "Your styles", then "New output style…" at the bottom. The style applies to all projects at the next turn, and only the agent that the user talks to gets it. "New output style…" opens the dialog "New output style", as in the Claude app: "Describe the style, and the agent will draft it for you.", "What should the style be like?" (placeholder "Short answers first, then detail. No filler words."), "Name (optional)", "Cancel", and "Create style" ("Drafting…" while the model works). The default model of the providers drafts the style (else the model of an open session). With no model, the description is the style text, and a note says so. The new style becomes the output style. Each custom style is a Markdown file in `~/.harness/output-styles/` (daemon `output_styles.py`): the user can edit or delete it. Then "Global instructions" has the four text areas of the user settings: they apply to all projects. "Project instructions" has a "Project" select and one text area, "Instructions for {project}" (the user asked for a separate box for each project). The text applies to that project only. The daemon keeps it next to the memory of the project (`~/.harness/projects/<project>/instructions.md`), not in the project folder, so a worktree uses the text of its project. The path shows under the box. The "Project" select of this section and of the Memory section show the same choice. In the system prompt, the order is: the global instructions, the project instructions of the settings, then the HARNESS.md or CLAUDE.md file. The Memory rows use the labels of the claude.ai Settings > Memory page, in this order:
  1. "Search and reference chats" (switch, default on). The agent gets the `conversation_search` tool. It searches the past sessions of the same project.
  2. "Generate memory from chats" (switch, default on). This is the auto memory switch.
  3. "Include sensitive topics in memory" (switch, default off). It is locked while "Generate memory from chats" is off.
  4. "Project" (select). Each project has its own memory, so the next three rows apply to the selected project. The default is the project of the open session, else the last project.
  5. "Your memory" with "Manage". The view lists the memories with their type, and has "Add memory". A click on a row opens its editor: "Name", "Type", "Description", "Content", "Delete…", "Cancel", "Save". "Your Harness" goes back.
  6. "Import memory from other AI providers" with "Start import". The view shows the prompt with "Copy prompt", a field for the reply, "Preview", the facts with checkboxes, and "Import {n} memories". After the import, the Manage view opens.
  7. "Export memory" with "Export". The app asks where to save the `.zip` of the Markdown files.

- **G5.** Harness has an "Operating Harness" page after "Your Harness" (the user asked for it, `OperatingHarnessSettings.tsx`). The operating harness runs the agent loop of new sessions (P2: "Applies to new sessions."). The page has "Check again" at the top right, then one radio row "Harness" with the pill "Built in" (the default), then "ACP harnesses · {n}" with a "Filter" field. With no filter, the group "Recommended" comes first (the user asked for it): OpenCode, Oh My Pi, Codex, Claude Agent, Gemini CLI, goose, Qwen Code, and Cline, in this order (daemon `RECOMMENDED`), each with the reason in place of the description. The group "More harnesses" has the other harnesses of the ACP registry. A filter shows one list of all the harnesses. Each radio row has the name, a status pill ("Downloaded", "Installed", "Runs with npx", "Runs with uvx", or "Not installed", with the detail as its tip), a "Local models" pill when the harness can use a local model server, the description, the command, the license, and a button that opens the website. Each row of the list can have a download control at its right (the user asked for it, daemon `acp_install.py`): "Download" when Harness can download the harness from the ACP registry and the program is not on the PATH, "Update" when the registry has a newer version than the download (tip "Update {name} to version {v}"), and the progress of a running download ("Downloading 45%" or the stage). A downloaded harness has the pill "Downloaded", "Version {v}" in its meta line, and a "Delete the download" button. "Delete the download of {name}?" asks first (R7). "Check again" also reads the registry for updates. When the selected harness can use a model of a Harness provider (Qwen Code, goose, Codex, OpenCode; daemon `acp_models.py`), a "Model" row follows the note of the selected harness (the user asked for it): a select with "{harness} settings" first, then the models of each provider in a group with the provider name. The description says "Applies to new sessions." and what the server must have (Codex: the Responses API). The row of a harness with a chosen model has "Model {provider}/{model}" in its meta line. The custom harnesses come last, with "Edit" and "Delete" buttons. "Custom harness" has "Add custom harness", which opens a form with "Name" and "Command". "Delete {name}?" asks first (R7). On the start screen, the chip of the operating harness replaces the model menu, and a click on it opens this page. With a model of a Harness provider, the chip is "{harness} · {model}". In an ACP session, the chip of the harness replaces the model menu under the prompt box (`HarnessMenu.tsx`): "{harness} · {model}". When the harness gives its models, the chip opens the menu "Model · {harness}" with a check on the current model. The context ring shows only when the harness reports its usage. The `/` menu shows the commands of the harness first, with the harness name as the source. An ACP harness that offers "always allow" gets the "Always allow" button: the scope note says "{harness} keeps the "Always allow" choice".

### 9.3 Setting map

| Option | Claude location and label | Control | Harness now |
|---|---|---|---|
| Theme | Appearance | Light / Dark / System | Appearance > Theme |
| Interface font | Appearance: "Font for the whole interface — menus, sidebars, and panels." | select | Appearance > Interface font |
| Text size and width | Appearance (transcript text size, transcript width with reset) | select | Appearance > Text size, Transcript width |
| Density | (the `data-density` attribute: compact or comfortable) | segmented | Appearance > Density |
| Code theme | Code appearance: "Light code theme", "Dark code theme" | select with a diff preview | Appearance > Code appearance (a code sample, no diff preview). The code blocks of a tool row in the chat use the code theme too (the user asked for this, `CodeBlock.tsx`): the background and the text color of the theme, and the syntax colors of Monaco ("Command" in shell, a written file in its language, other input as JSON, the output as plain text). A text of more than 20000 characters has only the theme colors. |
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
| Output style | Sessions: "Output style" (the session menu can change it for one session) | select, with "New output style…" at the bottom | Your Harness > Global instructions > "Output style" (the user asked for it, G4). It applies to all projects. Harness has no menu for one session yet. |
| Chat links | not a Claude setting | "Open links in": "Built-in browser" (default) / "Default browser" | General > Browser (the user asked for it). The same choice as "Open links in built-in browser" in the Browser ⋯ menu. A link that the agent lists opens in the Browser pane by default. |
| Browser tools | Browser: "Browser tools" | switch, default on | Browser ⋮ menu |
| Browser cookies | Browser: "Keep cookies" | Until quit / Shared / Per session | Browser ⋮ > Cookies |
| Allowed sites | Browser: allowed origins list | list | Browser ⋮ > "Manage allowed sites…" |
| Branch prefix | Pull requests: "Branch prefix", default "claude" | text field, saves on blur | missing |
| PR auto-archive | Pull requests: "Auto-archive after PR merge or close" | switch | missing |
| Open PRs outside | Pull requests: "Open pull requests in browser" | switch | missing |
| Run at startup | This computer > System: "Run on startup" | switch | General > System: "Keep running in the background" (switch, default off: closing the window hides it in the system tray), with the child row "Run on startup" (switch, off and locked while the parent is off). The start at sign-in uses `--background`: no window, only the tray icon. The restart after an update removes `--background` (`nsis/installer.nsi` `.onInstSuccess`): the updater gives the arguments of the old process, and the user must see the app after an update (the user asked for this). |
| Archive inactive sessions | Settings > Claude Code: "Archive inactive sessions" | select: "Never", "1 day", "2 days", "7 days", "14 days", "30 days" (default "Never") | General, help text "Archive sessions after a stretch with no activity. Running sessions and uncommitted changes are kept." (the user's text). User setting `auto_archive_days`. The daemon checks one time each hour and when the setting changes (`archive_inactive`). A session stays when it is open in a window or with no window, pinned, or in a worktree with changes that are not in a commit. The archive of a clean worktree session removes its folder, as a manual archive does. The windows get `sessions.archived` and load the session list again. |
| Storage | Settings: "Storage", "See how much space Claude uses on this computer.", "Manage" opens the "Storage" dialog | button and dialog | General > System > "Storage" (the user asked for it, `StorageDialog.tsx`). The dialog has "Disk space used" with "Checked {time}.", a bar in parts, a legend, then one row for each category with its size, a summary, and "Details": "Sessions and worktrees", "Local models", "Runtime", "Memory and settings", "App caches and logs". The footer has "Open folder" (a local daemon in the desktop app) and "Refresh". The daemon measures its computer (`disk.usage`, `disk_usage.py`). The desktop app adds the app folder, the webview data, and the Browser pane profile (`app_storage`). The dialog deletes nothing. With a remote daemon, the text says which computer has which data. |
| Update check | Help > "Check for Updates…" and the sidebar strip | menu item | General > Updates |
| Keyboard shortcuts | Help > "Keyboard Shortcuts" (Ctrl+/), a dialog | dialog | General table |
| Preferred providers | not in Claude | switch "Preferred providers" (the user asked for this name, it was "Choose the model by network"), then "Default model" and "Local model" lists | Providers page, at the top (the user asked for this). On: a new session with "Default model" uses the default model when its provider answers (a 1.5 s connection check of the daemon), else the local model, with a warning in the chat. An old session whose model is not available switches to that model when it opens (C17b). Off: the model is manual. The lists are off while the switch is off. The local list has only the models of providers on this computer. |
| Provider quick test | not in Claude | plug button on each provider row, tooltip "Test the connection" | Providers page, at the left of the Settings button of each closed provider row (the user asked for this). It tests the saved values and the saved key, as "Test" in the form does. The result shows under the key of the row: "Testing the connection.", "Connected in {ms} ms. {n} models.", or the error. |
| Web search | not a Claude setting (Claude Code has its own search) | select "Web search": "DuckDuckGo (no key)" (default), "Brave Search", "Tavily", "SearXNG", "Off", then "API key" (Brave, Tavily: in the keychain) or "SearXNG URL" | General > Web. Off removes `web_search`. `web_fetch` stays. |
| Auto memory | Claude Code: auto memory; claude.ai Memory: "Generate memory from chats" | switch, default on | Your Harness > Memory > "Generate memory from chats" (G4). Off removes the memory tool and the memory part of the prompt. `/memory` lists the memories. On: when a turn ends with no memory save, and the user message has a memory signal ("remember", "always", "from now on", ...) or the turn made 8 or more tool calls, the agent gets one more step to save facts to the memory (agent.py `MEMORY_CHECK_NOTE`). |
| Chat search | claude.ai Memory: "Search and reference chats" | switch, default on | Your Harness > Memory (G4). Off removes `conversation_search`. |
| Sensitive memory | claude.ai Memory: "Include sensitive topics in memory" | switch, default off | Your Harness > Memory (G4). Off adds a rule to the memory prompt: save sensitive topics only when the user asks. |
| Manage, import, export memory | claude.ai Memory: "Your memory" (Manage), "Import memory from other AI providers" (Start import), "Export memory" (Export) | buttons | Your Harness > Memory (G4), for the selected project |
| Subagents | Claude has "Dynamic workflows" ("Let Claude run several agents at once on complex tasks. Uses your limit faster.") | switch, default on | General > The agent > "Subagents". Off removes the agent tool. Harness has no workflows: the switch is for subagents (the user asked for it). |
| Global instructions | not in the Code tab (claude.ai has "personal preferences") | four text areas: "How to think", "How to do research", "How to speak", "Other instructions" | Your Harness > Global instructions (the user asked for this location and this name, G4). They apply to all projects. Only the session agent gets them, not a subagent. |
| Project instructions | not in the Code tab (claude.ai has project instructions) | a "Project" select and one text area | Your Harness > Project instructions (the user asked for it, G4). They apply to one project. All agents of the project get them, also a subagent. |
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
  - Harness uses one dialog for this (`ConfirmDialog`, with the hook `useConfirm` for a component with several actions). The text says what goes and what stays. The focus starts on "Cancel", and Esc cancels. When the dialog closes, the focus goes back to the control that opened it.
  - The dialog asks before an action that removes a sign-in, a token, a host, or a connection, or that stops a program: "Clear authentication" of an MCP server, "Remove" of a connector account, "Disconnect" and "Disconnect all" of a connector, "Regenerate" and "Delete token" of a routine, "Clear browsing data" and "Stop all servers" in the Browser pane, "Stop" of a served model and "Delete" of a host in Local models, and "Delete" of a provider and of a computer.
  - A terminal tab asks before it closes only when a program runs in its shell ("Close Terminal 2?" "The terminal runs PING.EXE. …"). The daemon gives the programs (`term.running`). A tab at its prompt closes at once. The X, a middle click, and Ctrl+Shift+W all ask.
  - Exception: the delete question of a session puts the focus on "Delete", so Enter deletes (the user asked for this, S8).
- **R7a.** An action that is easy to undo does not ask first. It shows a popup at the bottom right with the result and "Undo" (`ErrorToasts.tsx`, the stack of V8a): "Archived 3 sessions." after "Archive all", and "Cleared the side chat." after "Clear" of the side chat. The popup goes away after 8 seconds, as an error popup. Only the last action can be undone.
- **R8.** Show skeleton rows while the data loads.
- **C12a.** Shared controls (audit C3, C10, C12): one switch (`Switch.tsx`) whose label names the setting, not its state ("openai", not "openai is on"); one secret field (`SecretInput.tsx`) with a show and hide button for each token, key, and password; one back link (`BackLink.tsx`), a small ghost button with a left arrow and the name of the view it goes back to ("Skills", "Routines", "Your Harness", "Search results"). Form buttons ("Cancel", "Save") are at the right. A check mark of a menu is at the right of the item. A dot on a button is red only for a failure; work that runs has an accent dot. File sizes use powers of 1000 (`lib/bytes.ts`). Pane header icons are 15px. In the Settings dialog only the dialog title is an h1: a page title is an h2, with no icon and no control in its line.
  - Harness uses one skeleton (`Skeleton.tsx`): gray bars with the height of the real rows and a slow pulse (1.6 s). The rule for less motion stops the pulse.
  - A setting row whose value loads shows its label and a gray bar in place of its control (`RowsPending`), so a switch does not show "on" first and then change to "off". This applies to the daemon rows of General and Your Harness.
  - The sidebar shows 5 skeleton rows until the first session list arrives, in place of "No projects yet.". A reconnect to the same computer keeps the old list until the new list arrives. Another computer starts with skeleton rows.
  - The Changes pane shows 4 skeleton rows in place of "Loading the changes…".
  - A list keeps its rows while the next view loads. A click on a skill keeps the skill list, with a spinner in the clicked row, until the detail arrives.

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
- **T3a.** The sidebar has an opaque background (`--sidebar`). The user compared a translucent sidebar (Windows Mica and Acrylic) and chose the opaque sidebar.
- **T3.** The Harness dark theme is grey on dark grey (the user asked for this, and for no full black): neutral greys with no hue. The page is `#1c1c1c`, the sidebar `#262626` (a little lighter than the page, the user asked for this), a sunken field `#161616`, a panel `#242424`, a raised fill `#2e2e2e`, a border `#353535`, a strong border `#4a4a4a`, the text `#d6d6d6`, and the muted text `#9a9a9a`. The default accent ("White") is `#e6e6e6` on the dark theme. The status colors keep their hues. The light theme is light grey on off-white (the user asked for this), also with no hue: the page is `#f8f8f8`, the sidebar `#efefef`, a panel `#f1f1f1`, a raised fill `#e9e9e9`, a border `#dedede`, a strong border `#c6c6c6`, the text `#1c1c1c`, and the muted text `#5f5f5f`. The default accent is `#1c1c1c` on the light theme. The status colors of the light theme are dark shades with 4.5:1 or more on the page and on the grey surfaces. Change all the tokens of a theme in `styles.css` together.
- **T3c.** The session rail has the color of the chat (`--bg`) in each theme (the user asked for this). A 1px border separates it from the chat.
- **T3d.** Inline code in the transcript has no hue (the user asked for white text): `#ffffff` on the dark theme, and `#000000` on the light theme, on the raised fill (`--code-inline`).
- **T3e.** The status colors (the user chose them from examples). Each status color has two tokens: the text shade (`--success`) and the mark shade (`--success-mark`). Use the text shade for text. Use the mark shade for each use that is not text: a dot, an icon with no text, a bar, a border, a stroke, and a fill. Text needs 4.5:1 on the page and on the grey surfaces. A mark needs 3:1 on the page and on the sidebar. The focus ring (`--focus`) is the blue mark shade.

  | Color | Dark (text and mark) | Light text | Light mark |
  |---|---|---|---|
  | Green (`--success`) | `#63cf84` | `#08762d` | `#169c46` |
  | Red (`--danger`) | `#f07443` | `#c4260f` | `#f04a1c` |
  | Yellow (`--warning`) | `#edc54f` | `#8f5a00` | `#b47b00` |
  | Blue (`--info`) | `#60a7f0` | `#0a5fd0` | `#2b7fff` |
  | Purple (`--purple`) | `#ae99f0` | `#7a3fe0` | `#9461ff` |
  | Orange (`--orange`) | `#f0a54a` | `#995200` | `#cf6a08` |

  The dark theme colors are the "Clear Sight" hues (Okabe-Ito) with half of their saturation removed, so they agree with the greys. The light theme text shades are vivid hues that are dark. The light theme yellow stays a dark amber: a yellow with more light does not have enough contrast on off-white.
- **T3b.** A line is 1px: a border, a focus ring, and a drop outline (the user asked for thin outlines). Do not use 1.5px or 2px for an outline. A tab underline and a state bar can be 2px, because they are marks, not outlines.

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
- **T7a.** Harness has one corner radius: 2px (the user asked for this: each element with rounded corners has the radius of the buttons). The value is `--radius-sm`. The tokens `--radius`, `--radius-lg`, `--radius-xl`, `--prompt-radius`, and `--side-radius` stay as names for their elements, and each has the value of `--radius-sm`. Use a token. Do not write a radius value in a rule:

  | Token | Elements |
  |---|---|
  | `--radius-sm` | all buttons, small controls, rail headings, question options, Settings nav items, chips, status pills, badges, meters |
  | `--radius` | menus, code blocks, tool cards, list rows |
  | `--radius-lg` | panels, dialogs, the chat cards (permission, plan, end-of-turn box), the recent folders block |
  | `--prompt-radius` | the prompt box and the user message |
  | `--side-radius` | the sidebar rows |

  A pill shape (`999px`) is in use only for a switch: a switch is round, with a round knob (the user asked for this). A chip, a status pill, a badge, and a meter have the 2px radius. The x of an attachment is square with the 2px radius. A circle keeps `50%`: the scroll-to-bottom button (the user asked for a circle), a status dot, the radio button, an avatar, a color swatch, the switch knob, and the circle of a plan step. A segmented button, inside a 2px corner, has 1px.
- **T8.** The app default density is comfortable.

### 11.5 Depth and motion

- **T9.** Shadows: small `0 1px 2px` plus `0 2px 8px`; popover `0 8px 24px #0000001f, 0 2px 6px #00000014` (dark: `#00000052`, `#0003`). A panel has a 1px border ring plus the small shadow.
- **T10.** Focus: a 1px accent ring with a soft 6px accent glow.
- **T11.** Durations: fast 60ms, snap 120ms, base 200ms, sheet 300ms, slow 450ms. Ease out: `cubic-bezier(.165, .84, .44, 1)`. Honor `prefers-reduced-motion`.
- **T11a.** Harness has these values as tokens: `--dur-fast`, `--dur-snap`, `--dur-base`, `--dur-sheet`, `--dur-slow`, and `--ease-out`. `--duration` is `--dur-snap`, for hover colors. Use a token, not a number. Motion changes only `opacity` and the `translate` and `scale` properties, never the size or the place of a box. The keyframes are at the end of `styles.css`, and the rule for less motion makes all CSS motion instant.
  - An element animates when it opens or mounts: a menu or popover (120 ms, 4px from the side of its trigger), a dialog and its backdrop (200 ms, Settings 300 ms, scale from 0.98), the body of a row that opens (120 ms, 2px down), the sidebar and the session rail (200 ms from the side), a pane (120 ms fade, no size motion), a new Settings page or Capabilities tab (120 ms fade), the scroll-to-bottom button (120 ms, scale from 0.9), a new tab, the drop zone of a dragged pane, and a new save status text.
  - A new chat item fades in and rises 4px (200 ms, `useEnterMotion` in `lib/motion.ts`). A transcript that loads, with more than 2 new items at once, does not move.
  - A card that gets its answer changes its border, background, and glow in 200 ms.
  - The accent line of a pane divider shows after 100 ms of hover, so a pointer that passes does not flash it.
  - The hover sidebar fades out in 120 ms when the pointer leaves it (`usePresence`). Ctrl+B removes it at once.
- **T12.** Layers: modal 40, popover and tooltip 50, toast 60.

## 12. Wording

- **L1.** Use sentence case for all labels ("New session", not "New Session"). The app menu is the only exception: it uses title case ("New Session", "Check for Updates…").
- **L2.** Put "…" at the end of a menu item that opens a dialog or asks for more input ("Change folder…", "Revise…").
- **L3.** Use a question for a confirm title ("Archive session with uncommitted changes?"). Use a verb for the confirm button ("Archive anyway"), not "OK".
- **L4.** Error text says what failed and what to do: "Couldn't save the setting. Try again."
- **L4a.** One concept has one word everywhere (audit C7): "Compact this session" (the context ring; the rail keeps the short "Compact", V6s), "Stop" (not "Interrupt"), "Untitled session" for a session with no title, the project name of the sidebar also in Ctrl+K, the mode names of the mode menu also on a decided plan card ("Accepted · Manual"), "Settings > Providers" (not "the Connections screen"), "Local models", "Open in the Browser pane" (the pane) and "Open in your browser" (the system browser).
- **L5.** Use the Claude names: "session" (not "chat"), "Changes" (not "Diff"), "Side chat", "Background tasks", "Fork", "Rewind", "Archive".

## 13. Changes to make in Harness

Do these in separate changes, in this order:

1. Rename the permission modes and add their descriptions (C11, C13).
2. Change the permission card to the desktop form (M7–M10).
3. Add the "+" menu to the prompt box, with Ctrl+U (section 5.2).
4. Add effort to the model menu, and Ctrl+Shift+. (C15, C17).
5. Remove "Send while the agent works". Use Enter and Ctrl+Enter (C7).
6. Rename the "Diff" pane "Changes", and move Files to the pane buttons (V4). Done.
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
