import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ChatItem } from "../chat/state";
import { RewindDialog, rewindTargets } from "./RewindDialog";

describe("the Rewind dialog", () => {
  it("lists the messages of the user, not task notes or messages with no id", () => {
    const items: ChatItem[] = [
      { kind: "user", id: "1", text: "Fix the  login\nform", messageId: "m1" },
      { kind: "user", id: "2", text: "Background task ended: build", messageId: "m2", origin: "task" },
      { kind: "user", id: "3", text: "Not sent yet" },
      { kind: "user", id: "4", text: "Add tests", messageId: "m4" },
    ];
    expect(rewindTargets(items)).toEqual([
      { messageId: "m1", text: "Fix the login form" },
      { messageId: "m4", text: "Add tests" },
    ]);
  });

  it("shows the title, the help, and the messages, with the newest message selected", () => {
    const html = renderToStaticMarkup(
      <RewindDialog
        targets={[{ messageId: "m1", text: "First" }, { messageId: "m2", text: "Second" }]}
        onRewind={() => undefined}
        onClose={() => undefined}
      />,
    );
    expect(html).toContain(">Rewind</h2>");
    expect(html).toContain("Restore the session to an earlier message.");
    expect(html).toContain('aria-selected="false" class="rewind-item">First');
    expect(html).toContain('aria-selected="true" class="rewind-item selected">Second');
  });
});
