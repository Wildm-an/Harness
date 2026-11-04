"""Helpers for openpyxl: styles, number formats, column widths, and tables.

    import sys
    sys.path.insert(0, r"<skill folder>/scripts")
    from xlsx_helpers import *

    wb = Workbook()
    ws = wb.active
    ws.title = "Model"
    write_rows(ws, [["Item", "2025", "2026"], ["Revenue", 1000, "=B2*1.1"]])
    style_header_row(ws, 1)
    mark_inputs(ws, "B2:B2")
    number_format(ws, "B2:C2", FORMATS["currency0"])
    autofit_columns(ws)
    freeze(ws, "B2")
    wb.save("model.xlsx")
"""

from __future__ import annotations

from openpyxl import Workbook, load_workbook
from openpyxl.formatting.rule import CellIsRule, ColorScaleRule
from openpyxl.styles import Alignment, Border, Font, PatternFill, Side
from openpyxl.utils import get_column_letter
from openpyxl.worksheet.datavalidation import DataValidation
from openpyxl.worksheet.table import Table, TableStyleInfo

__all__ = [
    "Workbook", "load_workbook", "Font", "PatternFill", "Alignment", "Border", "Side",
    "INPUT_FONT", "FORMULA_FONT", "LINK_FONT", "EXTERNAL_FONT", "ASSUMPTION_FILL", "FORMATS",
    "write_rows", "style_header_row", "mark_inputs", "mark_links", "number_format", "autofit_columns",
    "freeze", "add_table", "add_list_validation", "highlight_negative", "add_color_scale", "thin_border",
]

# The color code of financial models. Blue: a number that a person types. Black: a formula.
# Green: a formula that gets a value from another sheet. Red: a link to another file.
INPUT_FONT = Font(color="0000FF")
FORMULA_FONT = Font(color="000000")
LINK_FONT = Font(color="008000")
EXTERNAL_FONT = Font(color="FF0000")
ASSUMPTION_FILL = PatternFill("solid", fgColor="FFFF00")

FORMATS = {
    "integer": "#,##0",
    "number2": "#,##0.00",
    "currency0": '"$"#,##0;("$"#,##0);"-"',
    "currency2": '"$"#,##0.00;("$"#,##0.00);"-"',
    "thousands": '#,##0,"K";(#,##0,"K");"-"',
    "millions": '#,##0.0,,"M";(#,##0.0,,"M");"-"',
    "accounting": "#,##0;(#,##0);\"-\"",
    "percent0": "0%",
    "percent1": "0.0%",
    "multiple": '0.0"x"',
    "date": "yyyy-mm-dd",
    "year": "0",  # A year as a number with no thousands separator: 2026, not 2,026.
}


def _cells(ws, ref: str):
    """The cells of "B4", "B2:D9", or "C:C"."""
    target = ws[ref]
    if not isinstance(target, tuple):
        yield target
        return
    for row in target:
        if isinstance(row, tuple):
            yield from row
        else:
            yield row


def write_rows(ws, rows: list[list], start: str = "A1") -> None:
    """Write rows of values from a start cell. A string that starts with = is a formula."""
    first = ws[start]
    for r, values in enumerate(rows):
        for c, value in enumerate(values):
            ws.cell(row=first.row + r, column=first.column + c, value=value)


def style_header_row(ws, row: int = 1, fill: str = "1F3864", color: str = "FFFFFF", bold: bool = True,
                     wrap: bool = True) -> None:
    for cell in ws[row]:
        if cell.value is None:
            continue
        cell.font = Font(bold=bold, color=color)
        cell.fill = PatternFill("solid", fgColor=fill)
        cell.alignment = Alignment(horizontal="center", vertical="center", wrap_text=wrap)


def mark_inputs(ws, ref: str, assumption: bool = False) -> None:
    """Blue font for the cells that a person types. assumption=True also adds a yellow fill."""
    for cell in _cells(ws, ref):
        cell.font = Font(color="0000FF", bold=cell.font.bold, italic=cell.font.italic)
        if assumption:
            cell.fill = ASSUMPTION_FILL


def mark_links(ws, ref: str, external: bool = False) -> None:
    """Green font for formulas that get values from another sheet. Red for links to another file."""
    for cell in _cells(ws, ref):
        cell.font = Font(color="FF0000" if external else "008000", bold=cell.font.bold)


def number_format(ws, ref: str, fmt: str) -> None:
    for cell in _cells(ws, ref):
        cell.number_format = fmt


def autofit_columns(ws, min_width: float = 8, max_width: float = 60) -> None:
    """Set each column width from its longest value. Formulas count as 12 characters."""
    widths: dict[int, float] = {}
    for row in ws.iter_rows():
        for cell in row:
            if cell.value is None:
                continue
            text = str(cell.value)
            length = 12 if text.startswith("=") else max(len(line) for line in text.splitlines() or [""])
            widths[cell.column] = max(widths.get(cell.column, 0), length)
    for col, width in widths.items():
        ws.column_dimensions[get_column_letter(col)].width = max(min_width, min(max_width, width + 2))


def freeze(ws, cell: str = "A2") -> None:
    """Freeze the rows above and the columns to the left of the cell. "B2" freezes row 1 and column A."""
    ws.freeze_panes = cell


def add_table(ws, ref: str, name: str, style: str = "TableStyleMedium2", stripes: bool = True) -> Table:
    """An Excel table with filter buttons. The first row of ref is the header. The name has no spaces."""
    table = Table(displayName=name, ref=ref)
    table.tableStyleInfo = TableStyleInfo(name=style, showRowStripes=stripes, showColumnStripes=False)
    ws.add_table(table)
    return table


def add_list_validation(ws, ref: str, options: list[str], prompt: str | None = None) -> None:
    """A drop-down list in the cells."""
    dv = DataValidation(type="list", formula1='"' + ",".join(options) + '"', allow_blank=True)
    if prompt:
        dv.prompt, dv.showInputMessage = prompt, True
    ws.add_data_validation(dv)
    dv.add(ref)


def highlight_negative(ws, ref: str, color: str = "C00000") -> None:
    ws.conditional_formatting.add(ref, CellIsRule(operator="lessThan", formula=["0"], font=Font(color=color)))


def add_color_scale(ws, ref: str, low: str = "F8696B", mid: str = "FFEB84", high: str = "63BE7B") -> None:
    ws.conditional_formatting.add(ref, ColorScaleRule(start_type="min", start_color=low, mid_type="percentile",
                                                      mid_value=50, mid_color=mid, end_type="max", end_color=high))


def thin_border(ws, ref: str, color: str = "BFBFBF") -> None:
    side = Side(style="thin", color=color)
    for cell in _cells(ws, ref):
        cell.border = Border(left=side, right=side, top=side, bottom=side)
