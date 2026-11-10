import { describe, expect, it } from "vitest";
import { addErrorToast, errorKind, errorRoute, MAX_ERROR_TOASTS, type ErrorToastItem } from "./errorRoute";
import { addNotice, chatReducer, emptyChat, type ChatItem } from "../chat/state";
import { retryTarget } from "../components/MessageList";

describe("errorRoute", () => {
  it("sends an error of a turn and of a chat request to the chat", () => {
    expect(errorRoute(undefined)).toBe("chat");
    expect(errorRoute("prompt")).toBe("chat");
    expect(errorRoute("command")).toBe("chat");
    expect(errorRoute("session.rewind")).toBe("chat");
  });

  it("keeps an error of a background request out of the chat", () => {
    expect(errorRoute("git.status")).toBe("quiet");
    expect(errorRoute("git.changes")).toBe("quiet");
    expect(errorRoute("fs.find")).toBe("quiet");
  });

  it("leaves an error to the view that shows it", () => {
    expect(errorRoute("git.diff")).toBe("view");
    expect(errorRoute("fs.read")).toBe("view");
    expect(errorRoute("harnesses.list")).toBe("view");
    expect(errorRoute("memory.save")).toBe("view");
    expect(errorRoute("serve.start")).toBe("view");
  });

  it("shows all other errors in a popup", () => {
    expect(errorRoute("session.delete")).toBe("toast");
    expect(errorRoute("routines.run")).toBe("toast");
    expect(errorRoute("server.start")).toBe("toast"); // Not "serve.": the dev servers have no view for errors.
    expect(errorRoute("a.new.request")).toBe("toast");
  });
});

describe("errorKind", () => {
  it("gives the titles of rule M18", () => {
    expect(errorKind("The model endpoint returned HTTP 429: Too Many Requests").title).toBe("Rate limited");
    expect(errorKind("The model endpoint returned HTTP 503: overloaded").title).toBe("Service is busy");
    expect(errorKind("The model endpoint rejected the request: the prompt exceeds the context window").title).toBe("Your context window is full");
    expect(errorKind("Cannot connect to the model endpoint at http://127.0.0.1:11434.").title).toBe("Turn failed");
  });

  it("offers no retry when the same prompt cannot get a reply", () => {
    expect(errorKind("Cannot connect to the model endpoint at x.").retry).toBe(true);
    expect(errorKind("The context summary failed: timeout")).toEqual({ title: "Compaction failed", retry: false });
    expect(errorKind("A UserPromptSubmit hook blocked the prompt: no").retry).toBe(false);
    expect(errorKind("maximum context length is 8192 tokens").retry).toBe(false);
  });
});

describe("addErrorToast", () => {
  it("counts the same text and does not add a second popup", () => {
    let list: ErrorToastItem[] = [];
    list = addErrorToast(list, "No session.", 1);
    list = addErrorToast(list, "No session.", 2);
    expect(list).toEqual([{ id: 1, text: "No session.", count: 2 }]);
  });

  it("keeps the newest popups", () => {
    let list: ErrorToastItem[] = [];
    for (let i = 1; i <= MAX_ERROR_TOASTS + 2; i++) list = addErrorToast(list, `Error ${i}`, i);
    expect(list.map((t) => t.id)).toEqual([3, 4, 5]);
  });
});

describe("errors in the chat", () => {
  const start = chatReducer(emptyChat, { type: "user", text: "hi", startsTurn: true });

  it("shows the same notice one time, with a count", () => {
    let items: ChatItem[] = [];
    items = addNotice(items, "error", "Failed.");
    items = addNotice(items, "error", "Failed.");
    items = addNotice(items, "error", "Failed.");
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: "notice", text: "Failed.", count: 3 });
    expect(addNotice(items, "warning", "Failed.")).toHaveLength(2); // Another level is another notice.
  });

  it("marks the error of a failed turn, and not the error of a request", () => {
    const turn = chatReducer(start, { type: "daemon", msg: { type: "error", message: "The model stream failed: x" } });
    expect(turn.items.at(-1)).toMatchObject({ kind: "notice", level: "error", turn: true });
    const request = chatReducer(start, { type: "daemon", msg: { type: "error", message: "No session.", ref: "prompt" } });
    expect(request.items.at(-1)).not.toHaveProperty("turn");
  });

  it("offers Try again only on the last turn error, with no later message of the user", () => {
    const failed = chatReducer(start, { type: "daemon", msg: { type: "error", message: "The model stream failed: x" } });
    const id = failed.items.at(-1)!.id;
    expect(retryTarget(failed.items)).toBe(id);
    const next = chatReducer(failed, { type: "user", text: "again", startsTurn: true });
    expect(retryTarget(next.items)).toBeNull();
    const full = chatReducer(start, { type: "daemon", msg: { type: "error", message: "maximum context length is 8192 tokens" } });
    expect(retryTarget(full.items)).toBeNull();
  });
});
