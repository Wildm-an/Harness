// Build the installer: `npm run package`. On Windows it builds only the NSIS installer.
//
// The update files (the .sig signature of the installer) need the private release key. The script
// reads it from TAURI_SIGNING_PRIVATE_KEY, or from the file in HARNESS_UPDATER_KEY, or from
// ~/.tauri/harness-updater.key. With no key, it builds the installer with no update files.
// See docs/RELEASE.md.

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const env = { ...process.env };
const args = ["tauri", "build", "--config", "src-tauri/tauri.bundle.json"];

if (!env.TAURI_SIGNING_PRIVATE_KEY) {
  const keyFile = env.HARNESS_UPDATER_KEY || join(homedir(), ".tauri", "harness-updater.key");
  if (existsSync(keyFile)) {
    env.TAURI_SIGNING_PRIVATE_KEY = readFileSync(keyFile, "utf8").trim();
    env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD ??= "";
    console.log(`Signing the update files with ${keyFile}.`);
  } else {
    console.log("No release key: the build makes the installer with no update files.");
    args.push("--config", "src-tauri/tauri.nosign.json"); // A file: the shell of Windows breaks inline JSON.
  }
}

const result = spawnSync("npx", args, { stdio: "inherit", env, shell: process.platform === "win32" });
process.exit(result.status ?? 1);
