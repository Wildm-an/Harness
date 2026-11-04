"""Write text on the pages of a PDF, at exact positions. Use it for forms that have no fillable fields.

    python overlay_text.py form.pdf entries.json -o filled.pdf

entries.json is a list. Positions are in points from the TOP-LEFT corner, as find_text.py gives them:

    [
      {"page": 1, "x": 152, "top": 118, "text": "Ana Silva"},
      {"page": 1, "x": 152, "top": 142, "text": "2026-11-04", "size": 10},
      {"page": 2, "x": 71, "top": 300, "text": "X", "size": 12, "bold": true},
      {"page": 2, "x": 71, "top": 400, "text": "Line one\\nLine two", "color": "1F3864"}
    ]

- "top" is the upper edge of the text. Use the "top" of the label, or the "top" of a fill-in line minus the size.
- "size" is the font size in points (default 10). "bold" uses Helvetica-Bold.
- "\\n" starts a new line.
- The text uses Helvetica, which has Latin characters only. For other scripts, give "font": a path to a .ttf file.

Needs pypdf and reportlab (pip install pypdf reportlab).
"""

from __future__ import annotations

import argparse
import io
import json
import sys
from pathlib import Path

from pypdf import PdfReader, PdfWriter

try:
    from reportlab.lib.colors import HexColor
    from reportlab.pdfbase import pdfmetrics
    from reportlab.pdfbase.ttfonts import TTFont
    from reportlab.pdfgen import canvas
except ImportError:
    sys.exit("overlay_text.py needs reportlab: python -m pip install reportlab")


def _font(entry: dict, registered: dict) -> str:
    path = entry.get("font")
    if path:
        if path not in registered:
            name = f"Custom{len(registered)}"
            pdfmetrics.registerFont(TTFont(name, path))
            registered[path] = name
        return registered[path]
    return "Helvetica-Bold" if entry.get("bold") else "Helvetica"


def overlay(src: Path, entries: list[dict], out: Path) -> None:
    reader = PdfReader(str(src))
    writer = PdfWriter(clone_from=str(src))
    registered: dict[str, str] = {}
    by_page: dict[int, list[dict]] = {}
    for entry in entries:
        page = int(entry.get("page", 1))
        if page < 1 or page > len(reader.pages):
            sys.exit(f"The PDF has {len(reader.pages)} pages. Page {page} does not exist. The script saved nothing.")
        if "text" not in entry or ("x" not in entry) or ("top" not in entry):
            sys.exit(f"Each entry needs page, x, top, and text: {entry}. The script saved nothing.")
        by_page.setdefault(page, []).append(entry)
    for number, items in by_page.items():
        page = writer.pages[number - 1]
        box = page.mediabox
        width, height = float(box.width), float(box.height)
        left, bottom = float(box.left), float(box.bottom)
        buffer = io.BytesIO()
        c = canvas.Canvas(buffer, pagesize=(width, height))
        for item in items:
            size = float(item.get("size", 10))
            c.setFont(_font(item, registered), size)
            c.setFillColor(HexColor("#" + str(item.get("color", "000000")).lstrip("#")))
            x = float(item["x"])
            # The baseline of the first line is about 0.8 x size below the upper edge of the text.
            y = height - float(item["top"]) - size * 0.8
            for line in str(item["text"]).split("\n"):
                c.drawString(x, y, line)
                y -= size * 1.2
        c.save()
        buffer.seek(0)
        layer = PdfReader(buffer).pages[0]
        if left or bottom:
            from pypdf import Transformation

            layer.add_transformation(Transformation().translate(left, bottom))
        page.merge_page(layer)
    with open(out, "wb") as f:
        writer.write(f)
    print(f"Wrote {len(entries)} text entries on {len(by_page)} pages. Saved {out}.")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("file", type=Path)
    parser.add_argument("entries", type=Path)
    parser.add_argument("-o", "--output", type=Path, required=True)
    args = parser.parse_args()
    entries = json.loads(args.entries.read_text(encoding="utf-8"))
    overlay(args.file, entries if isinstance(entries, list) else [entries], args.output)


if __name__ == "__main__":
    main()
