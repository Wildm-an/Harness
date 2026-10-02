"""Build the daemon sidecar for the desktop app installers (SPEC.md section 10, phase 13).

    .venv/Scripts/python scripts/build_sidecar.py      # Windows
    .venv/bin/python scripts/build_sidecar.py          # macOS and Linux

Steps:

1. npm installs the packages of the plugin host (plugin-host/), which go into the bundle.
2. PyInstaller makes the folder build/sidecar/dist/harness-daemon/ from packaging/harness-daemon.spec
   (onedir: the executable and its _internal folder).
3. The script runs the smoke test (scripts/smoke_sidecar.py). --no-smoke skips it.
4. The script copies the folder to client/src-tauri/binaries/harness-daemon/. The installers put it
   in the resource folder of the app (bundle.resources in tauri.bundle.json).

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


def folder_size(folder: Path) -> tuple[int, int]:
    """The number of files and the bytes in a folder."""
    files = [p for p in folder.rglob("*") if p.is_file()]
    return len(files), sum(p.stat().st_size for p in files)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--no-smoke", action="store_true", help="Do not run the smoke test.")
    args = parser.parse_args()

    try:
        import PyInstaller  # noqa: F401
    except ImportError:
        sys.exit('PyInstaller is not installed. Run: pip install -e ".[package]"')

    npm = shutil.which("npm")
    if npm is None:
        sys.exit("npm is not installed. The plugin host (plugin-host/) needs it for its packages.")
    # --ignore-scripts: the packages need no build step, and pnpm is plain JavaScript.
    subprocess.run([npm, "ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"], cwd=PLUGIN_HOST, check=True)

    subprocess.run([sys.executable, "-m", "PyInstaller", str(SPEC), "--noconfirm", "--clean",
                    "--distpath", str(DIST), "--workpath", str(WORK)], cwd=DAEMON / "packaging", check=True)
    folder = DIST / "harness-daemon"
    built = folder / f"harness-daemon{EXE_SUFFIX}"
    if not built.is_file():
        sys.exit(f"PyInstaller did not make {built}.")
    count, size = folder_size(folder)
    print(f"Built {folder} ({count} files, {size / 1e6:.0f} MB)", flush=True)

    if not args.no_smoke:
        subprocess.run([sys.executable, str(DAEMON / "scripts" / "smoke_sidecar.py"), str(built)], check=True)

    CLIENT_BINARIES.mkdir(parents=True, exist_ok=True)
    # The onefile sidecar of the versions before 0.1.27 (bundle.externalBin). The installers do not use it now.
    for old in CLIENT_BINARIES.glob(f"harness-daemon-*{EXE_SUFFIX}"):
        if old.is_file():
            old.unlink()
    target = CLIENT_BINARIES / "harness-daemon"
    if target.exists():
        shutil.rmtree(target)
    shutil.copytree(folder, target)
    print(f"Copied the sidecar to {target}")


if __name__ == "__main__":
    main()
