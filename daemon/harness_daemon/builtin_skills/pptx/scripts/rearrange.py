"""Make a new presentation from the slides of a template: pick, copy, and order the slides.

    python rearrange.py template.pptx draft.pptx 1,4,4,4,7,12

The list gives the template slides of the new presentation, in order. Numbers start at 1.
A number can occur more than one time: the slide is copied. Slides that are not in the list are removed.
The theme, the layouts, and the slide size of the template stay.
After this step, run inventory.py on the new file: the slide numbers are the new ones.
"""

from __future__ import annotations

import argparse
import copy
import sys
from pathlib import Path

from pptx import Presentation

R_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
SKIP_RELS = ("/notesSlide", "/slideLayout")


def duplicate_slide(prs, source):
    """Add a copy of a slide at the end. Return the new slide."""
    new = prs.slides.add_slide(source.slide_layout)
    tree = new.shapes._spTree
    for shape in list(tree)[2:]:  # Keep nvGrpSpPr and grpSpPr. Remove the placeholders of the layout.
        tree.remove(shape)
    # Copy the relationships (images, charts, links) and keep a map of the old to the new IDs.
    id_map = {}
    for rid, rel in source.part.rels.items():
        if rel.reltype.endswith(SKIP_RELS):
            continue
        if rel.is_external:
            id_map[rid] = new.part.relate_to(rel.target_ref, rel.reltype, is_external=True)
        else:
            id_map[rid] = new.part.relate_to(rel.target_part, rel.reltype)
    for shape in list(source.shapes._spTree)[2:]:
        tree.append(copy.deepcopy(shape))
    # The background of the slide, if it has one.
    source_bg = source._element.cSld.bg
    if source_bg is not None:
        new._element.cSld.insert(0, copy.deepcopy(source_bg))
    for el in new._element.iter():
        for key, value in list(el.attrib.items()):
            if key.startswith(f"{{{R_NS}}}") and value in id_map:
                el.set(key, id_map[value])
    if source.has_notes_slide and source.notes_slide.notes_text_frame is not None:
        new.notes_slide.notes_text_frame.text = source.notes_slide.notes_text_frame.text
    return new


def rearrange(src: Path, dest: Path, order: list[int]) -> None:
    prs = Presentation(str(src))
    slides = list(prs.slides)
    count = len(slides)
    bad = [n for n in order if n < 1 or n > count]
    if bad:
        sys.exit(f"The template has {count} slides. These numbers do not exist: {bad}")
    used: set[int] = set()
    chosen = []
    for n in order:
        if n in used:
            chosen.append(duplicate_slide(prs, slides[n - 1]))
        else:
            used.add(n)
            chosen.append(slides[n - 1])
    id_list = prs.slides._sldIdLst
    entries = {sld.rId: sld for sld in id_list}
    by_part = {prs.part.related_part(rid): rid for rid in entries}
    wanted = [by_part[slide.part] for slide in chosen]
    for rid, sld in entries.items():
        id_list.remove(sld)
        if rid not in wanted:
            prs.part.drop_rel(rid)
    for rid in wanted:
        id_list.append(entries[rid])
    prs.save(str(dest))
    print(f"Saved {dest} with {len(wanted)} slides: template slides {', '.join(map(str, order))}.")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("template", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("order", help="Comma-separated slide numbers, for example 1,4,4,7")
    args = parser.parse_args()
    try:
        order = [int(x) for x in args.order.replace(" ", "").split(",") if x]
    except ValueError:
        sys.exit("The order must be numbers with commas, for example 1,4,4,7")
    if not order:
        sys.exit("Give at least one slide number.")
    rearrange(args.template, args.output, order)


if __name__ == "__main__":
    main()
