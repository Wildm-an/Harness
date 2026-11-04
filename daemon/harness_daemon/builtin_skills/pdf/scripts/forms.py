"""List and fill the form fields of a PDF form.

    python forms.py fields form.pdf                    # the fields as JSON
    python forms.py fill form.pdf values.json -o filled.pdf
    python forms.py fill form.pdf values.json -o filled.pdf --flatten

values.json maps field names (from "fields") to values:

    {"full_name": "Ana Silva", "date": "2026-11-04", "agree": true, "country": "Portugal"}

- A text field takes a string.
- A check box takes true or false (or the "on" state name from "fields").
- A radio group or a choice field takes one of the "options" from "fields".
- --flatten makes the values part of the page. Then nobody can change them in a PDF viewer.

If "fields" returns an empty list, the PDF has no fillable fields. Then use find_text.py and
overlay_text.py to write text on the page.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from pypdf import PdfReader, PdfWriter


def _name(annot) -> str:
    """The full name of a field: the names of its parents and its own name, with dots."""
    parts = []
    node = annot
    while node is not None:
        if "/T" in node:
            parts.append(str(node["/T"]))
        node = node.get("/Parent")
        node = node.get_object() if node is not None else None
    return ".".join(reversed(parts))


def _inherited(annot, key: str):
    """A field value that the widget or one of its parents has."""
    node = annot
    while node is not None:
        if key in node:
            return node[key]
        node = node.get("/Parent")
        node = node.get_object() if node is not None else None
    return None


def _field_type(annot) -> str | None:
    node = annot
    while node is not None:
        if "/FT" in node:
            ft = node["/FT"]
            flags = int(_inherited(annot, "/Ff") or 0)
            if ft == "/Tx":
                return "text"
            if ft == "/Btn":
                if flags & (1 << 16):
                    return "button"
                return "radio" if flags & (1 << 15) else "checkbox"
            if ft == "/Ch":
                return "choice"
            if ft == "/Sig":
                return "signature"
            return str(ft)
        node = node.get("/Parent")
        node = node.get_object() if node is not None else None
    return None


def _states(annot) -> list[str]:
    ap = annot.get("/AP")
    if ap is None:
        return []
    normal = ap.get_object().get("/N")
    if normal is None or not hasattr(normal.get_object(), "keys"):
        return []
    return [str(k) for k in normal.get_object().keys() if str(k) != "/Off"]


def list_fields(path: Path) -> list[dict]:
    reader = PdfReader(str(path))
    fields: dict[str, dict] = {}
    for page_number, page in enumerate(reader.pages, 1):
        for ref in page.get("/Annots") or []:
            annot = ref.get_object()
            if annot.get("/Subtype") != "/Widget":
                continue
            name = _name(annot)
            kind = _field_type(annot)
            if not name or kind in (None, "button"):
                continue
            rect = [round(float(v), 1) for v in annot.get("/Rect", [0, 0, 0, 0])]
            entry = fields.setdefault(name, {"name": name, "type": kind, "page": page_number, "rect": rect})
            value_node = annot if "/V" in annot else annot.get("/Parent", annot).get_object()
            value = value_node.get("/V")
            if value is not None:
                entry["value"] = str(value)
            if kind in ("checkbox", "radio"):
                entry.setdefault("options", [])
                for state in _states(annot):
                    if state not in entry["options"]:
                        entry["options"].append(state)
            if kind == "choice":
                node = annot if "/Opt" in annot else annot.get("/Parent", annot).get_object()
                options = node.get("/Opt") or []
                entry["options"] = [str(o[1] if isinstance(o, list) else o) for o in options]
    # Some programs do not set the radio flag. A button field with more than one "on" state is a radio group.
    for entry in fields.values():
        if entry["type"] == "checkbox" and len(entry.get("options", [])) > 1:
            entry["type"] = "radio"
    return list(fields.values())


def _coerce(field: dict, value):
    kind = field["type"]
    if kind == "checkbox":
        on = (field.get("options") or ["/Yes"])[0]
        if value is True or str(value).lower() in ("true", "yes", "on", "1", "x"):
            return on
        if value is False or str(value).lower() in ("false", "no", "off", "0", ""):
            return "/Off"
        value = str(value) if str(value).startswith("/") else "/" + str(value)
    if kind == "radio":
        value = str(value) if str(value).startswith("/") else "/" + str(value)
    if field.get("options") and kind in ("radio", "choice", "checkbox") and value not in field["options"] and value != "/Off":
        raise ValueError(f"The field {field['name']!r} accepts only {field['options']}. Got {value!r}.")
    return value if isinstance(value, str) else str(value)


def fill(path: Path, values: dict, output: Path, flatten: bool) -> None:
    fields = {f["name"]: f for f in list_fields(path)}
    unknown = [name for name in values if name not in fields]
    if unknown:
        sys.exit(f"These fields do not exist: {unknown}. Run 'forms.py fields' for the names. The script saved nothing.")
    try:
        prepared = {name: _coerce(fields[name], value) for name, value in values.items()}
    except ValueError as e:
        sys.exit(f"{e}\nThe script saved nothing.")
    writer = PdfWriter(clone_from=str(path))
    for page_number, page in enumerate(writer.pages, 1):
        on_page = {n: v for n, v in prepared.items() if fields[n]["page"] == page_number}
        if not on_page:
            continue
        try:
            writer.update_page_form_field_values(page, on_page, auto_regenerate=False, flatten=flatten)
        except TypeError:  # An old pypdf with no flatten parameter.
            writer.update_page_form_field_values(page, on_page, auto_regenerate=False)
    # Ask the viewer to draw the values again, so that all viewers show them.
    writer.set_need_appearances_writer(True)
    with open(output, "wb") as f:
        writer.write(f)
    print(f"Filled {len(prepared)} fields. Saved {output}.")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="command", required=True)
    p = sub.add_parser("fields", help="List the form fields as JSON.")
    p.add_argument("file", type=Path)
    p = sub.add_parser("fill", help="Fill the form fields from a JSON file.")
    p.add_argument("file", type=Path)
    p.add_argument("values", type=Path)
    p.add_argument("-o", "--output", type=Path, required=True)
    p.add_argument("--flatten", action="store_true")
    args = parser.parse_args()
    if args.command == "fields":
        print(json.dumps(list_fields(args.file), indent=2, ensure_ascii=False))
    else:
        fill(args.file, json.loads(args.values.read_text(encoding="utf-8")), args.output, args.flatten)


if __name__ == "__main__":
    main()
