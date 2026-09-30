import { describe, expect, it } from "vitest";
import type { PluginRow } from "../daemon/protocol";
import { dshBundle, isGitSource, rowLabel } from "./PluginsScreen";

describe("isGitSource", () => {
  it("finds git URLs, the same as the daemon", () => {
    expect(isGitSource("https://github.com/me/plugin.git")).toBe(true);
    expect(isGitSource("github:me/plugin#v1")).toBe(true);
    expect(isGitSource("git@github.com:me/plugin.git")).toBe(true);
    expect(isGitSource("C:\\plugins\\hello")).toBe(false);
    expect(isGitSource("/home/me/hello")).toBe(false);
  });
});

describe("rowLabel", () => {
  const row = (id: string, name: string) => ({ id, name }) as PluginRow;
  it("shows the module only when it is not the id", () => {
    expect(rowLabel(row("hello", "hello"))).toBe("hello");
    expect(rowLabel(row("hello-guard", "hello/guard"))).toBe("hello-guard (hello/guard)");
  });
});

describe("dshBundle", () => {
  it("maps a DeepSeek bundle to the shared list shape", () => {
    const bundle = dshBundle({
      name: "hello-dsh",
      version: "1.0.0",
      description: "A test.",
      dir: "/p",
      enabled: true,
      problem: null,
      client: true,
      rows: [
        { id: "hello", name: "hello-dsh", disabled: false, state: "active", error: null },
        { id: "gone", name: "hello-dsh/gone", disabled: false, state: "disposed", error: null },
      ],
    });
    expect(bundle.source).toBeNull();
    expect(bundle.problem).toMatch(/UI half/);
    expect(bundle.rows.map((r) => [r.id, r.state, r.bundle])).toEqual([
      ["hello", "active", "hello-dsh"],
      ["gone", "disabled", "hello-dsh"],
    ]);
    expect(bundle.rows[0].tools).toEqual([]);
  });
});
