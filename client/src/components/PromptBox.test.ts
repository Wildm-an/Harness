import { describe, expect, it } from "vitest";
import { commandLinks, draftOf, saveDraft, splitAttachmentLines, withAttachments } from "./PromptBox";
import type { CommandItem } from "../daemon/protocol";

describe("the unsent prompt of a session", () => {
  it("stays with the session where the user typed it", () => {
    saveDraft("a", "Fix the login page");
    saveDraft("b", "Add a test");
    expect(draftOf("a")).toBe("Fix the login page");
    expect(draftOf("b")).toBe("Add a test");
    expect(draftOf("c")).toBe("");
  });

  it("is removed when the box is empty", () => {
    saveDraft("a", "text");
    saveDraft("a", "");
    expect(draftOf("a")).toBe("");
  });
});

describe("a prompt with attached context", () => {
  const chip = { id: "a1", label: "Annotation 1", detail: "button.primary — Make it blue.", text: "\n[Browser annotation 1: x]\nNote: Make it blue.\n" };

  it("gives the agent the full text, and the chat the short text", () => {
    const s = withAttachments({ kind: "prompt", text: "Fix this" }, [chip]);
    expect(s).toEqual({
      kind: "prompt",
      text: "Fix this\n\n[Browser annotation 1: x]\nNote: Make it blue.",
      display: "Fix this\n[Annotation 1: button.primary — Make it blue.]",
    });
  });

  it("can go with no typed text", () => {
    expect(withAttachments({ kind: "prompt", text: "" }, [chip])).toMatchObject({ display: "[Annotation 1: button.primary — Make it blue.]" });
  });

  it("shows its attachments as chips in the chat", () => {
    const shown = withAttachments({ kind: "prompt", text: "Fix this" }, [chip, { ...chip, label: "Annotation 2", detail: "h1 — Bigger." }]);
    expect(splitAttachmentLines(shown.kind === "prompt" ? shown.display ?? "" : "")).toEqual({
      text: "Fix this",
      chips: [
        { label: "Annotation 1", detail: "button.primary — Make it blue." },
        { label: "Annotation 2", detail: "h1 — Bigger." },
      ],
    });
    expect(splitAttachmentLines("[Annotation 1: a — b]")).toEqual({ text: "", chips: [{ label: "Annotation 1", detail: "a — b" }] });
    // Other text in brackets stays text.
    expect(splitAttachmentLines("Look at [Note: this]")).toEqual({ text: "Look at [Note: this]", chips: [] });
  });

  it("changes nothing with no attachment", () => {
    expect(withAttachments({ kind: "prompt", text: "Hi" }, [])).toEqual({ kind: "prompt", text: "Hi" });
  });
});

describe("a skill name in the prompt shows as a link", () => {
  const item = (name: string, skill: boolean): CommandItem => ({
    name,
    description: `${name} text`,
    "argument-hint": "",
    source: skill ? "user" : "built-in",
    builtin: !skill,
    ...(skill ? { path: `/skills/${name}/SKILL.md` } : {}),
  });
  const commands = [item("ui-ux-pro-max", true), item("pdf-viewer:open", true), item("clear", false)];
  const links = (text: string) => commandLinks(text, commands).filter((p) => p.command).map((p) => p.text);

  it("marks a known skill at the start and in the middle of the prompt", () => {
    expect(links("/ui-ux-pro-max")).toEqual(["/ui-ux-pro-max"]);
    expect(links("Use /ui-ux-pro-max and /pdf-viewer:open now")).toEqual(["/ui-ux-pro-max", "/pdf-viewer:open"]);
  });

  it("keeps all the text in the parts", () => {
    const text = "Fix it\n/ui-ux-pro-max  please";
    expect(commandLinks(text, commands).map((p) => p.text).join("")).toBe(text);
  });

  it("marks a built-in command only at the start", () => {
    expect(links("/clear")).toEqual(["/clear"]);
    expect(links("then /clear")).toEqual([]);
  });

  it("does not mark a partial name, an unknown name, or a path", () => {
    expect(links("/ui-ux")).toEqual([]);
    expect(links("/nope")).toEqual([]);
    expect(links("see src/ui-ux-pro-max")).toEqual([]);
    expect(links("/ui-ux-pro-max/x")).toEqual([]);
  });

  it("has one plain part with no list", () => {
    expect(commandLinks("/ui-ux-pro-max", null)).toEqual([{ text: "/ui-ux-pro-max" }]);
  });
});
