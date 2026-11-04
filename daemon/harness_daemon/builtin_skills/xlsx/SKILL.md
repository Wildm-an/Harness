---
name: xlsx
description: "Use for any spreadsheet task where a spreadsheet file is the input or the output: make, read, edit, clean, or analyze .xlsx, .xlsm, .csv, or .tsv files. Includes formulas, financial models, budgets, charts, formats, pivots, and data cleanup. Not for a Word report, a PDF, or a Google Sheet."
---

# Spreadsheets (.xlsx, .xlsm, .csv)

The scripts are in `${CLAUDE_SKILL_DIR}/scripts`. The shared Office scripts are in `${CLAUDE_SKILL_DIR}/../_office`.

## 1. Choose the method

| Task | Method |
|---|---|
| Read a workbook | The `read` tool. It shows each sheet with cell addresses. |
| Change some cells | The `office_edit` tool (set, set_rows, add_sheet). |
| Analyze data, clean data, or read a large file | A Python script with pandas. |
| Make a workbook with formulas and formats | A Python script with openpyxl and `scripts/xlsx_helpers.py` (section 3). |
| Calculate the formulas and find errors | `scripts/recalc.py` (section 5). Always do this after you write formulas. |
| Make a chart | openpyxl charts (section 4). |
| Convert .xls to .xlsx | `soffice --headless --convert-to xlsx file.xls` |
| Look at the sheets | `../_office/render.py images book.xlsx` |

## 2. Set up

1. Run `python -c "import openpyxl, pandas"`. On macOS and Linux the command is often `python3`.
2. If the import fails, run `python -m pip install openpyxl pandas`.
3. LibreOffice is necessary to calculate formulas outside Excel. It is optional. Without it, `recalc.py` does only the static checks.

## 3. Make a workbook

1. Plan the sheets before you write the script. Put the inputs (assumptions) in one place, the calculations in another place, and the outputs in a third place. A small workbook can have all three on one sheet, in separate blocks.
2. Write a build script, for example `build_model.py`.
3. Run it. Then run `recalc.py` (section 5). Fix all problems.
4. Tell the user the file name and the main results.

```python
import sys
sys.path.insert(0, r"${CLAUDE_SKILL_DIR}/scripts")
from xlsx_helpers import *

wb = Workbook()
ws = wb.active
ws.title = "Model"
write_rows(ws, [
    ["Assumptions", None],
    ["Growth rate", 0.08],
    ["Start revenue", 500000],
    [None, None],
    ["Year", "2026", "2027", "2028"],
    ["Revenue", "=B3", "=B6*(1+B2)", "=C6*(1+B2)"],
])
mark_inputs(ws, "B2:B3", assumption=True)
number_format(ws, "B2", FORMATS["percent1"])
number_format(ws, "B3:D6", FORMATS["currency0"])
style_header_row(ws, 5)
autofit_columns(ws)
freeze(ws, "B6")
wb.save("model.xlsx")
```

The growth formula in a real model needs an absolute reference to B2. Read `${CLAUDE_SKILL_DIR}/reference/formulas.md` for absolute references and common formulas.

### Rules for formulas

- **Use formulas, not numbers that Python calculated.** If a value comes from other cells, write the formula. Then the workbook updates when the user changes an input. Calculate in Python only to check a result.
- **No numbers inside formulas.** Write `=B6*(1+B2)` with the growth rate in B2. Do not write `=B6*1.08`. Put each assumption in its own cell, with a label.
- **One formula for each row or column.** The same calculation uses the same formula pattern in each period.
- **Simple formulas.** Split a long formula into helper cells. A reader must understand each formula.
- **Divisions.** Protect a division that can be zero: `=IF(C5=0,0,B5/C5)` or `=IFERROR(B5/C5,0)`.
- **Ranges.** Make sure that a SUM includes all rows, also the rows that you add later.
- **No circular references**, unless the user asks for them.

### Rules for formats

- Use the color code of financial models in models and budgets:
  - Blue font: inputs that a person types (`mark_inputs`).
  - Black font: formulas.
  - Green font: formulas that get a value from another sheet (`mark_links`).
  - Red font: links to another file.
  - Yellow fill: key assumptions (`mark_inputs(..., assumption=True)`).
- Give each number column a number format (`FORMATS` in the helpers). Show negative numbers in parentheses in financial tables. Show zero as "-".
- Write years as text or with the format `FORMATS["year"]`, so that 2026 does not show as 2,026.
- Put the unit in the header: "Revenue (USD thousands)", "Margin (%)".
- Make the header row bold with a fill. Freeze the header row. Set the column widths (`autofit_columns`).
- Add a source note next to each hardcoded number that comes from a document or a web page: the source, the date, and the page or the URL.
- Use one font for the workbook. Do not use many colors. Use borders only to separate blocks.

### Rules for data

- Keep one table on each sheet when you can. Start it in A1. Use one header row.
- Do not merge cells inside a data table. Merged cells break sorting and filters.
- Store numbers as numbers and dates as dates, not as text.
- For CSV files, keep the encoding (often UTF-8) and the separator of the original file.

## 4. Charts

```python
from openpyxl.chart import BarChart, LineChart, Reference

chart = BarChart()
chart.title = "Revenue by year"
chart.y_axis.title = "USD"
data = Reference(ws, min_col=2, max_col=4, min_row=6, max_row=6)
cats = Reference(ws, min_col=2, max_col=4, min_row=5, max_row=5)
chart.add_data(data, from_rows=True, titles_from_data=False)
chart.set_categories(cats)
chart.width, chart.height = 18, 9
ws.add_chart(chart, "F2")
```

Use a bar chart to compare values, a line chart for values over time, and a pie chart only for parts of one whole with few parts.

## 5. Calculate and check

openpyxl writes formulas without their values. Run the check after each change of formulas:

```
python "${CLAUDE_SKILL_DIR}/scripts/recalc.py" model.xlsx
```

- The script finds references to sheets that do not exist, `#REF!` in formulas, and unbalanced parentheses.
- If LibreOffice is installed, it calculates all formulas and lists each cell with an error value (`#DIV/0!`, `#REF!`, `#NAME?`, `#VALUE!`, `#N/A`).
- Fix each problem in the build script. Run the build script and the check again, until the check finds no problems.
- Add `--write` to save the calculated values in the file. Then programs that do not calculate (and the `read` tool) show the values. Do this as the last step, and only for .xlsx files.
- Read the result with the `read` tool. Check some values by hand: a total, a growth rate, a last period.

## 6. Change an existing workbook

1. Read the workbook with the `read` tool. Find the structure, the formats, and the formula patterns.
2. For a few cells, use `office_edit`.
3. For more changes, use openpyxl: `load_workbook("book.xlsx")`. For a .xlsm file, use `load_workbook("book.xlsm", keep_vba=True)`.
4. Use the formats and formula patterns that the workbook has. Do not change the layout unless the user asks.
5. Run `recalc.py`.

Cautions:

- **Never save a workbook that you opened with `data_only=True`.** That workbook has values instead of formulas. Saving it removes all formulas. Use `data_only=True` only to read values.
- openpyxl does not keep shapes, some charts, and some images of an existing file. If the workbook has these, tell the user before you save it with openpyxl. For a small change, use `office_edit`, or edit the XML with `../_office/ooxml.py`.
- pandas `to_excel` writes values only, without formats. Use it for data exports, not to change a formatted workbook.
