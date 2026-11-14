"""Harness: pack an unpacked Office folder into a .docx, .pptx, or .xlsx file.

This does the same as `(cd unpacked && rm -f ../out.docx && zip -XrD ../out.docx .)`, for a
computer that has no `zip` command (for example Git Bash on Windows):

    python scripts/office/pack.py unpacked/ out.docx

The file has no folder entries, and [Content_Types].xml is the first entry. An old output file is
replaced, so parts that you deleted from the folder do not stay in it.
"""

import sys
import zipfile
from pathlib import Path


def pack(folder: Path, out: Path) -> None:
    files = sorted(p for p in folder.rglob("*") if p.is_file() and not p.is_symlink())
    files.sort(key=lambda p: p.relative_to(folder).as_posix() != "[Content_Types].xml")
    out.unlink(missing_ok=True)
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
        for path in files:
            z.write(path, path.relative_to(folder).as_posix())


if __name__ == "__main__":
    if len(sys.argv) != 3:
        sys.exit("Usage: python pack.py <unpacked folder> <output file>")
    pack(Path(sys.argv[1]), Path(sys.argv[2]))
    print(f"Packed {sys.argv[2]}")
