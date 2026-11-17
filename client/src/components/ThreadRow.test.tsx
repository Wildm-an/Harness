import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { HarnessItem, SessionSummary } from "../daemon/protocol";
import { compactAge, rowTime, threadStatus, workingDuration } from "../lib/threads";
import type { SessionActions, ThreadMenuInfo } from "./SessionRow";
import { ThreadRow, sessionAgent } from "./ThreadRow";

const NOW = 1_800_000_000;

const session = (extra: Partial<SessionSummary> = {}): SessionSummary => ({
  id: "s1",
  cwd: "/work/app",
  provider: "acp",
  model: "claude-acp",
  title: "Configuring a Custom Endpoint",
  created_at: NOW - 900,
  updated_at: NOW - 300,
  ...extra,
});

const noop = () => undefined;
const actions: SessionActions = { onResume: noop, onPin: noop, onArchive: noop, onMarkUnread: noop, onRename: noop, onDelete: noop };
const thread: ThreadMenuInfo = {
  snoozed: false,
  autoArchive: true,
  retitling: false,
  branch: null,
  path: "/work/app",
  onSnooze: noop,
  onWake: noop,
  onAutoArchive: noop,
  onRetitle: noop,
};
const agents = [{ id: "claude-acp", name: "Claude Agent", icon: null }] as unknown as HarnessItem[];

const render = (s: SessionSummary, extra: Partial<React.ComponentProps<typeof ThreadRow>> = {}) =>
  renderToStaticMarkup(
    <ThreadRow
      session={s}
      variant="card"
      action="settle"
      active={false}
      status={null}
      workingSince={null}
      unread={false}
      disabled={false}
      project="app"
      agent={sessionAgent(s, agents)}
      pr={null}
      now={NOW}
      actions={actions}
      thread={thread}
      canSnooze
      {...extra}
    />,
  );

describe("the time and status of a thread row (as T3 Code)", () => {
  it("shows a short age", () => {
    expect(compactAge(NOW - 20, NOW)).toBe("now");
    expect(compactAge(NOW - 5 * 60, NOW)).toBe("5m");
    expect(compactAge(NOW - 2 * 3600, NOW)).toBe("2h");
    expect(compactAge(NOW - 3 * 86400, NOW)).toBe("3d");
  });

  it("shows the time of work", () => {
    expect(workingDuration(42)).toBe("42s");
    expect(workingDuration(5 * 60 + 10)).toBe("5m");
    expect(workingDuration(80 * 60)).toBe("1h 20m");
  });

  it("gives the status of a session", () => {
    expect(threadStatus({ session_id: "s1", waiting: true }, false)).toBe("approval");
    expect(threadStatus({ session_id: "s1", waiting: false }, true)).toBe("working");
    expect(threadStatus(undefined, true)).toBe("done");
    expect(threadStatus(undefined, false)).toBeNull();
  });

  it("uses the settle time for a settled row", () => {
    expect(rowTime(session({ archived: true, archived_at: NOW - 60 }))).toBe(NOW - 60);
    expect(rowTime(session())).toBe(NOW - 300);
  });
});

describe("the agent of a row", () => {
  it("names the harness of an ACP session, and Harness with its model for the built-in loop", () => {
    expect(sessionAgent(session(), agents)).toMatchObject({ id: "claude-acp", name: "Claude Agent" });
    expect(sessionAgent(session({ provider: "fake", model: "test-model" }), agents)).toMatchObject({ id: "harness", name: "Harness" });
  });
});

describe("the card row", () => {
  it("shows the project, the age, the title, the agent, and the hover buttons", () => {
    const html = render(session());
    expect(html).toContain('class="thread-project">app<');
    expect(html).toContain('class="thread-time">5m<');
    expect(html).toContain("Configuring a Custom Endpoint");
    expect(html).toContain('aria-label="Snooze thread"');
    expect(html).toContain('aria-label="Settle thread"');
    expect(html).toContain("Settle</button>");
    // No branch and no PR: the agent icon is on the title line, and there is no third line.
    expect(html).not.toContain("thread-meta");
    expect(html).toContain("thread-agent");
  });

  it("shows the status in place of the age, and the branch on a third line", () => {
    const html = render(session({ branch: "claude/fix" }), { status: "working", workingSince: NOW - 70 });
    expect(html).toContain("thread-status working");
    expect(html).toContain("Working");
    expect(html).not.toContain('class="thread-time">5m<');
    expect(html).toContain('class="thread-branch">claude/fix<');
  });

  it("shows the pin of a pinned thread, with Unpin", () => {
    expect(render(session({ pinned: true }))).toContain('aria-label="Unpin thread"');
  });
});

describe("the slim row", () => {
  it("shows Un-settle on a settled row, and the settle age", () => {
    const html = render(session({ archived: true, archived_at: NOW - 6 * 3600 }), { variant: "slim", action: "unsettle", canSnooze: false });
    expect(html).toContain("thread-row slim");
    expect(html).toContain('aria-label="Un-settle thread"');
    expect(html).toContain('class="thread-time">6h<');
    expect(html).not.toContain("thread-project\"");
  });

  it("shows the wake time on a snoozed row, and Wake", () => {
    const html = render(session({ snoozed_until: NOW + 3600 }), { variant: "slim", action: "wake", canSnooze: false });
    expect(html).toContain("thread-wake");
    expect(html).toContain('aria-label="Wake thread now"');
  });
});
