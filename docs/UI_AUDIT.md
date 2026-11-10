# Harness UI/UX audit

Date: 2026-11-09. Branch: `claude/ui-ux-audit-62aecb` (master `c990a2a`, version 0.1.61).

## 1. Scope and method

- **Code review.** Four reviewers read all the UI code in `client/src` (about 51,000 lines) against `docs/UI_RULES.md`.
- **Live run.** The client ran in a browser (1280 x 800) with the demo model and the demo daemon. The walk-through covered: Computers, the start screen, a session, the question card, the permission card, each menu of the prompt box, Ctrl+K, all Settings pages, Capabilities, Routines, the Files, Changes, and Terminal panes, the IDE view, and the light theme.
- **Measurements.** Scripts in the page measured contrast, hit targets, font sizes, focus, and animations.
- **Limits.** The desktop shell (Tauri) did not run, so the native Browser pane, the tray, and the notifications are from the code only. The demo daemon was older than the client (`0fe5c40`), so it did not know `git.status`, `git.diff`, and `harnesses.list`. That fault showed how the UI handles errors (U1, U2).

Each finding has an ID, a severity, the evidence, and a fix. **Live** = seen in the running app. **Verified** = I checked the code myself. Other findings come from one reviewer and the code lines that the reviewer gave.

A decision that `UI_RULES.md` records ("the user asked for this") is not a defect. Section 9 lists the findings that touch such a decision.

## Status

- **Done on 2026-11-09 (not committed): U1, U2, U12.** Errors now go to their view, to an error popup, or to an M18 card in the chat (`UI_RULES.md` M18, M18a). The Browser pane errors of U12 show in the popup, not in a bar under the address bar. From U16: the Changes pane now shows a failed load. Not done from U13: the silent failures of the file cards and of the file tree.

- **Done on 2026-11-10 (not committed): U3, U21.** The number keys and Esc of a waiting card work from the prompt box (`UI_RULES.md` M10a). Stop shows during the whole turn, with Send next to it when the box has text. The diff review pane takes the same keys, so its line "Click this pane to use the number keys and Esc." is gone. From C7: the prompt box says "Stop", not "Interrupt". Not done: U22 (the Send tip in the "Interrupt" and "Steer" modes).
- **Done on 2026-11-10 (not committed): U5, U6, U7, U9.**
  - U5: a session start with a closed connection shows an error and does not lock the start screen. The disconnect banner shows on all screens that need the daemon (`UI_RULES.md` M18b).
  - U6: a failed save keeps the editor and the text, with "Try again" (M18b).
  - U7: each rewind line has "Undo rewind". The daemon keeps one undo until the next turn (`session.rewind_undo`, M3).
  - U9: Esc closes an open Settings form first. A close with typed text asks first. A new form scrolls into view and takes the focus (G0).
  - Not done: the other forms of the app outside Settings (U25).
- **Done on 2026-11-10 (not committed): U8, C2.**
  - U8: the actions that remove a sign-in, a token, a host, or a connection, or that stop a program, ask first (`UI_RULES.md` R7). A terminal tab asks only when a program runs in its shell (`term.running`). "Archive all" and the side chat "Clear" show a popup with "Undo" (R7a).
  - C2: the Providers and Computers deletes use the dialog, not a second click. The dialog gives the focus back to its opener.
  - Not changed: the delete step of the session menu (the user asked for Enter to delete there). `QuitGuard` and `UpdateGuard` still copy the dialog markup.
- **Done on 2026-11-10 (not committed): C1, C3, C5, C7, C8, C9, C10, C11, C12, C13, C14 (icons).** Font sizes and radii are on the T5 and T7a scales (11.5, 12.5, and 13.5 px became 12, 13, and 14 px; 5px became `--radius-sm`; the Settings dialog uses `--radius-lg`). One switch, one secret field, one back link, one size formula (`UI_RULES.md` C12a). One word for each concept (L4a). Not done: the tab strips (C4), the two search UIs (C6), and the header bar heights of C14.
- **Done on 2026-11-10 (not committed): M16, M17.** One skeleton with a slow pulse (`UI_RULES.md` R8). Settings rows show a gray bar in place of the control until the values arrive. The sidebar shows skeleton rows until the first list, and keeps its list at a reconnect. Changes shows skeleton rows. A skill click keeps the list with a spinner in the row.
- **Done on 2026-11-10 (not committed): R1, R3, U10, U11.** A waiting permission card hides the row of its call. After the answer, one row shows with the answer as a mark. A question or plan card hides its "Asked" row (`UI_RULES.md` M10b). Code blocks have "Copy code", and each finished reply has "Copy message" (M2a). A queued message is a dashed, muted bubble with "Queued" and actions that always show (C7). Not done: the repeat of the request in the diff review pane (R1), and the right-click menu of M2.
- **Done on 2026-11-10 (not committed): C1 (motion part), M1 to M15.** The motion tokens of T11 are in `styles.css`, and the elements of table 6.2 have their motion (`UI_RULES.md` T11a). New chat items animate, but a loaded transcript does not. Not done: the type sizes and radius values of C1, the exit motion of menus and dialogs, the tab width motion of M11, and M16 to M20.

## 2. Summary

| Group | High | Medium | Low |
|---|---|---|---|
| Hard to use | 12 | 26 | 7 |
| Redundant elements | 2 | 9 | 4 |
| Motion | 1 | 10 | 9 |
| Accessibility | 0 | 9 | 3 |
| Consistency | 0 | 8 | 6 |

The three largest themes:

1. **Errors go to the wrong place.** Each daemon error becomes a chat line. It can split a reply, it shows many times, and the pane that failed shows nothing.
2. **The keyboard model is not reliable.** Esc has three meanings, the number keys of a card fail from the prompt box, and no menu gives the focus back.
3. **The app has almost no enter or exit motion.** The stylesheet has 8 keyframes and one duration token. Menus, dialogs, cards, panes, and the rail change in one frame.

## 3. The 12 most important items

| # | ID | Problem |
|---|---|---|
| 1 | U1 | A daemon error splits the reply of the agent and shows many times in the chat. |
| 2 | U3 | The number keys and Esc of a card do not work from the prompt box. Esc stops the turn. |
| 3 | U5 | A session start with a closed connection locks the app in the busy state. |
| 4 | U6 | A failed save hides the editor and the unsaved text. |
| 5 | U7 | Rewind restores code with one click and has no undo. |
| 6 | U8 | Many destructive actions do not ask first. |
| 7 | U4 | Esc on some open menus stops the agent. |
| 8 | U9 | Settings: Esc drops a form draft, and a form opens out of view with no focus. |
| 9 | U10 | A reply and a code block have no copy command. |
| 10 | U11 | A queued message looks the same as a sent message. |
| 11 | M1 | Menus, dialogs, and cards have no enter motion. |
| 12 | R1 | One request shows in three places, and one command shows two times. |

## 4. Hard to use

### 4.1 Errors and feedback

- **U1 (high, Live, Verified). A daemon error goes into the chat, at any position.** `client/src/chat/state.ts:289-290` ends the streamed text and adds a notice for each `error` message. In the live run, the reply "I need two choices from you." became "I need two choices", an error line, then "from you." The same error showed 5 times after 5 layout changes. The line has no title, no "Try again", and no "Copy details" (rule M18). Fix: send an error to the view that made the request (`ref`). Show only turn errors in the chat, as an M18 card. Show an equal error one time, with a count.
- **U2 (high, Live). A view that failed shows a load state forever.** The Changes pane showed "Loading the changes…" with no end (`client/src/components/ChangesView.tsx:346-347`). Operating Harness showed three empty skeleton blocks under its error (`client/src/components/OperatingHarnessSettings.tsx:274-281`). Fix: each view shows its own error with "Try again", and removes the load state.
- **U12 (high). Sidebar, Routines, and Capabilities errors go into the chat of the open session.** `client/src/App.tsx:2095-2106`. A failed pin, archive, delete, or routine save shows nothing on the screen in use. Browser pane errors do the same (`App.tsx:2349`). Fix: one app toast for command errors (rules V11, L4). Browser errors go in a bar under the address bar.
- **U13 (medium). Some failures show nothing.** File card "Open", "Show in folder", and visual "Download" use `.catch(() => undefined)` (`client/src/components/ShareCards.tsx:38,61,174`, `VisualBlock.tsx:63`). An image over the limit is dropped (`PromptBox.tsx:226-234`). A failed folder list shows an empty folder (`client/src/editor/useEditor.ts:322-324`). Fix: show a short message for each.
- **U14 (medium). Operating Harness shows each error at the top of a long page.** `OperatingHarnessSettings.tsx:204-208`. "Give a name." shows many rows above the form. Fix: show the error under the field, and a download error in its row.
- **U15 (medium). General settings: a save error is out of view, and the control does not change at once.** `client/src/components/SettingsDialog.tsx:656-660,685,698`. Fix: change the control at once, put the old value back on an error, and show the R4 toast.
- **U16 (medium). Refresh and save give weak feedback.** "Refresh" in Changes shows no busy state (`ChangesView.tsx:321`). Only two settings pages show "Saved" (`SettingsDialog.tsx:652-654`). "Copy path" gives no feedback (`client/src/editor/EditorPane.tsx:515`). Fix: one status element for each page head, and the Copy to Check icon change in all copy buttons.
- **U17 (medium). A request that waits is not visible when the user scrolled up.** `client/src/components/MessageList.tsx:594-617`. Fix: show "Needs your approval" on the scroll button, in the accent color.
- **U18 (medium, Live). The tool row says "Running" before the user approves.** The row showed "Running `git status --short || ls`" with a spinner while the permission card waited. Fix: show "Waiting to run" with no spinner until the decision.

### 4.2 Keyboard

- **U3 (high, Live, Verified). The keys of a card do not work from the prompt box.** After a send, the focus stays in the prompt box. The question card shows number badges, but "1" typed "1" in the prompt box. The keys worked only after a click on the card (`client/src/components/QuestionCard.tsx:162-176`). The permission card shows "Deny `Esc`", but Esc from the prompt box stops the full turn (`PermissionCard.tsx:178-186`, `PromptBox.tsx:508-510`). Fix: while a card waits, send Esc and the number keys to the oldest open card when the prompt box is empty. Stop the turn only when no card waits.
- **U4 (high, Verified). Esc on some open menus stops the agent.** The global handler (`App.tsx:1877-1889`) skips only registered overlays and targets in a menu. The Files "⋯" menu and the tab list do not register (`EditorPane.tsx:357-379`, `client/src/layout/WindowTabs.tsx:113-136`), and the focus stays on the trigger. Fix: register each menu with `useOverlay`, and handle Esc on the wrapper.
- **U19 (medium, Verified). The app takes Ctrl+K, Ctrl+B, and Ctrl+E from the terminal.** `App.tsx:595-606`. Ctrl+N has an exception for `.terminal-pane` (`App.tsx:582`), the others do not. In a bash shell these keys edit the line. Fix: add the same exception. Section 8 gives these keys to the app, so the owner decides.
- **U20 (medium, Live). Ctrl+K finds only sessions.** `client/src/components/SessionSearch.tsx:25-35`. Rule P4 gives each command a path in the command menu. Fix: add the app commands as a second group.
- **U21 (medium, Verified). The Stop button goes away when the user types during a turn.** `PromptBox.tsx:694-709`. Fix: show Stop and Send together while a turn runs.
- **U22 (low). The Send tip says "Queue (Enter)" for all three send modes.** `PromptBox.tsx:705`. With "Interrupt", Enter stops the turn.

### 4.3 Data loss and destructive actions

- **U5 (high, Verified). A session start with a closed connection locks the app.** `App.tsx:1512-1534` sets `busy` and calls `conn.send` with no `try`. `client/src/daemon/connection.ts:92-95` throws. The send button turns forever, and "Reconnect" is off. Fix: use `sendSafely`, set `busy` to false on failure, and show the disconnect banner on all screens.
- **U6 (high, Verified). A failed save hides the editor.** `EditorPane.tsx:230` makes `ready` false when `file.error` is set, and `:713` then renders no editor. The user sees a red bar and no text. Fix: keep the editor mounted for a write error. Add "Try again" to the bar.
- **U7 (high, Verified). Rewind has no undo.** The menu has three choices (`MessageList.tsx:133-137`), and one click restores the code. "Undo rewind" (rule M3) is not in `client/src`. Fix: show an "Undo rewind" notice after each rewind.
- **U8 (high). Many destructive actions do not ask first (rule R7).**
  - Connector "Disconnect", "Disconnect all", "Remove" (`client/src/components/CapabilitiesPage.tsx:852,870,936`).
  - "Clear authentication" (`CapabilitiesPage.tsx:376`).
  - Routine "Delete token" and "Regenerate" (`client/src/components/RoutinesPage.tsx:640-647`).
  - "Clear browsing data" and "Stop all servers" (`client/src/browser/BrowserPane.tsx:1141-1143,1024-1034`).
  - A terminal tab close, also on a middle click (`client/src/components/TerminalPane.tsx:283-299`).
  - "Archive all (N)" (`client/src/components/Sidebar.tsx:357-362`).
  - Side chat "Clear" (`client/src/components/SideChat.tsx:84-87`).
  - Local model host "Delete" and served model "Stop" (`client/src/cookbook/CookbookScreen.tsx:796,741`).
  - Fix: `ConfirmDialog` for credentials, tokens, hosts, servers, and shells that run a command. An "Undo" toast for the others.
- **U9 (high, Live, Verified). Settings forms lose text and open out of view.**
  - Esc in a field closes all of Settings and drops the draft (`SettingsDialog.tsx:135-140`).
  - "Add a provider" opened its form at the bottom edge of the dialog (74 px in view), and the focus went to the page body. Esc then did nothing.
  - Fix: Esc closes the open form first. Put the focus in the first field. Ask before the dialog closes with a changed draft.
- **U23 (medium). "Skip" on a question card discards all answers.** `QuestionCard.tsx:286` calls `finish(null)`. Fix: "Skip" goes to the next question. Name the other command "Skip all".
- **U24 (medium). Routine detail: the schedule switch does not save, and "All routines" drops edits.** `RoutinesPage.tsx:517,418,525`. The same switch in the list saves at once. Fix: save the switch at once in both places.
- **U25 (medium). Two forms close before the daemon answers.** The cookbook host form (`CookbookScreen.tsx:807-817`) and the Email "Add account" form (`CapabilitiesPage.tsx:829-831`) lose the typed data after an error. Fix: keep the form open until the reply arrives.
- **U26 (medium). "Viewed" marks, folded files, and the search text of Changes are lost.** `ChangesView.tsx:200-205`. One permission request with a diff clears them. Fix: keep them in the session state, keyed by path and patch hash.

### 4.4 Finding things

- **U10 (high, Verified). A reply and a code block have no copy command.** `MessageList.tsx:548-553`, `client/src/components/CodeBlock.tsx`, `Markdown.tsx`. Rule M2 (right-click menu) is also missing. Fix: a copy button on each code block, and "Copy message" under each reply.
- **U11 (high, Verified). A queued message looks the same as a sent message.** `MessageList.tsx:298-311` sets the class `queued`, and `styles.css` has no `.queued` rule. "Remove" shows only on hover. Fix: a muted bubble, a "Queued" label, and actions that always show.
- **U27 (medium). The Changes pane stays on one old change.** `App.tsx:1049,746,1919` set `reviewId`. Only a new session, a disconnect, and a rail click clear it. The IDE view has no rail. Fix: replace the inner X of `DiffReview` with "All changes".
- **U28 (medium). The session title in the title bar is plain text.** `App.tsx:3240-3243`. Rule V5 gives it rename in place and the session menu. In the IDE view the sidebar is hidden, so the open session has no menu.
- **U29 (medium). The sidebar does not show that a filter is on.** `client/src/components/SidebarFilter.tsx:140-151`. No "Clear filters" (rules S1, S2).
- **U30 (medium). The project commands are only in a right-click menu.** `Sidebar.tsx:304-307,346-371`. Fix: a ⋮ button on hover and focus, as on a session row.
- **U31 (medium). The user cannot read the output of a dev server or restart it.** `client/src/servers/useServers.ts:106,108` has `restart` and `loadLogs`, and no component calls them.
- **U32 (medium). The "Uncommitted" row of the rail opens all changes of the branch.** `client/src/components/RailChanges.tsx:79` and `App.tsx:3709-3712`. Fix: the row sets the scope "uncommitted".
- **U33 (medium). The scope of many General rows is not clear (rule R3).** `SettingsDialog.tsx:663,697-703,747-789`. Fix: add "Applies to new sessions." or the correct scope sentence.
- **U34 (medium, Live). At 1280 px, the chat column was 302 px wide.** An old session opened with its saved Files pane and the session rail together. Rule V6t closes the rail only when a pane opens later. Fix: apply V6t when a session opens with a saved pane.
- **U35 (medium). The scroll position stays when a page or a detail view changes.** `.settings-body` and `.cap-page` are one scroll box for all content. A new page can open in the middle. Fix: set `scrollTop = 0` on each change.

### 4.5 Smaller items

- **U36 (medium). The chat does not follow content that grows later** (a visual gets its height after the item shows). `MessageList.tsx:438-455`. Not seen in a run.
- **U37 (medium). The side chat and the task output always scroll to the end.** `SideChat.tsx:123-127`, `client/src/components/TasksPane.tsx:64-67`.
- **U38 (medium). "Bypass permissions" is always in the mode menu (Live).** `client/src/components/ModeMenu.tsx:8-14`. Rule C12 hides it behind a setting that does not exist.
- **U39 (medium). A long command in a permission card has no height limit.** `styles.css:6134-6143`. The buttons can go out of view. Fix: `max-height: 240px; overflow: auto`.
- **U40 (low). A long user message has no height limit.** `styles.css:5697-5708`.
- **U41 (low). The branch list of the worktree menu stops at 30, with no filter.** `client/src/components/WorktreeMenu.tsx:31,54,112`.
- **U42 (low). "Tool calls in a turn" comes before its parent switch.** `SettingsDialog.tsx:747-765`.
- **U43 (low). The editor status bar has four text buttons that cannot shrink.** `EditorPane.tsx:783-833`. Not seen in a run.
- **U44 (low). The Changes pane opens on its own for each permission request with a diff.** `App.tsx:1046-1051`. The layout changes while the user types.
- **U45 (low). The Terminal pane is blank with no connection, and "+" does nothing at 8 tabs.** `TerminalPane.tsx:137,275,313-331`.

## 5. Redundant elements

- **R1 (high, Live). One waiting request shows in three places.** A permission request shows the tool row with a spinner, the card, and the working line "Waiting for your approval…". With a diff, the review pane adds the title and the three buttons again (`client/src/components/DiffReview.tsx:184-199`). After the decision, the row "Ran `git status`" and the line "Allow the agent to run `git status`? Allowed once" stay, one under the other. Fix: fold the tool row into the card while it waits. After the decision, show one row with an "Allowed once" mark.
- **R2 (high). The split pane shows three controls that do nothing.** "Fork", "Review the change", and "Review" get empty handlers (`client/src/components/SplitView.tsx:287-305`). Fix: hide a button when its handler is not given.
- **R3 (medium, Live). The question shows as a row and as a card.** "Asked 2 questions" is directly above a card with the heading "2 questions". Fix: remove the row when the card shows.
- **R4 (medium, Live). The tab name shows again as a heading.** Capabilities: tab "Connectors", then heading "Connectors". Routines: title "Routines", then heading "Routines" (`RoutinesPage.tsx:836,806`). Fix: keep the count and the actions, and remove the second title.
- **R5 (medium). The worktree option has two controls in one row.** The check box, and the same choice in the chip menu (`client/src/components/SessionStart.tsx:522-532`, `WorktreeMenu.tsx:84-106`). Fix: keep only "Branch to start from" in the menu.
- **R6 (medium). The start screen has two "New project" forms.** `SessionStart.tsx:46-142` and `client/src/components/RecentFolders.tsx:50-158`, with different fields and button text.
- **R7 (medium). General settings shows "Install and restart" two times.** `SettingsDialog.tsx:1089-1093,1119-1122`.
- **R8 (medium). Plugins: a pill "On" / "Off" next to each switch, and two spinners for one action.** `client/src/components/PluginsScreen.tsx:37,47,176,207`. Providers has the same "Off" badge.
- **R9 (medium). The rail Changes section has five controls that open the same view.** `RailChanges.tsx:79,98-102,202`.
- **R10 (medium). The viewport choice is in two menus of the Browser pane.** `BrowserPane.tsx:1086-1098,1239-1263`.
- **R11 (medium). Two components build the same file card.** `client/src/components/FileCard.tsx:18-43` and `ShareCards.tsx:28-72`. One file can get two cards.
- **R12 (low, Live). A connection row says the same thing two times.** "No saved token. Edit the connection." then "There is no token for this connection. Edit the connection and enter the token."
- **R13 (low). The update toast has "Later" and an X that do the same thing.** `client/src/components/UpdateToast.tsx:103-105,160`.
- **R14 (low). Providers has two "Add a provider" controls.** `client/src/components/ProvidersScreen.tsx:699-701,756-759`.
- **R15 (low). Dead code.** The full-screen form of Providers and Local Models (`ProvidersScreen.tsx:681-685`, `CookbookScreen.tsx:983-987`), the dead half of the worktree menu (`WorktreeMenu.tsx:28,77,133`), and unused styles `.pane-tabs`, `.pane-tab`, `.group-menu`, `.drop-zone.zone-center` (`styles.css:3914-3985,4327-4349`).

## 6. Motion

### 6.1 State now

- `client/src/styles.css` has 8 keyframes: `spin`, `tooltip-in`, `title-shimmer`, `sidebar-peek-in`, `scroll-bottom-dot`, `blink`, `update-toast-in`, `update-toast-slide`.
- It has one duration token, `--duration: 160ms`, and `--ease-out: cubic-bezier(0.16, 1, 0.3, 1)` (`styles.css:82-83`). Rule T11 gives 60 / 120 / 200 / 300 / 450 ms and `cubic-bezier(.165, .84, .44, 1)`.
- Hover colors, switch knobs, and fold arrows have transitions. All other state changes are instant.
- A global `prefers-reduced-motion` rule covers all CSS motion (`styles.css:234-242`). New motion needs no more work for it.

### 6.2 Motion to add

First add the tokens `--dur-fast: 60ms`, `--dur-snap: 120ms`, `--dur-base: 200ms`, `--dur-sheet: 300ms` and the T11 curve (C1). Animate only `opacity` and `transform`. M1 is high, M2 to M9 are medium, and M10 to M15 are low.

| ID | Element | Motion | Time |
|---|---|---|---|
| M1 (high, Live) | `.menu`, `.slash-menu`, popovers | `opacity` 0 to 1, `translateY(4px)` to 0 from the trigger side | 120 ms |
| M2 | `.modal-backdrop` | `opacity` 0 to 1 | 200 ms |
| M2 | `.modal`, `.settings-dialog`, Ctrl+K | `opacity` and `scale(.98)` to 1 | 200 ms (Settings 300 ms) |
| M3 | New chat items: user message, permission, plan, and question cards, end-of-turn box, file and browser cards | `opacity` 0 to 1, `translateY(4px)` to 0 | 200 ms |
| M4 | A card that resolves | `border-color`, `background`, `box-shadow` | 200 ms |
| M5 | Tool row, tool group, working line details, task list, rows that expand in Capabilities and Settings | body `opacity` and `translateY(-2px)` to 0. For short lists: `grid-template-rows` 0fr to 1fr | 120 ms / 200 ms |
| M6 | Sidebar show and hide (Ctrl+B), narrow sidebar and scrim | `translateX(-100%)` to 0, scrim `opacity` | 200 ms |
| M7 | Session rail (also when it moves on its own, V6t) | on mount `opacity` and `translateX(12px)` to 0. Narrow overlay: `translateX(100%)` to 0 | 200 ms / 300 ms |
| M8 | A pane that opens | `opacity` 0 to 1 on `.pane-window`. Do not animate its size: Monaco, xterm, and the webview resize each frame | 120 ms |
| M9 | Settings page, Capabilities tab, list to detail | new view `opacity` 0 to 1. Keep the list until the detail arrives | 120 ms |
| M10 | Scroll-to-bottom button | `opacity` and `scale(.9)` to 1. Cross-fade the dots and the arrow | 120 ms |
| M11 | Tabs of the browser and the terminal | new tab `opacity`. `flex-basis` and `max-width` when the tabs share the room | 120 ms |
| M12 | Pane divider hover | draw the line in `::after`, `opacity` with a 100 ms delay. The transition on a gradient now does nothing (`styles.css:3873-3903`) | 120 ms |
| M13 | Pane drop zone | `opacity` on show, `inset` between sides | 120 ms |
| M14 | Save status "Saving…" / "Saved" | `opacity` in 120 ms, out 200 ms | |
| M15 | Hover sidebar exit | `opacity` (it has an enter animation only, `styles.css:897-915`) | 120 ms |

### 6.3 Load states (rule R8)

- **M16 (medium). Skeleton rows are missing.** Only Operating Harness has them, and they do not move. General and Your Harness show default values in disabled controls, so a switch can show "on" and then change to "off" (`SettingsDialog.tsx:685,698`). The sidebar shows "No projects yet." while the list loads, and again at each reconnect (`App.tsx:1191`, `Sidebar.tsx:625-636`). Changes shows plain text. Fix: 3 to 6 skeleton rows with the row height and a slow pulse. Keep an old list until the new list arrives.
- **M17 (medium). A skill click shows the list, then one line, then the detail.** `CapabilitiesPage.tsx:1034-1039`. Fix: keep the list, with a spinner in the clicked row.

### 6.4 Motion to correct

- **M18 (low). Two progress bars animate layout properties.** `width` at `styles.css:3187,9178` and `left` in `update-toast-slide` (`styles.css:9182-9195`). Fix: `transform: scaleX()` and `translateX()`.
- **M19 (low). The gyroscope draws when it is out of view.** `client/src/components/GyroLoader.tsx:91-99`. Fix: stop the loop with an `IntersectionObserver`.
- **M20 (low). Fold arrows use three timings.** 160 ms (`styles.css:5881-5885`), `120ms ease` (`:7021`, `:10587`), and none (`:11141-11143`). The diff file head swaps two icons and does not turn.

## 7. Accessibility

Good results first: all measured text has a contrast of 4.5:1 or more in both themes, with one exception (A9). Each icon-only button has `aria-label` and `title`. A global `:focus-visible` outline is in place.

- **A1 (medium, Live, Verified). No menu and almost no dialog gives the focus back.** After Esc in the model menu and the mode menu, the focus was on the page body. Only Settings and the sidebar filter give it back.
- **A2 (medium). The dialogs do not keep the focus inside.** `SettingsDialog`, `StorageDialog`, `AllowedSites`, `ConfirmDialog`, `QuitGuard`, `SessionSearch` set `aria-modal` only. Tab moves to the page behind. Fix: set `inert` on the app root while a dialog is open.
- **A3 (medium). About 20 menus have their own code and different keys.** Some have arrow keys (`ModeMenu`, `MoreMenu`, `FileTree`), most do not (`ChangesView`, `BrowserPane`, `ServerMenu`, `WindowTabs`, `LanguageMenu`, `IdeLayoutMenu`, the project menu, the rewind menu, the plan menu). Fix: one `Menu` component with arrows, Home, End, Esc, focus return, and `useOverlay`. This also corrects U4 and A1.
- **A4 (medium). The full chat is one live region.** `MessageList.tsx:539`, `SideChat.tsx:176`. A screen reader speaks each streamed change. A new card has no `role` and no announcement. Fix: one `sr-only` status element that names each new card and the end of a reply.
- **A5 (medium). Tabs and radio groups have the roles but not the arrow keys.** `CapabilitiesPage.tsx:1248-1268`, `CookbookScreen.tsx:990-999`, `WindowTabs.tsx:87-110`, `SettingsDialog.tsx:290-297`.
- **A6 (medium). The file tree and the task list have no keyboard model.** Each tree row is a Tab stop (`client/src/editor/FileTree.tsx:217-259`). A task row has `onClick` only (`TasksPane.tsx:87-95`).
- **A7 (medium). Hover tips show only for the pointer.** `client/src/components/Tooltips.tsx:151-181`. A keyboard user gets no name and no key for an icon button. Fix: show the tip on `focusin` with `:focus-visible`.
- **A8 (medium). The question card and the plan card take the focus but do not show it.** `styles.css:6212-6214,6396-6398` set `outline: none`.
- **A9 (medium, Live). Some targets are smaller than 24 px.** Measured: sidebar ⋮ and "+" 20 x 20, the pane divider 5 px wide, the folder chip 20 px high. From the code: the attachment X 16 px, the file tab X 20 px, the switch 36 x 20, the copy URL button 22 px. Fix: keep the icon size and extend the hit area.
- **A10 (low, Live). The error text in the dark theme has a contrast of 4.14:1.** `rgb(255, 94, 26)` on the error tint, 13 px.
- **A11 (low). The Email connector form has placeholders but no visible labels.** `CapabilitiesPage.tsx:749-788`.
- **A12 (low). The alert dot of "Routines" has the label "A server failed".** `Sidebar.tsx:255,588`.

## 8. Consistency

- **C1 (medium). Motion and type values do not follow the rules.** One duration token against the five of T11. Font sizes 11.5, 12.5, and 13.5 px are in use, and T5 has 11, 12, 13, and 14 px. Radius 5 px is in use (`styles.css:6249-6258`), and T7a does not have it. Settings uses `--radius-xl`, and T7a says that this token is not in use.
- **C2 (medium). Three confirm patterns for a delete.** `ConfirmDialog`, a second click in the row (`ProvidersScreen.tsx:518-533`, `ConnectionsScreen.tsx:344-359`), and a step in the menu (`SessionRow.tsx:215-229`). `QuitGuard` and `UpdateGuard` copy the dialog markup. Rule R7 gives one pattern.
- **C3 (medium). Three switch components.** `SettingsDialog.tsx:205-219`, `ProvidersScreen.tsx:81-95`, `ModelChoice.tsx:77-87`. Some labels state a state ("openai is on").
- **C4 (medium). Three tab strips with three overflow behaviors.** Browser and terminal tabs never scroll, editor tabs scroll under a scrollbar, and narrow pane tabs scroll with a hidden scrollbar.
- **C5 (medium). The page header has three builds.** Only Local Models has an icon in its title and a control in the same line. The Settings dialog has two `h1` elements.
- **C6 (medium). Search in files has two UIs.** The "?" filter of the Code view has no case, regex, or glob option. The IDE view has all three (`client/src/editor/SearchPanel.tsx:40-76`).
- **C7 (medium). One concept has more than one word.**
  - "Compact now" (context ring), "Compact" (rail), "Compact this session" (rule C18).
  - "Interrupt" (prompt box) and "Stop" (rule C7).
  - "New session" (title bar) and "Untitled session" (sidebar) for the same new session (Live).
  - "Demo app · scratchpad" (sidebar) and "demo-project" (Ctrl+K) for the same folder (Live).
  - "Running Bash…" (working line) and "Running `git status`" (tool row).
  - "Ask permissions", "Auto mode" (decided plan card) and "Manual", "Auto" (mode menu).
  - "/connections: Open the Connections screen" (Live), and the page is "Providers".
  - "Local Models" (Settings nav) and "Local models" (rule L1, Storage dialog).
  - "Open in browser" opens the Browser pane, and "Open in your browser" opens the system browser.
- **C8 (medium). A red dot means "tasks run" on the ⋮ button and "failed" in the sidebar.** `client/src/components/MoreMenu.tsx:82`.
- **C9 (low). Check marks differ.** On the right in the mode menu, on the left in the project menu, and no mark on the checked "Side chat" and "Preview" items (`MoreMenu.tsx:86-105`).
- **C10 (low). Secret fields differ.** Only the provider key has show, hide, and copy. The daemon token, the web key, the Hugging Face token, the GitHub token, and the app password have none.
- **C11 (low). Form buttons are in different corners.** The routine form has "Cancel" and "Save" at the left. The memory and provider forms have them at the right.
- **C12 (low). Five back links with different looks.** "All capabilities", "Skills", "All routines", "Your Harness", "Back to the results".
- **C13 (low). File sizes use two formulas.** `StorageDialog.tsx:13-23` divides by 1000, and `client/src/cookbook/useCookbook.ts:249-259` divides by 1024.
- **C14 (low). Window header heights and icon sizes differ.** Bars are 38, 40, 36, 34, and 28 px. Header icons are 13 px in Preview and 15 px in the other panes.

## 9. Findings that touch a recorded decision

The owner decides these. The report does not count them as defects.

- **"Keep computer awake" is in the ⋮ menu and in the rail** (V6e). Both showed at the same time in the live run.
- **The context share is in the ring and in the rail heading** (V6s).
- **The step in progress shows in the task list and in the working line, each with a spinner** (M17a).
- **The folder is in the center block and in the folder chip of the start screen** (N3, N5).
- **A double-click on the divider next to the Browser pane minimizes the pane** (V6x4). A double-click on the file sidebar edge resets its width. A user can close the browser by accident.
- **The "Active" / "Inactive" pill next to the routine switch** (RT3).
- **Ctrl+Enter in the prompt box approves a waiting request** (M8), also when the user typed a new message.
- **The default density in the code is compact** (`client/src/lib/theme.ts:71`). Rule T8 says comfortable. In compact density, more targets are under 24 px.

Known pending work in `UI_RULES.md` section 13 is not repeated here: the "+" menu, the Ctrl+Alt row keys, the sidebar search field and account menu, the Settings groups and search, "Send while the agent works", the update strip, and the missing shortcuts.

One more live item for that list: the "More" accordion shows only with an open session, so the full project list moves down one row when a session opens.

## 10. Checked and good

- Contrast in both themes (one exception, A10).
- `prefers-reduced-motion` covers all CSS motion, the smooth scroll, and the gyroscope.
- Permission, plan, and question cards share one anatomy. The key hints show on the permission buttons.
- The prompt box keeps its draft when the layout changes (Live).
- The "/" and "@" menus have key hints. The mode menu names its shortcut.
- Delete always asks first. A dirty editor tab asks before it closes.
- Resizers have ARIA values, arrow keys, and a focus style.
- The provider form has inline validation, busy states, and copy feedback.
- Empty states with guidance: Files, Tasks, Preview, the server block, Routines.
- The light theme has no layout or contrast fault in the views of the live run.

## 11. Order of work

1. **Errors (U1, U2, U12).** Route each error to its view, show equal errors one time, and add the M18 card. This removes the most visible fault.
2. **One `Menu` component and one dialog hook (A1, A2, A3, U4).** Focus return, focus trap, arrow keys, and `useOverlay` in one place.
3. **Card keys (U3) and Stop (U21).**
4. **Data loss (U5, U6, U7, U9).**
5. **Confirm and undo (U8, C2).**
6. **Motion tokens, then the table in 6.2 (C1, M1 to M15).** With the shared `Menu` and dialog of step 2, M1 and M2 are two CSS rules.
7. **Redundant rows in the chat (R1, R3), copy commands (U10), queued look (U11).**
8. **Skeletons (M16), then the consistency items.**
