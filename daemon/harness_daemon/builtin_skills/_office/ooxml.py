"""Unpack, pack, and check Office Open XML files (.docx, .pptx, .xlsx).

An Office file is a ZIP archive of XML parts. Unpack it to a folder, edit the XML, and pack it again.

    python ooxml.py unpack report.docx report_xml
    python ooxml.py pack report_xml report.docx
    python ooxml.py check report.docx

unpack indents the XML so that each element is on its own line. pack removes that indentation again.
check finds XML errors, parts with no content type, and relationships to parts that do not exist.
It exits with code 1 if it finds a problem.

Only the Python standard library is necessary. If lxml is installed, the XML error messages are better.
"""

from __future__ import annotations

import argparse
import posixpath
import re
import sys
import zipfile
from pathlib import Path
from xml.dom import minidom
from xml.etree import ElementTree as ET

XML_SUFFIXES = (".xml", ".rels", ".vml")
CT_NS = "{http://schemas.openxmlformats.org/package/2006/content-types}"
REL_NS = "{http://schemas.openxmlformats.org/package/2006/relationships}"

# Elements whose text is content. pack never removes whitespace inside them.
TEXT_ELEMENT = r"<(?:w:t|w:delText|w:instrText|a:t|t|v|f)(?: [^>]*[^/>])?>.*?</(?:w:t|w:delText|w:instrText|a:t|t|v|f)>"


def _is_xml(name: str) -> bool:
    return name.lower().endswith(XML_SUFFIXES)


def pretty(data: bytes) -> bytes:
    """Indent an XML part. Text inside text elements does not change."""
    try:
        dom = minidom.parseString(data)
    except Exception:
        return data  # Keep a part that does not parse. check reports it.
    text = dom.toprettyxml(indent="  ", encoding="UTF-8")
    # minidom drops standalone="yes". Keep the declaration of the original part.
    original = re.match(rb"<\?xml[^>]*\?>", data.lstrip())
    if original:
        text = re.sub(rb"^<\?xml[^>]*\?>", original.group(0).replace(b"\\", b"\\\\"), text, count=1)
    # minidom puts the text of a leaf element on its own line in some versions. Join it again.
    text = re.sub(rb">\n\s+([^<\s][^<]*?)\n\s+</", rb">\1</", text)
    return text


def condense(data: bytes) -> bytes:
    """Remove the whitespace between tags that unpack added. Text in text elements stays."""
    try:
        text = data.decode("utf-8")
    except UnicodeDecodeError:
        return data
    parts = re.split(f"({TEXT_ELEMENT})", text, flags=re.S)
    out = []
    for i, part in enumerate(parts):
        if i % 2 == 1:
            out.append(part)  # A text element: keep it as it is.
        else:
            # The whitespace between two tags, and at the edges next to a text element.
            part = re.sub(r">\s+<", "><", part)
            part = re.sub(r">\s+$", ">", part) if i + 1 < len(parts) else part
            part = re.sub(r"^\s+<", "<", part) if i > 0 else part
            out.append(part)
    result = "".join(out).strip()
    if result.startswith("<?xml"):
        decl_end = result.index("?>") + 2
        result = result[:decl_end] + "\n" + result[decl_end:].lstrip()
    return result.encode("utf-8")


def unpack(src: Path, dest: Path) -> None:
    if dest.exists() and any(dest.iterdir()):
        sys.exit(f"The folder {dest} is not empty. Use a new folder.")
    dest.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(src) as z:
        for info in z.infolist():
            if info.is_dir():
                continue
            target = dest / info.filename
            if not target.resolve().is_relative_to(dest.resolve()):
                sys.exit(f"The archive has an unsafe path: {info.filename}")
            target.parent.mkdir(parents=True, exist_ok=True)
            data = z.read(info)
            target.write_bytes(pretty(data) if _is_xml(info.filename) else data)
    print(f"Unpacked {src} to {dest}")


def pack(src: Path, dest: Path) -> None:
    files = sorted(p for p in src.rglob("*") if p.is_file())
    names = [p.relative_to(src).as_posix() for p in files]
    if "[Content_Types].xml" not in names:
        sys.exit(f"{src} has no [Content_Types].xml. It is not an unpacked Office file.")
    # [Content_Types].xml goes first, then _rels/.rels. Some programs expect this order.
    order = sorted(zip(names, files), key=lambda item: (item[0] != "[Content_Types].xml", item[0] != "_rels/.rels", item[0]))
    tmp = dest.with_name(dest.name + ".tmp")
    with zipfile.ZipFile(tmp, "w", zipfile.ZIP_DEFLATED) as z:
        for name, path in order:
            data = path.read_bytes()
            z.writestr(name, condense(data) if _is_xml(name) else data)
    tmp.replace(dest)
    print(f"Packed {src} to {dest}")


# -- check -----------------------------------------------------------------------------------


def _read_parts(src: Path) -> dict[str, bytes]:
    if src.is_dir():
        return {p.relative_to(src).as_posix(): p.read_bytes() for p in src.rglob("*") if p.is_file()}
    with zipfile.ZipFile(src) as z:
        return {i.filename: z.read(i) for i in z.infolist() if not i.is_dir()}


def _parse(name: str, data: bytes) -> tuple[ET.Element | None, str | None]:
    try:
        return ET.fromstring(data), None
    except ET.ParseError as e:
        detail = str(e)
        try:
            from lxml import etree

            etree.fromstring(data)
        except Exception as le:  # noqa: BLE001 - lxml gives a better message.
            detail = str(le)
        return None, f"{name}: the XML is not valid: {detail}"


def _rels_source(rels_name: str) -> str:
    """The folder of the part that a .rels file belongs to. word/_rels/document.xml.rels -> word"""
    folder = posixpath.dirname(posixpath.dirname(rels_name))
    return folder


def check(src: Path) -> list[str]:
    problems: list[str] = []
    try:
        parts = _read_parts(src)
    except zipfile.BadZipFile:
        return [f"{src} is not a ZIP archive. It is not a valid Office file."]
    trees: dict[str, ET.Element] = {}
    for name, data in parts.items():
        if _is_xml(name):
            tree, error = _parse(name, data)
            if error:
                problems.append(error)
            elif tree is not None:
                trees[name] = tree

    types = trees.get("[Content_Types].xml")
    if types is None:
        problems.append("[Content_Types].xml is missing or not valid.")
    else:
        defaults = {d.get("Extension", "").lower() for d in types.iter(f"{CT_NS}Default")}
        overrides = {o.get("PartName", "").lstrip("/") for o in types.iter(f"{CT_NS}Override")}
        for name in parts:
            if name == "[Content_Types].xml":
                continue
            ext = name.rsplit(".", 1)[-1].lower() if "." in name else ""
            if name not in overrides and ext not in defaults:
                problems.append(f"{name}: no content type. Add an Override or a Default to [Content_Types].xml.")
        for part in overrides:
            if part not in parts:
                problems.append(f"[Content_Types].xml names /{part}, but the part does not exist.")

    for name, tree in trees.items():
        if not name.endswith(".rels"):
            continue
        base = _rels_source(name)
        ids: set[str] = set()
        for rel in tree.iter(f"{REL_NS}Relationship"):
            rid = rel.get("Id", "")
            if rid in ids:
                problems.append(f"{name}: the Id {rid} is used two times.")
            ids.add(rid)
            if rel.get("TargetMode") == "External":
                continue
            target = rel.get("Target", "")
            path = target.lstrip("/") if target.startswith("/") else posixpath.normpath(posixpath.join(base, target))
            if path not in parts:
                problems.append(f"{name}: {rid} points to {target}, but {path} does not exist.")
        # Each r:id in the source part must be in its .rels file.
        source = posixpath.join(base, posixpath.basename(name)[: -len(".rels")])
        source_tree = trees.get(source)
        if source_tree is not None:
            for el in source_tree.iter():
                for key, value in el.attrib.items():
                    if key.startswith("{http://schemas.openxmlformats.org/officeDocument/2006/relationships}") and value not in ids:
                        problems.append(f"{source}: the relationship {value} is not in {name}.")
    problems += _check_word(trees)
    return problems


W = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"


def _check_word(trees: dict[str, ET.Element]) -> list[str]:
    doc = trees.get("word/document.xml")
    if doc is None:
        return []
    problems = []
    ids: dict[str, int] = {}
    for tag in ("ins", "del"):
        for el in doc.iter(f"{W}{tag}"):
            rid = el.get(f"{W}id")
            if rid is None:
                problems.append(f"word/document.xml: a w:{tag} has no w:id.")
            else:
                ids[rid] = ids.get(rid, 0) + 1
            if not el.get(f"{W}author"):
                problems.append(f"word/document.xml: the w:{tag} with w:id {rid} has no w:author.")
    for rid, count in ids.items():
        if count > 1:
            problems.append(f"word/document.xml: the change id {rid} is used {count} times. Each w:ins and w:del needs its own id.")
    for el in doc.iter(f"{W}del"):
        for t in el.iter(f"{W}t"):
            problems.append("word/document.xml: a w:del contains w:t. Deleted text must be in w:delText.")
            break
    comments = trees.get("word/comments.xml")
    comment_ids = {c.get(f"{W}id") for c in comments.iter(f"{W}comment")} if comments is not None else set()
    for el in doc.iter(f"{W}commentReference"):
        if el.get(f"{W}id") not in comment_ids:
            problems.append(f"word/document.xml: the comment reference {el.get(f'{W}id')} has no comment in word/comments.xml.")
    return problems


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="command", required=True)
    p = sub.add_parser("unpack", help="Unpack an Office file to a folder, with indented XML.")
    p.add_argument("file", type=Path)
    p.add_argument("folder", type=Path)
    p = sub.add_parser("pack", help="Pack a folder to an Office file.")
    p.add_argument("folder", type=Path)
    p.add_argument("file", type=Path)
    p = sub.add_parser("check", help="Check an Office file or an unpacked folder.")
    p.add_argument("path", type=Path)
    args = parser.parse_args()
    if args.command == "unpack":
        unpack(args.file, args.folder)
    elif args.command == "pack":
        pack(args.folder, args.file)
        problems = check(args.file)
        if problems:
            print("The packed file has problems:")
            print("\n".join(f"- {p}" for p in problems))
            sys.exit(1)
    else:
        problems = check(args.path)
        if problems:
            print("\n".join(f"- {p}" for p in problems))
            sys.exit(1)
        print(f"No problems found in {args.path}.")


if __name__ == "__main__":
    main()
