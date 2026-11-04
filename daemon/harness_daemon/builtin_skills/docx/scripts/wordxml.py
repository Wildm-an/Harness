"""Shared functions for the scripts of the docx skill: find text in paragraphs and split runs.

A Word paragraph (w:p) holds runs (w:r). Each run has one format (w:rPr) and some text (w:t).
Text that you search for can start in one run and end in another run. split_for_match() splits
the runs so that the match is exactly a list of whole runs. Then a script can wrap these runs in
w:del, w:ins, or comment marks.
"""

from __future__ import annotations

import copy
from typing import Iterator

from docx.oxml.ns import qn

W_T, W_R, W_P, W_RPR = qn("w:t"), qn("w:r"), qn("w:p"), qn("w:rPr")
XML_SPACE = "{http://www.w3.org/XML/1998/namespace}space"


class MatchError(Exception):
    pass


def body_paragraphs(doc) -> list:
    """All w:p elements of the main text, also in tables, in document order."""
    return list(doc.element.body.iter(W_P))


def _single_parts(run) -> list:
    """Split a run into runs that each have one child after w:rPr. Return the new runs."""
    children = [c for c in run if c.tag != W_RPR]
    if len(children) <= 1:
        return [run]
    parent = run.getparent()
    index = parent.index(run)
    new_runs = []
    for child in children:
        r = copy.deepcopy(run)
        for c in list(r):
            if c.tag != W_RPR:
                r.remove(c)
        r.append(copy.deepcopy(child))
        new_runs.append(r)
    parent.remove(run)
    for offset, r in enumerate(new_runs):
        parent.insert(index + offset, r)
    return new_runs


def run_text(run) -> str:
    """The visible text of a run with one child. A tab is a tab character."""
    for child in run:
        if child.tag == W_T:
            return child.text or ""
        if child.tag == qn("w:tab"):
            return "\t"
    return ""


def direct_runs(p) -> list:
    """The runs that are direct children of the paragraph. Each gets one child after w:rPr."""
    runs = []
    for run in [c for c in p if c.tag == W_R]:
        runs.extend(_single_parts(run))
    return runs


def paragraph_text(p) -> str:
    return "".join(run_text(r) for r in direct_runs(p))


def _split_run(run, at: int):
    """Split a text run at a character offset. Return the two runs."""
    t = run.find(W_T)
    text = t.text or ""
    second = copy.deepcopy(run)
    t.text = text[:at]
    second.find(W_T).text = text[at:]
    for el in (t, second.find(W_T)):
        el.set(XML_SPACE, "preserve")
    run.addnext(second)
    return run, second


def find_matches(doc, find: str) -> Iterator[tuple[object, int]]:
    """(paragraph, character offset) of each match of ``find``, in document order."""
    for p in body_paragraphs(doc):
        text = paragraph_text(p)
        start = text.find(find)
        while start != -1:
            yield p, start
            start = text.find(find, start + len(find))


def pick_match(doc, find: str, occurrence: int = 1) -> tuple[object, int]:
    if not find:
        raise MatchError("'find' must not be empty.")
    matches = list(find_matches(doc, find))
    if not matches:
        raise MatchError(f"The text {find!r} is not in the document. The text must be in one paragraph, "
                         "outside hyperlinks and earlier tracked changes. Copy it exactly.")
    if occurrence < 1 or occurrence > len(matches):
        raise MatchError(f"The text {find!r} occurs {len(matches)} times. occurrence {occurrence} does not exist.")
    return matches[occurrence - 1]


def split_for_match(p, start: int, length: int) -> list:
    """Split the runs of ``p`` so that the text [start, start+length) is exactly some whole runs."""
    end = start + length
    pos = 0
    selected = []
    for run in direct_runs(p):
        text = run_text(run)
        run_start, run_end = pos, pos + len(text)
        pos = run_end
        if run_end <= start or run_start >= end or not text:
            continue
        if run.find(W_T) is None:  # A tab: it is in the match as a whole.
            selected.append(run)
            continue
        if run_start < start:
            _, run = _split_run(run, start - run_start)
            run_start = start
        if run_end > end:
            run, _ = _split_run(run, end - run_start)
        selected.append(run)
    return selected


def merge_runs(p) -> None:
    """Join neighbor text runs that have the same format. This keeps the XML small."""
    from lxml import etree

    runs = [c for c in p if c.tag == W_R]
    previous = None
    for run in runs:
        children = [c for c in run if c.tag != W_RPR]
        is_text = len(children) == 1 and children[0].tag == W_T
        if (is_text and previous is not None and previous.getnext() is run
                and etree.tostring(previous.find(W_RPR) if previous.find(W_RPR) is not None else etree.Element("x"))
                == etree.tostring(run.find(W_RPR) if run.find(W_RPR) is not None else etree.Element("x"))):
            pt = previous.find(W_T)
            pt.text = (pt.text or "") + (children[0].text or "")
            pt.set(XML_SPACE, "preserve")
            p.remove(run)
            continue
        previous = run if is_text else None


def next_change_id(doc) -> int:
    """A w:id that no other annotation (change, comment, or bookmark) uses."""
    highest = 0
    for el in doc.element.body.iter():
        value = el.get(qn("w:id"))
        if value is not None and value.lstrip("-").isdigit():
            highest = max(highest, int(value))
    return highest + 1
