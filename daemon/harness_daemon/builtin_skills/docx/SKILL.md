---
name: docx
description: "Use for any Word document task: make, read, edit, or review a .docx or .dotx file (report, letter, memo, contract, template). Also for tracked changes (redlines), comments, tables, images, page numbers, and a table of contents in Word, and .doc to .docx. Not for PDF or spreadsheets."
---

# Word documents (.docx)

A .docx file is a ZIP archive of XML files. `word/document.xml` holds the main text. Other parts hold the styles, the numbering, the headers, the footers, the comments, and the images.

The scripts are in `${CLAUDE_SKILL_DIR}/scripts`. The shared Office scripts are in `${CLAUDE_SKILL_DIR}/../_office`.

## 1. Choose the method

| Task | Method |
|---|---|
| Read the text | The `read` tool. It numbers the paragraphs [P1] and the table cells. |
| Change some text and keep the format | The `office_edit` tool (replace, set_paragraph, insert_paragraph, set_cell). |
| Make a new document | A Python script with python-docx and `scripts/docx_helpers.py` (section 3). |
| Make a document from a template | `new_document(template="template.dotx")` in the same script (section 3). |
| Tracked changes (redline) | `scripts/redline.py` (section 5). |
| Comments | `scripts/comment.py` (section 5). |
| Accept or reject all changes | `scripts/accept_changes.py` (section 5). |
| Other changes: formats, footnotes, fields, complex tables | Edit the XML (section 6). |
| Convert .doc to .docx | `soffice --headless --convert-to docx file.doc` |
| Look at the pages | `../_office/render.py` (section 7). |

Use the simplest method that does the task. Do not make a new file when the user asks you to change a file.

## 2. Set up

The scripts need Python 3.9 or later and python-docx 1.2 or later. On Windows the command is `python`. On macOS and Linux it is often `python3`.

1. Run `python -c "import docx; print(docx.__version__)"`.
2. If the import fails or the version is less than 1.2, run `python -m pip install -U python-docx`.
3. To look at pages, LibreOffice and pypdfium2 are necessary (section 7). They are optional.

## 3. Make a new document

1. Collect the content: the title, the sections, the tables, the images.
2. Write a build script, for example `build_report.py`, in the project folder.
3. Run the script. Fix each error and run it again.
4. Check the result (section 7).
5. Tell the user the file name. In Harness, call `show_document` so that the user can see the file.

Start the script with the helpers:

```python
import sys
sys.path.insert(0, r"${CLAUDE_SKILL_DIR}/scripts")
from docx_helpers import *

doc = new_document(page="letter", margins=1.0, font="Calibri", size=11)
style_headings(doc, color="1F3864")
doc.add_heading("Quarterly Report", level=0)       # level 0 is the Title style
doc.add_paragraph("Prepared for the board, October 2026.")
add_toc(doc)                                       # Word fills it when the user opens the file
page_break(doc)
doc.add_heading("Summary", level=1)
doc.add_paragraph("Revenue increased in all regions.")
add_bullets(doc, ["North: +12%", "South: +8%", ["Two new stores", "One closed store"]])
add_numbered(doc, ["Approve the budget", "Hire two engineers"])
add_table(doc, [["Region", "Revenue (USD)"], ["North", "1,200,000"], ["South", "900,000"]], widths=[3.0, 2.0])
add_caption(doc, "Revenue by region", label="Table")
add_image(doc, "chart.png", width=6.0)
add_page_numbers(doc.sections[0])
doc.save("Quarterly Report.docx")
```

The helpers are: `new_document`, `set_font`, `style_headings`, `set_margins`, `set_landscape`, `page_break`, `add_bullets`, `add_numbered`, `add_table`, `shade_cell`, `set_col_widths`, `repeat_header_row`, `keep_with_next`, `add_field`, `add_toc`, `update_fields_on_open`, `add_page_numbers`, `add_hyperlink`, `add_image`, `add_caption`. Read the file for the parameters.

### Rules for a new document

- **Page size.** Use `letter` for the US and Canada. Use `a4` for other countries. If you do not know the country, use `letter` and tell the user.
- **Headings.** Use the built-in heading styles (`add_heading`). Do not make a heading with bold body text. The table of contents and the navigation pane need the heading styles.
- **Lists.** Use `add_bullets` and `add_numbered`. Do not type "•", "-", or "1." at the start of a paragraph. Word does not see typed characters as a list.
- **Numbered lists.** `add_numbered` starts at 1 each time. Use `restart=False` to continue the last list.
- **Tables.** Give the column widths. The sum of the widths must not be more than the text width (the page width minus the margins). For letter with 1 inch margins, the text width is 6.5 inches.
- **Images.** Give only the width. The height keeps the aspect ratio. The width must not be more than the text width.
- **Page breaks.** Use `page_break`. Do not add empty paragraphs to push text to the next page.
- **Space.** Use the paragraph format (`paragraph_format.space_after = Pt(6)`) for space between paragraphs. Do not add empty paragraphs.
- **Fonts.** Use one font for the body and at most one more font for the headings. Use common fonts: Calibri, Arial, Aptos, Georgia, Cambria, Times New Roman.
- **Text.** Write the full content. Do not write placeholder text such as "Lorem ipsum" or "[Insert text here]" unless the user asks for a template.
- **Characters.** Write text as normal Unicode. python-docx escapes the XML characters.
- **Fields.** A script cannot calculate page numbers or a table of contents. `add_toc` and `add_page_numbers` add fields that Word calculates. Tell the user that Word asks to update the fields when it opens the file.

## 4. Change an existing document

1. Read the file with the `read` tool.
2. For text changes, use `office_edit`. A replace keeps the format when the text is in one run.
3. For changes that `office_edit` cannot do, use a python-docx script or edit the XML (section 6).
4. Keep the styles, the fonts, the numbering, and the layout that the document has. Change only what the user asks for.
5. Save to the same file only if the user wants that. Otherwise save to a new file name, for example `report-edited.docx`.
6. Check the result (section 7).

A script that opens and saves a document with python-docx keeps the parts that python-docx does not know (charts, SmartArt, content controls). It does not keep a `.doc` file: convert it first.

## 5. Review: tracked changes and comments

Use tracked changes when the user asks for a redline, for suggested changes, or for changes that another person must approve. Do not use them for a normal edit.

### Tracked changes

Write a JSON file with the changes, then run the script:

```json
[
  {"find": "30 days", "replace": "45 days"},
  {"find": "Seller", "replace": "Supplier", "all": true},
  {"find": "Section 4", "replace": "Section 5", "occurrence": 2},
  {"op": "insert_after", "find": "including", "text": " without limitation"},
  {"op": "delete_paragraph", "find": "This clause is void."},
  {"op": "insert_paragraph_after", "find": "1. Term.", "text": "1A. Renewal. The term renews each year."}
]
```

```
python "${CLAUDE_SKILL_DIR}/scripts/redline.py" contract.docx changes.json -o "contract (redline).docx" --author "Harness"
```

- Copy each `find` text exactly from the `read` output. The text must be in one paragraph.
- Change only the words that change. For "30 days" to "45 days", use `{"find": "30", "replace": "45"}` if "30" occurs once. A small change is easier to review.
- If one change fails, the script saves nothing and prints the reason. Fix that change and run the script again.
- Use the author name that the user gives. The default is "Harness".

### Comments

```json
[
  {"find": "revenue grew 40%", "text": "Add the source of this number."},
  {"find": "Q3", "text": "Is this Q3 of this year?", "occurrence": 2}
]
```

```
python "${CLAUDE_SKILL_DIR}/scripts/comment.py" report.docx comments.json -o "report (reviewed).docx" --author "Harness"
```

### Accept or reject all changes

```
python "${CLAUDE_SKILL_DIR}/scripts/accept_changes.py" draft.docx -o clean.docx
python "${CLAUDE_SKILL_DIR}/scripts/accept_changes.py" draft.docx -o original.docx --reject
```

Use `--reject` to get the text before the changes.

## 6. Edit the XML

Use this method for changes that python-docx cannot do. Read `${CLAUDE_SKILL_DIR}/reference/word-xml.md` first. It shows the XML of paragraphs, runs, tables, tracked changes, comments, footnotes, and fields.

1. Unpack the file:
   `python "${CLAUDE_SKILL_DIR}/../_office/ooxml.py" unpack report.docx report_xml`
2. Find the text with `grep` in `report_xml/word/document.xml`.
3. Change the XML with the `edit` tool. Change the smallest possible part.
4. Pack the folder to a new file:
   `python "${CLAUDE_SKILL_DIR}/../_office/ooxml.py" pack report_xml report-edited.docx`
5. The pack command checks the file. Fix each problem that it reports.
6. Delete the unpacked folder when the work is complete.

## 7. Check the result

Always check a document that you make or change.

1. Read the file with the `read` tool. Make sure that all text is there.
2. Check the file structure:
   `python "${CLAUDE_SKILL_DIR}/../_office/ooxml.py" check report.docx`
3. If the model of this session accepts images, look at the pages:
   `python "${CLAUDE_SKILL_DIR}/../_office/render.py" images report.docx --dpi 70`
   Then open each PNG with the `read` tool. Look for text that overflows, tables that are too wide, images that are too large, and empty pages.
4. If LibreOffice is not installed, step 3 fails. Then skip it, and tell the user that you did not check the layout.
5. Call `show_document` so that the user can see the document in the Preview pane.
6. Delete the PNG files and the build script if the user does not need them. Keep the build script if the user will make the document again.
