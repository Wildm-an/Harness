"""Check the formulas of a workbook, and calculate their values with LibreOffice.

    python recalc.py model.xlsx            # check, and calculate with LibreOffice if it is installed
    python recalc.py model.xlsx --write    # also save the calculated values in the file
    python recalc.py model.xlsx --json     # the result as JSON

openpyxl writes formulas but not their values. Excel calculates the values when it opens the file.
Other programs and the read tool show no value until a program calculates the formulas.

The script does these checks:
1. Each formula: references to sheets that do not exist, "#REF!" in the formula, and unbalanced parentheses.
2. If LibreOffice is installed: it calculates all formulas and finds the cells with an error value
   (#DIV/0!, #REF!, #NAME?, #VALUE!, #N/A, #NUM!, #NULL!).
3. If LibreOffice is not installed: it finds the error values that the file has from its last calculation.

--write replaces the file with the LibreOffice copy, which has the calculated values. Keep a backup:
LibreOffice can change some formats. The script exits with code 1 if it finds a problem.
"""

from __future__ import annotations

import argparse
import json
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

ERRORS = ("#DIV/0!", "#REF!", "#NAME?", "#VALUE!", "#N/A", "#NUM!", "#NULL!", "#SPILL!", "#CALC!")
SHEET_REF = re.compile(r"(?:'((?:[^']|'')+)'|([A-Za-z_][\w.]*))!")

sys.path.insert(0, str(Path(__file__).resolve().parents[1].parent / "_office"))
from render import find_soffice  # noqa: E402


def static_problems(path: Path) -> tuple[int, list[dict]]:
    from openpyxl import load_workbook

    wb = load_workbook(path, data_only=False)
    names = {ws.title.lower() for ws in wb.worksheets}
    count, problems = 0, []
    for ws in wb.worksheets:
        for row in ws.iter_rows():
            for cell in row:
                value = cell.value
                if not (isinstance(value, str) and value.startswith("=")):
                    continue
                count += 1
                where = f"{ws.title}!{cell.coordinate}"
                if "#REF!" in value:
                    problems.append({"cell": where, "formula": value, "problem": "The formula contains #REF!."})
                if value.count("(") != value.count(")"):
                    problems.append({"cell": where, "formula": value, "problem": "The parentheses are not balanced."})
                # Text in quotes is not a sheet reference.
                bare = re.sub(r'"[^"]*"', '""', value)
                for m in SHEET_REF.finditer(bare):
                    sheet = (m.group(1) or m.group(2)).replace("''", "'")
                    if sheet.lower() not in names and not sheet.startswith("["):
                        problems.append({"cell": where, "formula": value,
                                         "problem": f"The sheet {sheet!r} does not exist."})
    return count, problems


def error_values(path: Path) -> tuple[list[dict], int]:
    """The cells with an error value, and the number of formula cells that have no value."""
    from openpyxl import load_workbook

    values = load_workbook(path, data_only=True)
    formulas = load_workbook(path, data_only=False)
    found, empty = [], 0
    for ws in formulas.worksheets:
        vs = values[ws.title]
        for row in ws.iter_rows():
            for cell in row:
                if not (isinstance(cell.value, str) and cell.value.startswith("=")):
                    continue
                value = vs[cell.coordinate].value
                if value is None:
                    empty += 1
                elif isinstance(value, str) and value in ERRORS:
                    found.append({"cell": f"{ws.title}!{cell.coordinate}", "formula": cell.value, "problem": f"The value is {value}."})
    return found, empty


def libreoffice_copy(path: Path, outdir: Path) -> Path | None:
    soffice = find_soffice()
    if not soffice:
        return None
    from openpyxl import load_workbook

    # Ask for a full calculation when the file opens.
    keep_vba = path.suffix.lower() == ".xlsm"
    wb = load_workbook(path, keep_vba=keep_vba)
    wb.calculation.fullCalcOnLoad = True
    src = outdir / f"in{path.suffix}"
    wb.save(src)
    out = outdir / "out"
    out.mkdir()
    with tempfile.TemporaryDirectory() as profile:
        cmd = [soffice, f"-env:UserInstallation={Path(profile).as_uri()}", "--headless", "--calc",
               "--convert-to", "xlsx:Calc MS Excel 2007 XML", "--outdir", str(out), str(src)]
        subprocess.run(cmd, capture_output=True, text=True, timeout=300)
    result = out / "in.xlsx"
    return result if result.exists() else None


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("file", type=Path)
    parser.add_argument("--write", action="store_true", help="Save the values that LibreOffice calculated in the file.")
    parser.add_argument("--json", action="store_true", help="Print the result as JSON.")
    args = parser.parse_args()
    path = args.file.resolve()
    count, problems = static_problems(path)
    calculated = False
    empty = 0
    with tempfile.TemporaryDirectory() as tmp:
        copy = libreoffice_copy(path, Path(tmp))
        if copy is not None:
            calculated = True
            errors, empty = error_values(copy)
            problems += errors
            if args.write and path.suffix.lower() == ".xlsx":
                shutil.copyfile(copy, path)
        else:
            errors, empty = error_values(path)
            problems += errors
    result = {
        "file": str(path),
        "formulas": count,
        "calculated_by_libreoffice": calculated,
        "formulas_without_value": empty,
        "problems": problems,
        "status": "ok" if not problems else "problems",
    }
    if args.json:
        print(json.dumps(result, indent=2))
    else:
        print(f"{count} formulas in {path.name}.")
        if calculated:
            print("LibreOffice calculated all formulas." + (" The file now has the values." if args.write else ""))
        else:
            print("LibreOffice is not installed. The script did not calculate the formulas. "
                  f"{empty} formulas have no value yet. Excel calculates them when it opens the file.")
        for p in problems:
            print(f"- {p['cell']}: {p['problem']}  {p['formula']}")
        print("No problems found." if not problems else f"{len(problems)} problems found. Fix them and run the script again.")
    sys.exit(1 if problems else 0)


if __name__ == "__main__":
    main()
