// Build the installer: `npm run package`. On Windows it builds only the NSIS installer.
//
// The update files (the .sig signature of the installer) need the private release key. The script
// reads it from TAURI_SIGNING_PRIVATE_KEY, or from the file in HARNESS_UPDATER_KEY, or from
// ~/.tauri/harness-updater.key. With no key, it builds the installer with no update files.
// See docs/RELEASE.md.

import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

// The wheel of the daemon: "Update daemon" sends it to a remote daemon (daemon/harness_daemon/update.py).
// The installer puts it in the resource folder (tauri.bundle.json).
const daemonDir = resolve("..", "daemon");
const wheelDir = resolve("src-tauri", "binaries", "daemon-wheel");
const venvPython = join(daemonDir, ".venv", process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
const python = existsSync(venvPython) ? venvPython : "python3";
rmSync(wheelDir, { recursive: true, force: true });
mkdirSync(wheelDir, { recursive: true });
const wheel = spawnSync(python, ["-m", "pip", "wheel", "--no-deps", "--wheel-dir", wheelDir, daemonDir], { stdio: "inherit" });
if (wheel.status !== 0) {
  console.error("The wheel of the daemon failed. See the pip output above.");
  process.exit(wheel.status ?? 1);
}

const env = { ...process.env };
const args = ["tauri", "build", "--config", "src-tauri/tauri.bundle.json"];
// The release key has no password. In CI, the key comes from a secret: GitHub accepts no empty secret.
env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD ??= "";

if (!env.TAURI_SIGNING_PRIVATE_KEY) {
  const keyFile = env.HARNESS_UPDATER_KEY || join(homedir(), ".tauri", "harness-updater.key");
  if (existsSync(keyFile)) {
    env.TAURI_SIGNING_PRIVATE_KEY = readFileSync(keyFile, "utf8").trim();
    console.log(`Signing the update files with ${keyFile}.`);
  } else {
    console.log("No release key: the build makes the installer with no update files.");
    args.push("--config", "src-tauri/tauri.nosign.json"); // A file: the shell of Windows breaks inline JSON.
  }
}

const result = spawnSync("npx", args, { stdio: "inherit", env, shell: process.platform === "win32" });
process.exit(result.status ?? 1);
