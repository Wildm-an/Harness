# Formulas: references, common functions, and errors

## Relative and absolute references

| Reference | When you copy the formula to another cell |
|---|---|
| `B2` | The column and the row change. |
| `$B$2` | Nothing changes. Use it for one assumption cell. |
| `$B2` | The column stays B. The row changes. |
| `B$2` | The row stays 2. The column changes. |

A growth formula across years: `=B6*(1+$B$2)` in C6, then `=C6*(1+$B$2)` in D6.

In a Python string, write the formula exactly as Excel shows it: `ws["C6"] = "=B6*(1+$B$2)"`.

## References to other sheets

- `=Inputs!B4`
- `='Sales Data'!B4` (quotes if the sheet name has a space or a special character)
- `=SUM('Q1 Sales'!B2:B50)`

The sheet must exist when Excel calculates the formula. A misspelled sheet name gives `#REF!`.

## Named ranges

```python
from openpyxl.workbook.defined_name import DefinedName
wb.defined_names["GrowthRate"] = DefinedName("GrowthRate", attr_text="Model!$B$2")
ws["C6"] = "=B6*(1+GrowthRate)"
```

A name makes a formula easy to read. Use names for the main assumptions of a model.

## Common functions

| Task | Formula |
|---|---|
| Sum, average | `=SUM(B2:B20)`, `=AVERAGE(B2:B20)` |
| Sum with a condition | `=SUMIF(A2:A20,"North",B2:B20)`, `=SUMIFS(C:C,A:A,"North",B:B,">=2026")` |
| Count with a condition | `=COUNTIF(A2:A20,"Done")`, `=COUNTIFS(...)` |
| Look up a value | `=XLOOKUP(E2,A2:A50,B2:B50,"Not found")`, or `=INDEX(B2:B50,MATCH(E2,A2:A50,0))` for old Excel versions |
| Condition | `=IF(B2>0,"Profit","Loss")`, `=IFS(...)` |
| Safe division | `=IFERROR(B2/C2,0)` |
| Growth | `=C2/B2-1` |
| Compound annual growth | `=(F2/B2)^(1/4)-1` for 4 periods |
| Net present value | `=NPV($B$1,C5:G5)+B5` (B5 is the cash flow of period 0) |
| Internal rate of return | `=IRR(B5:G5)` |
| Loan payment | `=PMT(rate/12,years*12,-amount)` |
| Round | `=ROUND(B2,2)` |
| Text | `=A2&" "&B2`, `=TEXT(B2,"0.0%")` |
| Dates | `=EDATE(B2,1)` (next month), `=EOMONTH(B2,0)` (end of month), `=YEAR(B2)` |

`XLOOKUP`, `FILTER`, `UNIQUE`, `SORT`, and `LET` need Excel 2021 or Microsoft 365. LibreOffice 24.8 and later also has them. If the user has an old Excel version, use `INDEX` and `MATCH`.

openpyxl may need the `_xlfn.` prefix for new functions in the file: write `=_xlfn.XLOOKUP(...)`. Excel shows the formula without the prefix. If `recalc.py` reports `#NAME?` for a new function, add the prefix.

## Error values

| Error | Cause | Fix |
|---|---|---|
| `#DIV/0!` | A division by zero or by an empty cell. | Check the divisor, or use `IFERROR` / `IF`. |
| `#REF!` | A reference to a cell or sheet that does not exist. | Correct the reference or the sheet name. |
| `#NAME?` | An unknown function or name, or text without quotes. | Correct the spelling. Add quotes to text. Add `_xlfn.` to new functions. |
| `#VALUE!` | The wrong type, for example text in a calculation. | Store numbers as numbers. |
| `#N/A` | A lookup found no match. | Check the lookup value, or give a default value. |
| `#NUM!` | A number that is not possible, for example IRR with no solution. | Check the inputs. |
| `#SPILL!` | A dynamic array has no space for its result. | Clear the cells below or to the right. |

## Financial model layout

1. A cover or summary sheet with the key outputs.
2. An inputs sheet with all assumptions, in blue font, each with a label, a unit, and a source.
3. Calculation sheets. Time runs from left to right: one column for each period.
4. Output sheets: tables and charts that refer to the calculations.
5. A check row: for example, assets minus liabilities minus equity must be zero. Show "OK" or "ERROR".
