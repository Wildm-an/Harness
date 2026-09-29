// The DeepSeek peer gate (app-boot plugin-compatibility.ts): only @deepseek-ai/dsh and
// @deepseek-ai/dsh-* peers, semver.satisfies with includePrerelease, "workspace:*" passes.
import semver from "semver";
import { readFileSync } from "node:fs";

const runtime = process.argv[3] ?? "0.2.0-rc.2";
const survey = JSON.parse(readFileSync(process.argv[2], "utf8"));
const out = {};
for (const r of survey) {
  const failed = Object.entries(r.peers ?? {})
    .filter(([name]) => name === "@deepseek-ai/dsh" || name.startsWith("@deepseek-ai/dsh-"))
    .filter(([, range]) => !range.startsWith("workspace:") && !semver.satisfies(runtime, range, { includePrerelease: true }))
    .map(([name, range]) => `${name}@${range}`);
  out[r.name] = failed;
}
console.log(JSON.stringify(out, null, 1));
