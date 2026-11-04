import { describe, expect, it } from "vitest";
import type { ServerItem } from "../daemon/protocol";
import { pendingServerApprovals, serversToOpen, stillWaiting } from "./ServerBlock";

const server = (name: string, state: ServerItem["state"], url: string | null): ServerItem => ({
  name, state, url, port: 1420, command: "npm run dev", cwd: ".", default: false,
});

describe("the dev server block of an empty tab", () => {
  it("opens a server that the user started, when it runs", () => {
    const list = [server("web", "running", "http://127.0.0.1:1420"), server("api", "starting", null), server("docs", "running", "http://127.0.0.1:3000")];
    expect(serversToOpen(["web", "api"], list).map((s) => s.name)).toEqual(["web"]);
    expect(serversToOpen([], list)).toEqual([]);
  });
});

describe("the servers that the block waits for", () => {
  it("keeps a server that is still stopped just after the click", () => {
    expect(stillWaiting(["web"], new Set(), [server("web", "stopped", null)])).toEqual(["web"]);
  });

  it("drops a server that runs, crashes, or stops after it was starting", () => {
    expect(stillWaiting(["web"], new Set(["web"]), [server("web", "starting", null)])).toEqual(["web"]);
    expect(stillWaiting(["web"], new Set(["web"]), [server("web", "running", "http://x")])).toEqual([]);
    expect(stillWaiting(["web"], new Set(["web"]), [server("web", "crashed", null)])).toEqual([]);
    expect(stillWaiting(["web"], new Set(["web"]), [server("web", "stopped", null)])).toEqual([]);
  });
});

describe("the server questions of the chat", () => {
  it("lists the open questions before a server start", () => {
    const items = [
      { kind: "permission" as const, id: "r1", tool: "server", input: { name: "web", command: "npm run dev" }, diff: null, rule: "server(npm run dev)" },
      { kind: "permission" as const, id: "r2", tool: "server", input: { name: "api", command: "x" }, diff: null, rule: null, decision: "deny" as const },
      { kind: "permission" as const, id: "r3", tool: "bash", input: { command: "ls" }, diff: null, rule: null },
    ];
    expect(pendingServerApprovals(items)).toEqual([{ requestId: "r1", name: "web", command: "npm run dev", rule: "server(npm run dev)" }]);
  });
});

describe("a server that runs before its URL is known", () => {
  it("stays in the list until the URL comes", () => {
    expect(stillWaiting(["web"], new Set(["web"]), [server("web", "running", null)])).toEqual(["web"]);
  });
});
