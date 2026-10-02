"""Make latest.json, the update file of the Tauri updater, from the signed installers of a release.

    python latest_json.py <folder> <tag> <owner/repo>

The folder has the installers of all platforms and their .sig files (the release job of
.github/workflows/release.yml downloads them). The script writes <folder>/latest.json. The
installed apps read it at https://github.com/<owner/repo>/releases/latest/download/latest.json
(plugins.updater.endpoints in client/src-tauri/tauri.conf.json).

The update file of each platform:
- Windows: Harness_<version>_x64-setup.exe (the NSIS installer).
- macOS: Harness_<version>_<arch>.app.tar.gz (the workflow renames Harness.app.tar.gz, because
  the arm64 and the x64 jobs make the same file name).
- Linux: Harness_<version>_amd64.AppImage.
"""

from __future__ import annotations

import json
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

ARCH = {"x64": "x86_64", "x86_64": "x86_64", "amd64": "x86_64", "arm64": "aarch64", "aarch64": "aarch64"}
PATTERNS = [
    ("windows", re.compile(r"_(x64|arm64)-setup\.exe$")),
    ("darwin", re.compile(r"_(x64|x86_64|arm64|aarch64)\.app\.tar\.gz$")),
    ("linux", re.compile(r"_(amd64|x86_64|aarch64|arm64)\.AppImage$")),
]


def platform_of(name: str) -> str | None:
    """The updater platform of an update file, for example "windows-x86_64". None for other files."""
    for os_name, pattern in PATTERNS:
        match = pattern.search(name)
        if match:
            return f"{os_name}-{ARCH[match.group(1)]}"
    return None


def latest_json(folder: Path, tag: str, repo: str, now: datetime | None = None) -> dict:
    platforms = {}
    for sig in sorted(folder.glob("*.sig")):
        name = sig.name[: -len(".sig")]
        platform = platform_of(name)
        if platform is None or not (folder / name).is_file():
            continue
        platforms[platform] = {
            "signature": sig.read_text(encoding="utf-8").strip(),
            "url": f"https://github.com/{repo}/releases/download/{tag}/{name}",
        }
    if not platforms:
        raise SystemExit(f"No signed update file in {folder}. Check the TAURI_SIGNING_PRIVATE_KEY secret.")
    return {
        "version": tag.removeprefix("v"),
        "notes": f"See https://github.com/{repo}/releases/tag/{tag}",
        "pub_date": (now or datetime.now(timezone.utc)).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "platforms": platforms,
    }


def main() -> None:
    if len(sys.argv) != 4:
        raise SystemExit(__doc__)
    folder, tag, repo = Path(sys.argv[1]), sys.argv[2], sys.argv[3]
    data = latest_json(folder, tag, repo)
    (folder / "latest.json").write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")
    print(f"Wrote {folder / 'latest.json'}: {', '.join(sorted(data['platforms']))}")


if __name__ == "__main__":
    main()
