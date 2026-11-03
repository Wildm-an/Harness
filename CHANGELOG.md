# Changelog

The changes in each version of Harness. The newest version is first. The Settings dialog shows
this file on its Changelog page.

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
