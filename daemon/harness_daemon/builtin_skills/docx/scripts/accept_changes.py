"""Accept or reject all tracked changes in a Word file.

    python accept_changes.py draft.docx -o clean.docx            # accept all changes
    python accept_changes.py draft.docx -o original.docx --reject

The script changes the main text, the headers, the footers, the footnotes, and the comments.
It handles inserted and deleted text, moved text, inserted and deleted paragraphs and table rows,
and format changes. Comments stay. Use it to make a clean copy, or to read the text before changes.
"""

from __future__ import annotations

import argparse
from pathlib import Path

from docx import Document
from docx.oxml.ns import qn

W_P, W_PPR, W_RPR = qn("w:p"), qn("w:pPr"), qn("w:rPr")
PR_CHANGES = ("w:rPrChange", "w:pPrChange", "w:sectPrChange", "w:tblPrChange", "w:tblPrExChange",
              "w:trPrChange", "w:tcPrChange", "w:tblGridChange", "w:numberingChange")
RANGE_MARKS = ("w:moveFromRangeStart", "w:moveFromRangeEnd", "w:moveToRangeStart", "w:moveToRangeEnd")
KEEP_ON_RESTORE = {qn(t) for t in ("w:ins", "w:del", "w:moveFrom", "w:moveTo", "w:rPr", "w:sectPr")}


def _unwrap(el) -> None:
    parent = el.getparent()
    index = parent.index(el)
    for offset, child in enumerate(list(el)):
        parent.insert(index + offset, child)
    parent.remove(el)


def _remove(el) -> None:
    el.getparent().remove(el)


def _is_paragraph_mark(el) -> bool:
    """True for a w:ins or w:del of a paragraph mark: inside the w:rPr of a w:pPr."""
    parent = el.getparent()
    return parent is not None and parent.tag == W_RPR and parent.getparent() is not None and parent.getparent().tag == W_PPR


def _join_with_next(p) -> None:
    """Remove the paragraph mark of p: its content goes to the start of the next paragraph."""
    following = p.getnext()
    while following is not None and following.tag != W_P:
        following = following.getnext()
    if following is None:
        # The last paragraph: remove it if it is now empty and its container has another paragraph.
        siblings = [c for c in p.getparent() if c.tag == W_P]
        if len(siblings) > 1 and all(c.tag == W_PPR for c in p):
            _remove(p)
        return
    ppr = following.find(W_PPR)
    position = following.index(ppr) + 1 if ppr is not None else 0
    for offset, child in enumerate([c for c in p if c.tag != W_PPR]):
        following.insert(position + offset, child)
    _remove(p)


def _undelete_text(el) -> None:
    for t in el.iter(qn("w:delText")):
        t.tag = qn("w:t")
    for t in el.iter(qn("w:delInstrText")):
        t.tag = qn("w:instrText")


def process(root, accept: bool) -> int:
    count = 0
    for tag in RANGE_MARKS:
        for el in list(root.iter(qn(tag))):
            _remove(el)
    keep, drop = ("w:ins", "w:del") if accept else ("w:del", "w:ins")
    for tag, wanted in ((keep, True), (drop, False), ("w:moveTo" if accept else "w:moveFrom", True),
                        ("w:moveFrom" if accept else "w:moveTo", False)):
        # The text changes first, then the paragraph marks: a paragraph join must see the final text.
        for el in sorted(root.iter(qn(tag)), key=_is_paragraph_mark):
            if el.getparent() is None:
                continue
            count += 1
            parent = el.getparent()
            if parent.tag == qn("w:trPr"):  # A table row.
                if wanted:
                    _remove(el)
                else:
                    row = parent.getparent()
                    row.getparent().remove(row)
            elif parent.tag == W_RPR and parent.getparent() is not None and parent.getparent().tag == W_PPR:
                p = parent.getparent().getparent()  # A paragraph mark.
                _remove(el)
                if not wanted:
                    _join_with_next(p)
            elif wanted:
                _undelete_text(el)
                _unwrap(el)
            else:
                _remove(el)
    for tag in PR_CHANGES:
        for el in list(root.iter(qn(tag))):
            count += 1
            parent = el.getparent()
            if not accept:
                old = next(iter(el), None)  # The format before the change.
                for child in [c for c in parent if c.tag not in KEEP_ON_RESTORE and c is not el]:
                    parent.remove(child)
                if old is not None:
                    for offset, child in enumerate(list(old)):
                        parent.insert(offset, child)
            _remove(el)
    return count


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("file", type=Path)
    parser.add_argument("-o", "--output", type=Path, help="The output file. Default: change the file in place.")
    parser.add_argument("--reject", action="store_true", help="Reject the changes instead of accepting them.")
    args = parser.parse_args()
    doc = Document(str(args.file))
    total = 0
    for part in doc.part.package.iter_parts():
        element = getattr(part, "_element", None)
        if element is not None and "wordprocessingml" in part.content_type:
            total += process(element, accept=not args.reject)
    out = args.output or args.file
    doc.save(str(out))
    verb = "Rejected" if args.reject else "Accepted"
    print(f"{verb} {total} tracked changes. Saved {out}.")


if __name__ == "__main__":
    main()
