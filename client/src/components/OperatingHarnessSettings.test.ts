import { describe, expect, it } from "vitest";
import type { HarnessItem, UserSettings } from "../daemon/protocol";
import { BUILTIN_HARNESS, currentHarness, filterHarnesses, sortHarnesses, splitHarnesses } from "./OperatingHarnessSettings";

const harness = (id: string, name: string, extra: Partial<HarnessItem> = {}): HarnessItem => ({
  id,
  name,
  description: "",
  website: "",
  license: "MIT",
  command: `${id} acp`,
  status: "missing",
  detail: "",
  custom: false,
  recommended: null,
  reason: "",
  local_models: false,
  ...extra,
});

describe("the Operating Harness page", () => {
  it("uses the built-in loop when the setting has no value", () => {
    expect(currentHarness(null)).toBe(BUILTIN_HARNESS);
    expect(currentHarness({ operating_harness: null } as UserSettings)).toBe(BUILTIN_HARNESS);
    expect(currentHarness({ operating_harness: "opencode" } as UserSettings)).toBe("opencode");
  });

  it("sorts by name, with the custom harnesses last", () => {
    const items = [harness("zed", "zeta"), harness("custom-a", "Alpha", { custom: true }), harness("goose", "goose"), harness("amp", "Amp")];
    expect(sortHarnesses(items).map((h) => h.id)).toEqual(["amp", "goose", "zed", "custom-a"]);
  });

  it("puts the recommended harnesses first, in the order of the daemon", () => {
    const items = [
      harness("amp", "Amp"),
      harness("omp", "Oh My Pi", { recommended: 1 }),
      harness("custom-a", "Alpha", { custom: true }),
      harness("opencode", "OpenCode", { recommended: 0 }),
      harness("bob", "Bob"),
    ];
    const { recommended, others } = splitHarnesses(items);
    expect(recommended.map((h) => h.id)).toEqual(["opencode", "omp"]);
    expect(others.map((h) => h.id)).toEqual(["amp", "bob", "custom-a"]);
  });

  it("finds each word in the name, the description, or the command", () => {
    const items = [
      harness("opencode", "OpenCode", { description: "It can use local models." }),
      harness("omp", "Oh My Pi", { command: "omp --mode acp" }),
    ];
    expect(filterHarnesses(items, "").length).toBe(2);
    expect(filterHarnesses(items, "local").map((h) => h.id)).toEqual(["opencode"]);
    expect(filterHarnesses(items, "PI mode").map((h) => h.id)).toEqual(["omp"]);
    expect(filterHarnesses(items, "nothing")).toEqual([]);
  });
});
