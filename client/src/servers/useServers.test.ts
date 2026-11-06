import { describe, expect, it } from "vitest";
import { isLaunchFile } from "./useServers";
import { serversText } from "../components/QuitGuard";

describe("the server list", () => {
  it("loads again after a change of launch.json", () => {
    expect(isLaunchFile(".harness/launch.json")).toBe(true);
    expect(isLaunchFile(".harness\\launch.json")).toBe(true);
    expect(isLaunchFile("app/.harness/launch.json")).toBe(true);
    expect(isLaunchFile("launch.json")).toBe(false);
    expect(isLaunchFile(".vscode/launch.json")).toBe(false);
  });
});

describe("the question about the servers of the agent", () => {
  it("names the servers", () => {
    expect(serversText(["web"])).toBe("The agent started a server (web). They keep running while Harness is in the tray.");
    expect(serversText(["a", "b", "c", "d", "e"])).toBe("The agent started 5 servers (a, b, c, and 2 more). They keep running while Harness is in the tray.");
  });
});
