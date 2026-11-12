import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ServerItem } from "../daemon/protocol";
import { SessionRail } from "./SessionRail";

// The pull request store uses useSyncExternalStore with no server snapshot.
vi.mock("../lib/pr", async (load) => ({ ...(await load<typeof import("../lib/pr")>()), usePrInfos: () => ({}), usePrRefresh: () => undefined }));

const server = (name: string, state: ServerItem["state"]): ServerItem => ({
  name,
  state,
  port: state === "running" ? 5173 : null,
  url: state === "running" ? "http://localhost:5173" : null,
  command: "npm run dev",
  cwd: ".",
  default: false,
});

const render = (servers: ServerItem[]) =>
  renderToStaticMarkup(
    <SessionRail
      sessionId="s1"
      changes={null}
      onChangesAction={null}
      browser={null}
      onShowBrowser={() => undefined}
      browserTabs={() => []}
      onPickBrowserTab={() => undefined}
      onCloseBrowser={null}
      environment={{ placeKind: "local", place: "This computer", placeDetail: null, folder: "app", path: "/app", branch: null, worktree: null, worktreeOption: false }}
      context={null}
      usage={null}
      onReadUsage={() => undefined}
      running={false}
      onCompact={() => undefined}
      pr={null}
      sessionPrs={[]}
      onOpenPr={() => undefined}
      servers={servers}
      onOpenServer={() => undefined}
      onShowServers={() => undefined}
      onStopServer={() => undefined}
      connectors={null}
      mcpServers={null}
      onShowConnectors={() => undefined}
      tasks={[]}
      onShowTasks={() => undefined}
      keepAwake={false}
      onKeepAwake={() => undefined}
      keepAwakeDisabled={false}
      onClose={() => undefined}
    />,
  );

describe("the Servers section of the session rail", () => {
  it("shows a stop button for a running or starting server only", () => {
    const html = render([server("web", "running"), server("api", "starting"), server("docs", "stopped"), server("db", "crashed")]);
    expect(html).toContain('aria-label="Stop web"');
    expect(html).toContain('aria-label="Stop api"');
    expect(html).not.toContain('aria-label="Stop docs"');
    expect(html).not.toContain('aria-label="Stop db"');
  });
});
