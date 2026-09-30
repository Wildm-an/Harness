"""Build the daemon sidecar for the desktop app installers (SPEC.md section 10, phase 13).

    .venv/Scripts/python scripts/build_sidecar.py      # Windows
    .venv/bin/python scripts/build_sidecar.py          # macOS and Linux

Steps:

1. npm installs the packages of the plugin host (plugin-host/), which go into the bundle.
2. PyInstaller makes one executable from packaging/harness-daemon.spec.
3. The script runs the smoke test (scripts/smoke_sidecar.py). --no-smoke skips it.
4. The script copies the executable to client/src-tauri/binaries/harness-daemon-<target triple>,
   the name that Tauri expects for bundle.externalBin.

PyInstaller cannot cross-compile. Build on each operating system and CPU type.
The venv needs the "package" extra: pip install -e ".[package]".
"""

from __future__ import annotations

import argparse
import os
import shutil
import subprocess
import sys
from pathlib import Path

DAEMON = Path(__file__).resolve().parent.parent
PLUGIN_HOST = DAEMON.parent / "plugin-host"
CLIENT_BINARIES = DAEMON.parent / "client" / "src-tauri" / "binaries"
SPEC = DAEMON / "packaging" / "harness-daemon.spec"
DIST = DAEMON / "build" / "sidecar" / "dist"
WORK = DAEMON / "build" / "sidecar" / "work"
EXE_SUFFIX = ".exe" if os.name == "nt" else ""


def host_triple() -> str:
    """The Rust target triple of this computer, for example x86_64-pc-windows-msvc."""
    try:
        out = subprocess.run(["rustc", "-vV"], capture_output=True, text=True, check=True).stdout
    except (OSError, subprocess.CalledProcessError) as e:
        sys.exit(f"rustc was not found ({e}). Install Rust, or give the triple with --target.")
    for line in out.splitlines():
        if line.startswith("host:"):
            return line.split(":", 1)[1].strip()
    sys.exit("rustc -vV did not show the host triple. Give the triple with --target.")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--target", help="The Rust target triple for the file name. Default: the rustc host.")
    parser.add_argument("--no-smoke", action="store_true", help="Do not run the smoke test.")
    args = parser.parse_args()

    try:
        import PyInstaller  # noqa: F401
    except ImportError:
        sys.exit('PyInstaller is not installed. Run: pip install -e ".[package]"')
    triple = args.target or host_triple()

    npm = shutil.which("npm")
    if npm is None:
        sys.exit("npm is not installed. The plugin host (plugin-host/) needs it for its packages.")
    # --ignore-scripts: the packages need no build step, and pnpm is plain JavaScript.
    subprocess.run([npm, "ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"], cwd=PLUGIN_HOST, check=True)

    subprocess.run([sys.executable, "-m", "PyInstaller", str(SPEC), "--noconfirm", "--clean",
                    "--distpath", str(DIST), "--workpath", str(WORK)], cwd=DAEMON / "packaging", check=True)
    built = DIST / f"harness-daemon{EXE_SUFFIX}"
    if not built.is_file():
        sys.exit(f"PyInstaller did not make {built}.")
    print(f"Built {built} ({built.stat().st_size / 1e6:.0f} MB)", flush=True)

    if not args.no_smoke:
        subprocess.run([sys.executable, str(DAEMON / "scripts" / "smoke_sidecar.py"), str(built)], check=True)

    CLIENT_BINARIES.mkdir(parents=True, exist_ok=True)
    target = CLIENT_BINARIES / f"harness-daemon-{triple}{EXE_SUFFIX}"
    shutil.copy2(built, target)
    print(f"Copied the sidecar to {target}")


if __name__ == "__main__":
    main()
