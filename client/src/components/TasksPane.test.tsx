import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { TaskItem } from "../daemon/protocol";
import { TasksPane } from "./TasksPane";

const task = (id: string, status: TaskItem["status"], started_at: number): TaskItem => ({
  id,
  command: `cmd ${id}`,
  description: `Task ${id}`,
  status,
  started_at,
  ended_at: status === "running" ? null : started_at + 1,
  returncode: status === "done" ? 0 : null,
});

const render = (items: TaskItem[]) =>
  renderToStaticMarkup(<TasksPane items={items} detail={null} onRequest={() => undefined} onOpen={() => undefined} onStop={() => undefined} />);

describe("the Background tasks pane", () => {
  it("lists the running tasks, and puts the finished tasks in a folded group", () => {
    const html = render([task("r1", "running", 1), task("d1", "done", 2), task("f1", "failed", 3)]);
    expect(html).toContain("Task r1");
    expect(html).toContain('aria-expanded="false"');
    expect(html).toMatch(/Finished<\/span><span class="tasks-finished-count">2</);
    expect(html).not.toContain("Task d1");
    expect(html).not.toContain("Task f1");
  });

  it("shows no Finished group when no task ended", () => {
    expect(render([task("r1", "running", 1)])).not.toContain("Finished");
  });
});
