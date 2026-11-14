"""Write the transcript of a session as JSON: all messages and the run records (harness_daemon/transcript.py).

    python scripts/export_transcript.py --session <id> [--db <path>] [--no-content] [--out <file>]

The script opens the database read-only, so it can run next to a running daemon. --no-content removes the
message text, the tool arguments, and the tool output: use it for a bug report. A full transcript can hold
secrets that a command printed.
"""

from __future__ import annotations

import argparse
import json
import sqlite3
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from harness_daemon.config import harness_home  # noqa: E402
from harness_daemon.storage import Storage  # noqa: E402
from harness_daemon.transcript import export_transcript  # noqa: E402


class ReadOnlyStorage(Storage):
    """The read methods of Storage on a read-only connection: the schema script does not run."""

    def __init__(self, path: Path):  # noqa: D107 - no call to Storage.__init__, which writes the schema.
        self.db = sqlite3.connect(f"file:{path.as_posix()}?mode=ro", uri=True)
        self.db.row_factory = sqlite3.Row


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--session", required=True, help="The session id (or the start of it).")
    parser.add_argument("--db", default=None, help="The database. Default: ~/.harness/harness.db.")
    parser.add_argument("--no-content", action="store_true", help="Leave out the text, the arguments, and the output.")
    parser.add_argument("--out", default=None, help="The output file. Default: standard output.")
    args = parser.parse_args()
    path = Path(args.db) if args.db else harness_home() / "harness.db"
    storage = ReadOnlyStorage(path)
    matches = [r[0] for r in storage.db.execute("SELECT id FROM sessions WHERE id LIKE ?", (args.session + "%",))]
    if len(matches) != 1:
        print(f"{len(matches)} sessions match {args.session!r}. Give more of the id.", file=sys.stderr)
        return 1
    text = json.dumps(export_transcript(storage, matches[0], content=not args.no_content), ensure_ascii=False, indent=1)
    if args.out:
        Path(args.out).write_text(text, encoding="utf-8")
    else:
        sys.stdout.write(text + "\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
