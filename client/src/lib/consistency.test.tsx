import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { formatBytes } from "./bytes";
import { projectLabels } from "../components/SessionSearch";
import { workingStatus } from "../components/WorkingLine";
import { planOutcome } from "../components/PlanCard";
import { Switch } from "../components/Switch";
import { SecretInput } from "../components/SecretInput";
import type { ChatItem } from "../chat/state";
import type { ProjectItem, SessionSummary } from "../daemon/protocol";

describe("one formula for sizes (C13)", () => {
  it("uses powers of 1000 with one decimal", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(null)).toBe("0 B");
    expect(formatBytes(4_683_073_536)).toBe("4.7 GB");
    expect(formatBytes(1_000_000)).toBe("1 MB");
  });
});

describe("one word for one thing (C7)", () => {
  it("names a session folder as the sidebar does", () => {
    const session = (id: string, cwd: string) => ({ id, cwd, title: null, updated_at: 1 }) as unknown as SessionSummary;
    const project = (id: string, name: string, path: string) => ({ id, name, path }) as unknown as ProjectItem;
    const labels = projectLabels(
      [session("a", "C:/work/scratchpad/demo-project"), session("b", "C:/other/demo-project"), session("c", "C:/x/loose")],
      [project("p1", "Demo app", "C:/work/scratchpad/demo-project"), project("p2", "Demo app", "C:/other/demo-project")],
    );
    expect(labels.get("a")).toBe("Demo app · scratchpad");
    expect(labels.get("b")).toBe("Demo app · other");
    expect(labels.get("c")).toBe("loose");
  });

  it("says what runs with the words of the tool row", () => {
    const tool: ChatItem = { kind: "tool", id: "t", name: "bash", input: { command: "git status" }, status: "running" };
    expect(workingStatus([tool], "m").text).toBe("Running git status…");
  });

  it("names the mode of an accepted plan as the mode menu does", () => {
    expect(planOutcome({ kind: "plan", id: "p", plan: "", decision: "accept", mode: "default" })).toBe("Accepted · Manual");
    expect(planOutcome({ kind: "plan", id: "p", plan: "", decision: "accept", mode: "auto" })).toBe("Accepted · Auto");
  });
});

describe("shared controls (C3, C10)", () => {
  it("labels a switch with its name, not its state", () => {
    const html = renderToStaticMarkup(<Switch checked label="openai" onChange={() => {}} />);
    expect(html).toContain('aria-label="openai"');
    expect(html).toContain('aria-checked="true"');
  });

  it("hides a secret and offers to show it", () => {
    const html = renderToStaticMarkup(<SecretInput what="the token" value="abc" onChange={() => {}} />);
    expect(html).toContain('type="password"');
    expect(html).toContain('aria-label="Show the token"');
  });
});
