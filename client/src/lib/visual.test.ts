import { afterEach, describe, expect, it } from "vitest";
import type { ChatItem } from "../chat/state";
import { groupTools } from "../components/MessageList";
import {
  frameHeight,
  frameMessage,
  isLoopback,
  isVisualItem,
  MAX_HEIGHT,
  MAX_PROMPT,
  MIN_HEIGHT,
  setVisualDaemon,
  themeVars,
  VISUAL_VARS,
  visualDocument,
  visualFrameUrl,
  visualOf,
} from "./visual";

type ToolItem = Extract<ChatItem, { kind: "tool" }>;

const SVG = '<svg viewBox="0 0 10 10"><circle cx="5" cy="5" r="3"/></svg>';
const tool = (over: Partial<ToolItem> = {}): ToolItem => ({
  kind: "tool",
  id: "v1",
  name: "show_visual",
  input: { title: "dot", code: SVG },
  status: "done",
  ...over,
});

describe("the visual of a show_visual call", () => {
  it("reads the title and the code", () => {
    expect(visualOf(tool())).toEqual({ id: "v1", title: "dot", code: SVG, loading: [] });
    expect(visualOf(tool({ input: { title: "dot", code: SVG, loading_messages: ["Drawing dots", 3, " "] } }))?.loading).toEqual(["Drawing dots"]);
    expect(visualOf(tool({ status: "running" }))?.code).toBe(SVG);
    expect(visualOf(tool({ input: { code: SVG } }))?.title).toBe("visual");
  });

  it("is null for a failed call, bad input, or another tool", () => {
    expect(visualOf(tool({ status: "error" }))).toBeNull();
    expect(visualOf(tool({ input: { title: "dot", code: "  " } }))).toBeNull();
    expect(visualOf(tool({ input: "not json" }))).toBeNull();
    expect(visualOf(tool({ name: "read" }))).toBeNull();
  });

  it("is its own chat item, not in a tool group; a failed call stays a tool row", () => {
    const read = tool({ id: "r1", name: "read", input: { path: "a.py" } });
    const shown = groupTools([read, tool(), { ...read, id: "r2" }]);
    expect(shown.map((i) => i.kind)).toEqual(["tools", "tool", "tools"]);
    expect(isVisualItem(tool({ status: "error" }))).toBe(false);
    expect(groupTools([read, tool({ status: "error" })]).map((i) => i.kind)).toEqual(["tools"]);
  });
});

describe("the document of a visual", () => {
  const theme = { theme: "dark" as const, vars: { "--color-text": "#faf9f5", "--color-accent": "#c6613f" } };

  it("has the theme variables, the helper script, and the code", () => {
    const doc = visualDocument(SVG, theme);
    expect(doc).toContain('<html data-theme="dark">');
    expect(doc).toContain("color-scheme: dark; --color-text: #faf9f5; --color-accent: #c6613f;");
    expect(doc).toContain("window.sendPrompt");
    expect(doc).toContain("harness-visual-size");
    expect(doc.indexOf(SVG)).toBeGreaterThan(doc.indexOf("</head>"));
  });

  it("does not let a variable value close the style", () => {
    const doc = visualDocument(SVG, { theme: "light", vars: { "--color-text": "red;}</style><script>x()</script>" } });
    expect(doc).not.toContain("</style><script>x()");
  });

  it("maps the app tokens to the visual variables", () => {
    const tokens: Record<string, string> = { "--text": " #111 ", "--accent-fill": "#c6613f" };
    const vars = themeVars({ getPropertyValue: (name: string) => tokens[name] ?? "" });
    expect(vars).toEqual({ "--color-text": "#111", "--color-accent": "#c6613f" });
    expect(Object.keys(VISUAL_VARS)).toContain("--font-sans");
  });
});

describe("the messages of a frame", () => {
  it("reads ready, size, and prompt", () => {
    expect(frameMessage({ type: "harness-visual-ready" })).toEqual({ kind: "ready" });
    expect(frameMessage({ type: "harness-visual-size", height: 120.4 })).toEqual({ kind: "size", height: 120.4 });
    expect(frameMessage({ type: "harness-visual-prompt", text: " Use option 2 " })).toEqual({ kind: "prompt", text: "Use option 2" });
    expect((frameMessage({ type: "harness-visual-prompt", text: "x".repeat(MAX_PROMPT + 9) }) as { text: string }).text).toHaveLength(MAX_PROMPT);
  });

  it("ignores other messages", () => {
    expect(frameMessage(null)).toBeNull();
    expect(frameMessage("harness-visual-ready")).toBeNull();
    expect(frameMessage({ type: "harness-visual-size", height: "9" })).toBeNull();
    expect(frameMessage({ type: "harness-visual-prompt", text: "  " })).toBeNull();
    expect(frameMessage({ type: "other" })).toBeNull();
  });

  it("keeps the height in limits", () => {
    expect(frameHeight(0)).toBe(MIN_HEIGHT);
    expect(frameHeight(180.2)).toBe(181);
    expect(frameHeight(1e9)).toBe(MAX_HEIGHT);
  });
});

describe("the frame page of the daemon", () => {
  afterEach(() => setVisualDaemon("", 0));

  it("comes from a loopback daemon only", () => {
    setVisualDaemon("127.0.0.1", 8765);
    expect(visualFrameUrl()).toBe("http://127.0.0.1:8765/visual-frame");
    setVisualDaemon("::1", 9000);
    expect(visualFrameUrl()).toBe("http://[::1]:9000/visual-frame");
    setVisualDaemon("192.168.1.20", 8765);
    expect(visualFrameUrl()).toBeNull();
  });

  it("knows the loopback hosts", () => {
    expect(["localhost", "127.0.0.1", "127.1.2.3", "[::1]", "LOCALHOST"].every(isLoopback)).toBe(true);
    expect(["example.com", "10.0.0.1", "127.0.0.1.evil.com"].some(isLoopback)).toBe(false);
  });
});
