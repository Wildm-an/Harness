// Tests of the profile paths: the profile uses the full path of its home folder.
//   node --test test/

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { Profile, fullPath } from "../src/profile.mjs";

describe("profile paths", () => {
  it("gives the full path of a folder that does not exist yet", () => {
    const base = fullPath(tmpdir());
    assert.equal(fullPath(join(tmpdir(), "harness-new", "profile")), join(base, "harness-new", "profile"));
  });

  // GitHub runners give the temp folder with a short name (C:\Users\RUNNER~1). pnpm uses the long
  // name: with the short name, a build script stayed pending, with no question and no run.
  it("uses the long name of a Windows short (8.3) name", { skip: process.platform !== "win32" }, (t) => {
    const parent = mkdtempSync(join(fullPath(tmpdir()), "harness-"));
    const long = join(parent, "a folder with a long name");
    mkdirSync(long);
    try {
      const short = execFileSync("cmd", ["/d", "/s", "/c", `"for %I in ("${long}") do @echo %~sI"`], {
        encoding: "utf8",
        windowsVerbatimArguments: true, // cmd reads its own quotes.
      }).trim();
      if (short.toLowerCase() === long.toLowerCase()) return t.skip("this drive makes no short names");
      assert.equal(fullPath(short), long);
      assert.equal(new Profile(join(short, "profile")).home, join(long, "profile"));
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });
});
