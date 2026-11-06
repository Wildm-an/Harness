import { describe, expect, it } from "vitest";
import { folderTones, gitTone } from "./gitStatus";

describe("the git colors of the file tree", () => {
  it("groups the states into tones", () => {
    expect(gitTone("modified")).toBe("modified");
    expect(gitTone("renamed")).toBe("modified");
    expect(gitTone("added")).toBe("added");
    expect(gitTone("untracked")).toBe("added");
    expect(gitTone("deleted")).toBe("deleted");
    expect(gitTone("conflict")).toBe("conflict");
  });

  it("gives each folder the strongest tone of its files", () => {
    const tones = folderTones({
      "client/src/a.ts": "modified",
      "client/new.ts": "untracked",
      "docs/new.md": "added",
      "daemon/x.py": "conflict",
      "daemon/y.py": "modified",
      "old/gone.txt": "deleted",
      "top.txt": "modified",
    });
    expect(tones.get("client")).toBe("modified");
    expect(tones.get("client/src")).toBe("modified");
    expect(tones.get("docs")).toBe("added");
    expect(tones.get("daemon")).toBe("conflict");
    expect(tones.get("old")).toBe("modified");
    expect(tones.has("top.txt")).toBe(false);
  });
});
