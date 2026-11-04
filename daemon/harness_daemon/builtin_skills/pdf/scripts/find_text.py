"""Find text in a PDF and give its position on the page. Use it to place text on a form that has no fields.

    python find_text.py form.pdf "Name:"               # each match, on all pages
    python find_text.py form.pdf "Date" --page 2
    python find_text.py form.pdf --words --page 1      # all words of page 1 with positions
    python find_text.py form.pdf --lines --page 1      # the horizontal lines (fill-in lines) of page 1

Positions are in points (1/72 inch) from the TOP-LEFT corner of the page:
x0 and x1 are the left and right edges, top and bottom are the upper and lower edges.
overlay_text.py uses the same positions.

Needs pdfplumber (pip install pdfplumber).
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

try:
    import pdfplumber
except ImportError:
    sys.exit("find_text.py needs pdfplumber: python -m pip install pdfplumber")


def _box(item) -> dict:
    return {k: round(float(item[k]), 1) for k in ("x0", "x1", "top", "bottom")}


def find(path: Path, query: str, page_number: int | None) -> list[dict]:
    """Matches of the query, also when it spans more than one word."""
    results = []
    target = query.split()
    with pdfplumber.open(str(path)) as pdf:
        pages = [pdf.pages[page_number - 1]] if page_number else pdf.pages
        for page in pages:
            words = page.extract_words(keep_blank_chars=False, use_text_flow=True)
            texts = [w["text"] for w in words]
            for i in range(len(words)):
                window = texts[i:i + len(target)]
                if len(window) < len(target):
                    break
                joined = " ".join(window)
                if (len(target) == 1 and target[0].lower() in joined.lower()) or joined.lower() == " ".join(target).lower():
                    span = words[i:i + len(target)]
                    results.append({
                        "page": page.page_number, "text": joined,
                        "x0": round(min(w["x0"] for w in span), 1), "x1": round(max(w["x1"] for w in span), 1),
                        "top": round(min(w["top"] for w in span), 1), "bottom": round(max(w["bottom"] for w in span), 1),
                        "page_width": round(float(page.width), 1), "page_height": round(float(page.height), 1),
                    })
    return results


def words(path: Path, page_number: int) -> list[dict]:
    with pdfplumber.open(str(path)) as pdf:
        page = pdf.pages[page_number - 1]
        return [{"text": w["text"], **_box(w)} for w in page.extract_words()]


def lines(path: Path, page_number: int) -> list[dict]:
    """Horizontal lines and thin rectangles: the places where a person writes on a paper form."""
    with pdfplumber.open(str(path)) as pdf:
        page = pdf.pages[page_number - 1]
        found = []
        for item in list(page.lines) + list(page.rects):
            width = float(item["x1"]) - float(item["x0"])
            height = float(item["bottom"]) - float(item["top"])
            if width > 20 and height < 3:
                found.append(_box(item))
        return sorted(found, key=lambda b: (b["top"], b["x0"]))


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("file", type=Path)
    parser.add_argument("query", nargs="?", help="The text to find. Case does not matter.")
    parser.add_argument("--page", type=int, help="Only this page (1 is the first).")
    parser.add_argument("--words", action="store_true", help="List all words of --page with positions.")
    parser.add_argument("--lines", action="store_true", help="List the horizontal lines of --page.")
    args = parser.parse_args()
    if args.words or args.lines:
        if not args.page:
            sys.exit("--words and --lines need --page.")
        data = words(args.file, args.page) if args.words else lines(args.file, args.page)
    elif args.query:
        data = find(args.file, args.query, args.page)
        if not data:
            sys.exit(f"The text {args.query!r} is not in the PDF. If the PDF is a scan, it has no text: use OCR.")
    else:
        sys.exit("Give the text to find, or --words or --lines with --page.")
    print(json.dumps(data, indent=1, ensure_ascii=False))


if __name__ == "__main__":
    main()
