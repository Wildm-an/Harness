import { describe, expect, it } from "vitest";
import { quitText } from "./QuitGuard";

describe("the warning before the app closes", () => {
  it("counts the sessions where the agent works", () => {
    expect(quitText(1)).toBe("The agent is working in 1 session. Quitting now will interrupt that work.");
    expect(quitText(3)).toBe("The agent is working in 3 sessions. Quitting now will interrupt that work.");
  });
});
