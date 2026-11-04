"""List the slides, the shapes, and the text of a presentation, with positions and sizes.

    python inventory.py deck.pptx              # text report
    python inventory.py deck.pptx --json       # JSON for a script
    python inventory.py deck.pptx --layouts    # also list the slide layouts and their placeholders

Each shape has a key "slide.shape", for example 2.3. The read tool and replace_text.py use the same keys.
"may overflow" marks a text box whose text is probably too long for the box. Look at the slide to be sure.
"""

from __future__ import annotations

import argparse
import json
import math
import sys
from pathlib import Path

from pptx import Presentation
from pptx.util import Emu

EMU_PER_INCH = 914400


def _inches(value) -> float:
    return round(Emu(value or 0).inches, 2)


def _kind(shape) -> str:
    if shape.is_placeholder:
        try:
            return f"placeholder:{shape.placeholder_format.type.name.lower()}"
        except Exception:  # noqa: BLE001 - an unknown placeholder type
            return "placeholder"
    if getattr(shape, "has_chart", False) and shape.has_chart:
        return "chart"
    if getattr(shape, "has_table", False) and shape.has_table:
        return "table"
    return str(shape.shape_type).split(".")[-1].split(" ")[0].lower() if shape.shape_type else "shape"


def _font_size(shape) -> float:
    """The largest font size in the shape, in points. 18 if no size is set."""
    sizes = [run.font.size.pt for p in shape.text_frame.paragraphs for run in p.runs if run.font.size]
    return max(sizes) if sizes else 18.0


def _may_overflow(shape) -> bool:
    """A rough estimate: the lines of text at the font size need more height than the box has."""
    if not shape.width or not shape.height:
        return False
    size = _font_size(shape)
    tf = shape.text_frame
    margin = (tf.margin_left or 91440) + (tf.margin_right or 91440)
    width_pt = (shape.width - margin) / 12700
    char_pt = size * 0.5
    lines = 0
    for p in tf.paragraphs:
        chars = len(p.text)
        lines += max(1, math.ceil(chars * char_pt / max(width_pt, 1)))
    height_pt = (shape.height - (tf.margin_top or 45720) - (tf.margin_bottom or 45720)) / 12700
    return lines * size * 1.2 > height_pt * 1.05


def shape_info(n: int, s: int, shape) -> dict:
    info = {
        "key": f"{n}.{s}",
        "name": shape.name,
        "kind": _kind(shape),
        "left": _inches(shape.left), "top": _inches(shape.top),
        "width": _inches(shape.width), "height": _inches(shape.height),
    }
    if shape.has_text_frame:
        info["paragraphs"] = [
            {"text": p.text, "level": p.level} for p in shape.text_frame.paragraphs
        ]
        info["font_size"] = _font_size(shape)
        info["may_overflow"] = bool(shape.text_frame.text.strip()) and _may_overflow(shape)
    elif getattr(shape, "has_table", False) and shape.has_table:
        info["table"] = [[cell.text for cell in row.cells] for row in shape.table.rows]
    return info


def inventory(path: Path, layouts: bool) -> dict:
    prs = Presentation(str(path))
    result = {
        "file": str(path),
        "slide_width": _inches(prs.slide_width),
        "slide_height": _inches(prs.slide_height),
        "slides": [],
    }
    for n, slide in enumerate(prs.slides, 1):
        notes = ""
        if slide.has_notes_slide and slide.notes_slide.notes_text_frame is not None:
            notes = slide.notes_slide.notes_text_frame.text
        result["slides"].append({
            "slide": n,
            "layout": slide.slide_layout.name,
            "shapes": [shape_info(n, s, shape) for s, shape in enumerate(slide.shapes, 1)],
            "notes": notes,
        })
    if layouts:
        result["layouts"] = [
            {"number": i, "name": layout.name,
             "placeholders": [f"{ph.placeholder_format.idx}:{ph.placeholder_format.type.name.lower()}:{ph.name}"
                              for ph in layout.placeholders]}
            for i, layout in enumerate(prs.slide_layouts, 1)
        ]
    return result


def print_text(data: dict) -> None:
    print(f"{Path(data['file']).name}: {len(data['slides'])} slides, {data['slide_width']} x {data['slide_height']} in")
    for slide in data["slides"]:
        print(f"\nSlide {slide['slide']} (layout: {slide['layout']})")
        for sh in slide["shapes"]:
            box = f"at {sh['left']},{sh['top']} size {sh['width']}x{sh['height']} in"
            flag = "  ** may overflow **" if sh.get("may_overflow") else ""
            print(f"  [{sh['key']}] {sh['kind']} \"{sh['name']}\" {box}{flag}")
            for p in sh.get("paragraphs", []):
                if p["text"].strip():
                    print(f"      {'  ' * p['level']}{p['text']}")
            for row in sh.get("table", []):
                print("      | " + " | ".join(row) + " |")
        if slide["notes"].strip():
            print(f"  Notes: {slide['notes'].strip()}")
    for layout in data.get("layouts", []):
        print(f"\nLayout {layout['number']}: {layout['name']}  placeholders: {', '.join(layout['placeholders']) or 'none'}")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("file", type=Path)
    parser.add_argument("--json", action="store_true")
    parser.add_argument("--layouts", action="store_true", help="Also list the slide layouts.")
    args = parser.parse_args()
    if not args.file.exists():
        sys.exit(f"The file does not exist: {args.file}")
    data = inventory(args.file, args.layouts)
    if args.json:
        print(json.dumps(data, indent=2, ensure_ascii=False))
    else:
        print_text(data)


if __name__ == "__main__":
    main()
