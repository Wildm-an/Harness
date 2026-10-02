import { describe, expect, it } from "vitest";
import type { PluginRow } from "../daemon/protocol";
import { isGitSource, rowLabel } from "./PluginsScreen";

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

