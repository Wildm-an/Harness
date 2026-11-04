"""Put new text in the shapes of a presentation and keep the format of the template.

    python replace_text.py draft.pptx text.json -o final.pptx
    python replace_text.py draft.pptx text.json -o final.pptx --clear-unlisted

text.json maps shape keys (from inventory.py) to the new text:

    {
      "1.1": "Quarterly Review",
      "1.2": ["October 2026", "Finance team"],
      "2.2": [
        {"text": "Revenue grew 12%", "bold": true},
        {"text": "North region led the growth", "level": 1},
        {"text": "Costs stayed flat"}
      ],
      "3.4": {"table": [["Region", "Revenue"], ["North", "1.2M"]]},
      "notes:2": "Say that the growth came from new stores."
    }

- A string is one paragraph. A list is one paragraph for each item.
- A paragraph object can have "text", "level" (0 is the top level), "bold", "italic", "color" (hex),
  and "size" (points).
- Each new paragraph takes the format of the paragraph at the same position in the shape (or the last one).
- "table" sets the cell text of a table. "notes:N" sets the speaker notes of slide N.
- --clear-unlisted empties the text of all other text shapes on the slides that the file names.
  Use it to remove the sample text of a template.
"""

from __future__ import annotations

import argparse
import copy
import json
import sys
from pathlib import Path

from pptx import Presentation
from pptx.dml.color import RGBColor
from pptx.util import Pt

A_NS = "{http://schemas.openxmlformats.org/drawingml/2006/main}"


def _as_paragraphs(value) -> list[dict]:
    if isinstance(value, str):
        return [{"text": value}]
    if isinstance(value, list):
        return [{"text": v} if isinstance(v, str) else dict(v) for v in value]
    raise ValueError(f"Use a string, a list, or a table object, not {type(value).__name__}.")


def set_paragraphs(text_frame, items: list[dict]) -> None:
    """Replace the paragraphs of a text frame. Keep the paragraph and run formats of the template."""
    body = text_frame._txBody
    old = body.findall(f"{A_NS}p")
    templates = [copy.deepcopy(p) for p in old] or [None]
    for p in old:
        body.remove(p)
    for i, item in enumerate(items):
        template = templates[min(i, len(templates) - 1)]
        p = copy.deepcopy(template) if template is not None else body.makeelement(f"{A_NS}p", {})
        runs = p.findall(f"{A_NS}r")
        run_props = copy.deepcopy(runs[0].find(f"{A_NS}rPr")) if runs else None
        if run_props is None:
            end = p.find(f"{A_NS}endParaRPr")
            if end is not None:
                run_props = copy.deepcopy(end)
                run_props.tag = f"{A_NS}rPr"
        for child in list(p):
            if child.tag in (f"{A_NS}r", f"{A_NS}br", f"{A_NS}fld"):
                p.remove(child)
        run = p.makeelement(f"{A_NS}r", {})
        if run_props is not None:
            run.append(run_props)
        t = run.makeelement(f"{A_NS}t", {})
        t.text = str(item.get("text", ""))
        run.append(t)
        end = p.find(f"{A_NS}endParaRPr")
        if end is not None:
            end.addprevious(run)
        else:
            p.append(run)
        body.append(p)
    for paragraph, item in zip(text_frame.paragraphs, items):
        if "level" in item:
            paragraph.level = int(item["level"])
        for r in paragraph.runs:
            if "bold" in item:
                r.font.bold = bool(item["bold"])
            if "italic" in item:
                r.font.italic = bool(item["italic"])
            if "color" in item:
                r.font.color.rgb = RGBColor.from_string(str(item["color"]).lstrip("#"))
            if "size" in item:
                r.font.size = Pt(float(item["size"]))


def apply(prs, mapping: dict, clear_unlisted: bool) -> list[str]:
    slides = list(prs.slides)
    done, named_slides = [], set()
    for key, value in mapping.items():
        if key.startswith("notes:"):
            n = int(key.split(":", 1)[1])
            slides[n - 1].notes_slide.notes_text_frame.text = str(value)
            done.append(f"notes of slide {n}")
            continue
        try:
            n, s = (int(x) for x in key.split("."))
            slide = slides[n - 1]
            shape = list(slide.shapes)[s - 1]
        except (ValueError, IndexError):
            raise ValueError(f"The key {key!r} does not name a shape. Use the keys of inventory.py, for example 2.3.") from None
        named_slides.add(n)
        if isinstance(value, dict) and "table" in value:
            if not (getattr(shape, "has_table", False) and shape.has_table):
                raise ValueError(f"The shape {key} is not a table.")
            rows = shape.table.rows
            for r, values in enumerate(value["table"]):
                if r >= len(rows):
                    raise ValueError(f"The table {key} has {len(rows)} rows. Add rows in the template first.")
                cells = rows[r].cells
                for c, text in enumerate(values):
                    if c < len(cells):
                        set_paragraphs(cells[c].text_frame, [{"text": "" if text is None else str(text)}])
            done.append(f"{key}: table")
            continue
        if not shape.has_text_frame:
            raise ValueError(f"The shape {key} ({shape.name}) has no text.")
        set_paragraphs(shape.text_frame, _as_paragraphs(value))
        done.append(f"{key}: {shape.name}")
    if clear_unlisted:
        for n in sorted(named_slides):
            for s, shape in enumerate(slides[n - 1].shapes, 1):
                if f"{n}.{s}" not in mapping and shape.has_text_frame and shape.text_frame.text.strip():
                    set_paragraphs(shape.text_frame, [{"text": ""}])
                    done.append(f"{n}.{s}: cleared")
    return done


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("file", type=Path)
    parser.add_argument("text", type=Path, help="The JSON file with the new text.")
    parser.add_argument("-o", "--output", type=Path, help="The output file. Default: change the file in place.")
    parser.add_argument("--clear-unlisted", action="store_true")
    args = parser.parse_args()
    mapping = json.loads(args.text.read_text(encoding="utf-8"))
    prs = Presentation(str(args.file))
    try:
        done = apply(prs, mapping, args.clear_unlisted)
    except ValueError as e:
        sys.exit(f"{e}\nThe script saved nothing.")
    out = args.output or args.file
    prs.save(str(out))
    print("\n".join(done))
    print(f"Saved {out}.")


if __name__ == "__main__":
    main()
