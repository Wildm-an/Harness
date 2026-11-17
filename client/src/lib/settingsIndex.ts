// The search of Settings (docs/UI_RULES.md G1a): an index of the settings of each page. The user asked for a
// search field at the top of Settings. Only the current page is drawn, so the search cannot read the other
// pages: this list names each setting, its page, and its section. A test (settingsIndex.test.ts) checks that
// each <Row label="..."> of the Settings pages is in the list.

import type { SettingsPage } from "../components/SettingsDialog";

export interface SettingEntry {
  page: SettingsPage;
  label: string; // The text of the setting on its page. A result scrolls to the element with this text.
  section?: string; // The section heading on the page.
  help?: string; // Words of the help text, for the search.
  keywords?: string; // Other words that the user may type.
}

export const PAGE_LABELS: Record<SettingsPage, string> = {
  general: "General",
  harness: "Your Harness",
  operating: "Agents",
  rules: "Permission rules",
  appearance: "Appearance",
  models: "Local models",
  connections: "Providers",
  computers: "Computers",
  updates: "Updates",
};

const e = (page: SettingsPage, section: string | undefined, label: string, help?: string, keywords?: string): SettingEntry => ({
  page,
  label,
  section,
  help,
  keywords,
});

export const SETTINGS_INDEX: SettingEntry[] = [
  // General
  e("general", undefined, "Send while the agent works", "Queue, interrupt, or steer a message while a turn runs.", "busy enter queue"),
  e("general", undefined, "Sidebar organization", "Sessions or Threads, as T3 Code.", "threads layout sidebar"),
  e("general", undefined, "Time format", "12-hour or 24-hour clock.", "clock am pm"),
  e("general", "The agent", "Default permission mode", "For a project that has no mode of its own.", "manual auto plan accept edits"),
  e("general", "The agent", "Allow bypass permissions mode", "Show the bypass mode in the mode menu.", "yolo skip permissions"),
  e("general", "The agent", "Local sandbox", "Run the commands of the agent in a sandbox.", "isolation security"),
  e("general", "The agent", "Prompt suggestions", "The model suggests the next prompt."),
  e("general", "The agent", "Subagents", "Let the agent give tasks to subagents.", "agents parallel background"),
  e("general", "The agent", "Archive inactive sessions", "Archive the sessions that had no activity for some days.", "auto settle cleanup"),
  e("general", "The agent", "When you ask for an unrelated task", "Start a new session or keep the task here.", "new session"),
  e("general", "The agent", "Check the app after UI changes", "The agent opens the preview and checks each change.", "verify preview browser"),
  e("general", "The agent", "Review large changes", "A subagent reviews a large diff.", "code review"),
  e("general", "The agent", "Tool calls in a turn", "The agent stops after this many tool calls.", "limit max steps"),
  e("general", "The agent", "Limit tool calls", "Off: the agent works until it stops.", "max steps"),
  e("general", "The agent", "Command timeout", "The time limit of a command of the agent.", "bash shell seconds"),
  e("general", "The agent", "Terminal shell", "The shell of the terminal pane.", "powershell bash cmd"),
  e("general", "Web", "Web search", "The search provider of the agent.", "duckduckgo brave tavily searxng"),
  e("general", "Web", "API key", "The key of Brave Search or Tavily.", "brave tavily web search key"),
  e("general", "Web", "SearXNG URL", "A SearXNG server.", "web search"),
  e("general", "Browser", "Open links in", "Where a link in the chat opens.", "browser pane links"),
  e("general", "System", "Storage", "How much space Harness uses on this computer.", "disk space cache"),
  e("general", "System", "Keep running in the background", "Keep Harness in the system tray.", "tray close window"),
  e("general", "System", "Run on startup", "Start Harness when you sign in to the computer.", "login boot autostart"),
  e("general", "Keyboard shortcuts", "Keyboard shortcuts", "The keys of the app.", "hotkeys keybindings"),
  e("general", "Dictation", "Speech model", "Changes your speech to text on this computer.", "voice microphone whisper"),
  e("general", "Dictation", "Clean up dictation", "A model removes filler words from the dictated text.", "voice"),
  e("general", "Dictation", "Cleanup model", "The model that cleans up the dictation.", "voice"),
  // Your Harness
  e("harness", "Global instructions", "Output style", "How the agent structures its replies.", "concise explanatory learning"),
  e("harness", "Global instructions", "How to think", "How the agent plans and checks its work.", "instructions prompt"),
  e("harness", "Global instructions", "How to do research", "How the agent finds and checks information.", "instructions prompt"),
  e("harness", "Global instructions", "How to speak", "The style and the length of the replies.", "instructions prompt tone"),
  e("harness", "Global instructions", "Other instructions", "All other rules for the agent.", "instructions prompt"),
  e("harness", "Project instructions", "Project", "The project of the project instructions and the memory."),
  e("harness", "Project instructions", "Verify command", "The command that checks the work of the agent.", "tests lint"),
  e("harness", "Memory", "Search and reference chats", "Search the past sessions of the same project.", "conversation search history"),
  e("harness", "Memory", "Generate memory from chats", "Keep notes about you and the project.", "auto memory"),
  e("harness", "Memory", "Include sensitive topics in memory"),
  e("harness", "Memory", "Your memory", "See and change the memories.", "manage memories"),
  e("harness", "Memory", "Import memory from other AI providers", "Import a memory export.", "chatgpt gemini"),
  e("harness", "Memory", "Export memory", "Download your memory as a .zip.", "backup"),
  // Agents
  e("operating", undefined, "Agents", "The agents that run new sessions: Harness, Claude Agent, Codex, and more.", "acp harness claude codex gemini opencode hermes"),
  e("operating", undefined, "Auto mode model", "The model that checks the actions of the other agents in Auto mode."),
  e("operating", undefined, "Add agent", "Add an agent from the ACP registry, or a custom agent.", "install download acp registry"),
  e("operating", undefined, "Check again", "Look for the installed programs and updates again.", "refresh"),
  e("operating", undefined, "Account", "Sign in to Claude Code with your subscription.", "sign in login claude max subscription"),
  e("operating", undefined, "Usage", "The usage limits of your subscription.", "5-hour limit weekly"),
  e("operating", undefined, "Model", "The model of the agent for new sessions."),
  // Permission rules
  e("rules", undefined, "Permission rules", "The tool calls that run with no approval, or never run.", "allow deny approve permissions"),
  e("rules", undefined, "Allow", "These tool calls run with no approval request.", "always allow rule"),
  e("rules", undefined, "Deny", "These tool calls never run.", "block rule"),
  // Appearance
  e("appearance", undefined, "Theme", "Light, dark, or system.", "dark mode light mode"),
  e("appearance", undefined, "Accent color", "The color of the primary buttons, the links, and the selected items."),
  e("appearance", undefined, "Interface font", "Font for the whole interface."),
  e("appearance", undefined, "Text size", "The text of the conversation.", "font size zoom"),
  e("appearance", undefined, "Transcript width", "The maximum width of the conversation.", "wide narrow"),
  e("appearance", "IDE view", "IDE view", "The layout of the IDE view.", "layout editor"),
  e("appearance", "IDE view", "Chat side", "The side of the window for the chat."),
  e("appearance", "IDE view", "Chat width", "The first width of the chat."),
  e("appearance", "IDE view", "Terminal height", "The first height of the terminal."),
  e("appearance", "Code appearance", "Code font", "The font of code blocks, the editor, and the terminal.", "monospace"),
  e("appearance", "Code appearance", "Custom code font", "The name of a font on this computer."),
  e("appearance", "Code appearance", "Light code theme", "The colors of the editor in the light theme.", "syntax highlighting"),
  e("appearance", "Code appearance", "Dark code theme", "The colors of the editor in the dark theme.", "syntax highlighting"),
  // Local models, Providers, Computers, Updates
  e("models", undefined, "Local models", "Run models on this computer.", "ollama llama gguf download"),
  e("connections", undefined, "Providers", "The model providers and their API keys.", "openai anthropic openrouter api key base url"),
  e("connections", undefined, "Add a provider", "Add a model provider.", "api key openai compatible"),
  e("computers", undefined, "Computers", "The daemons that Harness can connect to.", "remote ssh daemon"),
  e("computers", undefined, "Add a remote daemon", "Connect to a daemon on another computer.", "ssh remote"),
  e("updates", undefined, "Check for updates when the app opens", "Ask github.com for the newest version.", "update version"),
  e("updates", "Changelog", "Changelog", "What is new in each version.", "release notes"),
];

/** The words of a text, lowercase. */
const words = (text: string) => text.toLowerCase().split(/[^\p{L}\p{N}.+-]+/u).filter(Boolean);

/**
 * The settings that match a search, best first. Each word of the search must be in the label, the section,
 * the page name, the help, or the keywords. A label that starts with the search is first, then a label that
 * has it, then the other matches.
 */
export function searchSettings(query: string, index: SettingEntry[] = SETTINGS_INDEX): SettingEntry[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const terms = words(q);
  if (terms.length === 0) return [];
  const scored: { entry: SettingEntry; score: number; at: number }[] = [];
  index.forEach((entry, at) => {
    const label = entry.label.toLowerCase();
    const text = [label, entry.section, PAGE_LABELS[entry.page], entry.help, entry.keywords].filter(Boolean).join(" ").toLowerCase();
    if (!terms.every((t) => text.includes(t))) return;
    const score = label.startsWith(q) ? 0 : label.includes(q) ? 1 : terms.every((t) => label.includes(t)) ? 2 : 3;
    scored.push({ entry, score, at });
  });
  return scored.sort((a, b) => a.score - b.score || a.at - b.at).map((s) => s.entry);
}

/**
 * The element of a setting on its page: a setting label, a section heading, or a heading or button with the
 * text. The row of a setting label (or its block) is the element to show.
 */
export function findSetting(root: ParentNode, label: string): HTMLElement | null {
  const want = label.trim().toLowerCase();
  const selectors = [
    ".setting-text > label, .setting-text > .setting-label, .setting-block > .setting-label, .setting-block > label",
    ".settings-section, .settings-page-title, h2, h3, h4",
    "label, button, [role='tab']",
  ];
  for (const selector of selectors) {
    for (const el of root.querySelectorAll<HTMLElement>(selector)) {
      const text = (el.textContent ?? "").trim().toLowerCase();
      if (text === want || (selector !== selectors[0] && text.startsWith(want))) {
        return el.closest<HTMLElement>(".setting-row, .setting-block") ?? el;
      }
    }
  }
  return null;
}
