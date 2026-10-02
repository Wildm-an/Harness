# Changelog

The changes in each version of Harness. The newest version is first. The Settings dialog shows
this file on its Changelog page.

## Unreleased

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
