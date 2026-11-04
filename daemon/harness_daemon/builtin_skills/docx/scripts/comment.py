"""Add comments to a Word file. Each comment marks some text, as a review comment in Word does.

    python comment.py report.docx comments.json -o report-reviewed.docx --author "Harness"

comments.json is a list:

    [
      {"find": "revenue grew 40%", "text": "Add the source of this number."},
      {"find": "Q3", "text": "Is this Q3 of this year?", "occurrence": 2}
    ]

- "find" is text in one paragraph. Copy it exactly from the document.
- "occurrence" picks the Nth match (1 is the first).
- The script changes nothing if one comment fails.

Needs python-docx 1.2 or later (pip install -U python-docx).
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from docx import Document
from docx.text.paragraph import Paragraph
from docx.text.run import Run

sys.path.insert(0, str(Path(__file__).parent))
from wordxml import MatchError, pick_match, split_for_match  # noqa: E402


def add_comments(doc, comments: list[dict], author: str, initials: str) -> list[str]:
    if not hasattr(doc, "add_comment"):
        raise MatchError("This python-docx cannot add comments. Run: pip install -U python-docx")
    done = []
    for number, item in enumerate(comments, 1):
        find, text = item.get("find", ""), item.get("text", "")
        if not text:
            raise MatchError(f"Comment {number} has no 'text'.")
        try:
            p, start = pick_match(doc, find, int(item.get("occurrence", 1)))
        except MatchError as e:
            raise MatchError(f"Comment {number} failed: {e}") from None
        elements = split_for_match(p, start, len(find))
        paragraph = Paragraph(p, doc._body)
        runs = [Run(r, paragraph) for r in elements]
        doc.add_comment(runs, text=text, author=author, initials=initials)
        done.append(f"{number}. Comment on {find!r}: {text}")
    return done


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("file", type=Path)
    parser.add_argument("comments", type=Path, help="The JSON file with the list of comments.")
    parser.add_argument("-o", "--output", type=Path, help="The output file. Default: change the file in place.")
    parser.add_argument("--author", default="Harness")
    parser.add_argument("--initials", default="H")
    args = parser.parse_args()
    comments = json.loads(args.comments.read_text(encoding="utf-8"))
    if isinstance(comments, dict):
        comments = [comments]
    doc = Document(str(args.file))
    try:
        done = add_comments(doc, comments, args.author, args.initials)
    except MatchError as e:
        sys.exit(f"{e}\nThe script saved nothing.")
    out = args.output or args.file
    doc.save(str(out))
    print("\n".join(done))
    print(f"Saved {out} with {len(done)} comments by {args.author}.")


if __name__ == "__main__":
    main()
