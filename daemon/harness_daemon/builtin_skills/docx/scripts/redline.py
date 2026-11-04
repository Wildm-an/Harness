"""Make tracked changes (redlines) in a Word file. Word shows each change with the author name.

    python redline.py contract.docx changes.json -o contract-redline.docx --author "Harness"

changes.json is a list of changes. They apply in order:

    [
      {"find": "30 days", "replace": "45 days"},
      {"find": "the Seller", "replace": "the Supplier", "all": true},
      {"find": "Section 4", "replace": "Section 5", "occurrence": 2},
      {"op": "insert_after", "find": "including", "text": " without limitation"},
      {"op": "delete_paragraph", "find": "This clause is void."},
      {"op": "insert_paragraph_after", "find": "1. Term.", "text": "1A. Renewal. The term renews each year."}
    ]

- "find" is text in one paragraph. Copy it exactly from the document.
- "replace" "" deletes the text.
- "occurrence" picks the Nth match (1 is the first). "all": true changes all matches (replace only).
- The script changes nothing if one change fails. It prints the reason.
"""

from __future__ import annotations

import argparse
import copy
import datetime
import json
import sys
from pathlib import Path

from docx import Document
from docx.oxml import OxmlElement
from docx.oxml.ns import qn

sys.path.insert(0, str(Path(__file__).parent))
from wordxml import (W_R, W_RPR, W_T, XML_SPACE, MatchError, find_matches, merge_runs, next_change_id,  # noqa: E402
                     pick_match, split_for_match)


class Redliner:
    def __init__(self, doc, author: str):
        self.doc = doc
        self.author = author
        self.date = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        self.next_id = next_change_id(doc)

    def _mark(self, tag: str):
        el = OxmlElement(tag)
        el.set(qn("w:id"), str(self.next_id))
        el.set(qn("w:author"), self.author)
        el.set(qn("w:date"), self.date)
        self.next_id += 1
        return el

    def _new_run(self, template_run, text: str):
        run = OxmlElement("w:r")
        rpr = template_run.find(W_RPR) if template_run is not None else None
        if rpr is not None:
            run.append(copy.deepcopy(rpr))
        t = OxmlElement("w:t")
        t.text = text
        t.set(XML_SPACE, "preserve")
        run.append(t)
        return run

    def _delete_runs(self, runs):
        """Wrap the runs in w:del. Return the w:del element."""
        deletion = self._mark("w:del")
        runs[0].addprevious(deletion)
        for run in runs:
            for t in run.iter(W_T):
                t.tag = qn("w:delText")
            deletion.append(run)
        return deletion

    def replace(self, p, start: int, find: str, replace: str) -> None:
        runs = split_for_match(p, start, len(find))
        template = runs[0]
        anchor = self._delete_runs(runs)
        if replace:
            insertion = self._mark("w:ins")
            insertion.append(self._new_run(template, replace))
            anchor.addnext(insertion)

    def insert_after(self, p, start: int, find: str, text: str) -> None:
        runs = split_for_match(p, start, len(find))
        insertion = self._mark("w:ins")
        insertion.append(self._new_run(runs[-1], text))
        runs[-1].addnext(insertion)

    def delete_paragraph(self, p) -> None:
        runs = [c for c in p if c.tag == W_R]
        if runs:
            self._delete_runs(runs)
        # Mark the paragraph mark as deleted too, so that Word joins it with the next paragraph.
        self._paragraph_mark(p, "w:del")

    def insert_paragraph_after(self, p, text: str) -> None:
        new_p = OxmlElement("w:p")
        ppr = p.find(qn("w:pPr"))
        if ppr is not None:
            new_ppr = copy.deepcopy(ppr)
            for change in new_ppr.findall(qn("w:pPrChange")):
                new_ppr.remove(change)
            new_p.append(new_ppr)
        template = next((r for r in p.iter(W_R)), None)
        insertion = self._mark("w:ins")
        insertion.append(self._new_run(template, text))
        new_p.append(insertion)
        self._paragraph_mark(new_p, "w:ins")
        p.addnext(new_p)

    def _paragraph_mark(self, p, tag: str) -> None:
        ppr = p.find(qn("w:pPr"))
        if ppr is None:
            ppr = OxmlElement("w:pPr")
            p.insert(0, ppr)
        rpr = ppr.find(qn("w:rPr"))
        if rpr is None:
            rpr = OxmlElement("w:rPr")
            # w:rPr comes near the end of w:pPr: before w:sectPr and w:pPrChange.
            later = [c for c in ppr if c.tag in (qn("w:sectPr"), qn("w:pPrChange"))]
            if later:
                later[0].addprevious(rpr)
            else:
                ppr.append(rpr)
        rpr.insert(0, self._mark(tag))


def apply(doc, changes: list[dict], author: str) -> list[str]:
    red = Redliner(doc, author)
    done = []
    for number, change in enumerate(changes, 1):
        op = change.get("op", "replace")
        find = change.get("find", "")
        try:
            if op == "replace":
                if "replace" not in change:
                    raise MatchError("A replace needs 'replace' (use \"\" to delete).")
                if change.get("all"):
                    matches = list(find_matches(doc, find)) if find else []
                    if not matches:
                        raise MatchError(f"The text {find!r} is not in the document.")
                    # Work from the end, so that the earlier offsets stay correct.
                    for p, start in reversed(matches):
                        red.replace(p, start, find, change["replace"])
                    done.append(f"{number}. Replaced {len(matches)} x {find!r} with {change['replace']!r}")
                    continue
                p, start = pick_match(doc, find, int(change.get("occurrence", 1)))
                red.replace(p, start, find, change["replace"])
                done.append(f"{number}. Replaced {find!r} with {change['replace']!r}")
            elif op == "insert_after":
                p, start = pick_match(doc, find, int(change.get("occurrence", 1)))
                red.insert_after(p, start, find, change["text"])
                done.append(f"{number}. Inserted {change['text']!r} after {find!r}")
            elif op == "delete_paragraph":
                p, _ = pick_match(doc, find, int(change.get("occurrence", 1)))
                red.delete_paragraph(p)
                done.append(f"{number}. Deleted the paragraph that contains {find!r}")
            elif op == "insert_paragraph_after":
                p, _ = pick_match(doc, find, int(change.get("occurrence", 1)))
                red.insert_paragraph_after(p, change["text"])
                done.append(f"{number}. Inserted a paragraph after the paragraph that contains {find!r}")
            else:
                raise MatchError(f"Unknown op {op!r}. Use replace, insert_after, delete_paragraph, or insert_paragraph_after.")
        except (MatchError, KeyError) as e:
            raise MatchError(f"Change {number} failed: {e}") from None
    for p in doc.element.body.iter(qn("w:p")):
        merge_runs(p)
    return done


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("file", type=Path, help="The .docx file.")
    parser.add_argument("changes", type=Path, help="The JSON file with the list of changes.")
    parser.add_argument("-o", "--output", type=Path, help="The output file. Default: change the file in place.")
    parser.add_argument("--author", default="Harness", help="The author name that Word shows for the changes.")
    args = parser.parse_args()
    changes = json.loads(args.changes.read_text(encoding="utf-8"))
    if isinstance(changes, dict):
        changes = [changes]
    doc = Document(str(args.file))
    try:
        done = apply(doc, changes, args.author)
    except MatchError as e:
        sys.exit(f"{e}\nThe script saved nothing.")
    out = args.output or args.file
    doc.save(str(out))
    print("\n".join(done))
    print(f"Saved {out} with {len(done)} tracked changes by {args.author}.")


if __name__ == "__main__":
    main()
