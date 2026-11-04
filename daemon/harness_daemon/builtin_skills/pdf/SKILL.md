---
name: pdf
description: "Use for any PDF task: read or extract text and tables, fill a PDF form, merge, split, rotate, crop, watermark, encrypt, or decrypt PDFs, make a new PDF, convert pages to images, and OCR of scanned PDFs. Use when the user names a .pdf file or asks for a PDF as output."
---

# PDF files

The scripts are in `${CLAUDE_SKILL_DIR}/scripts`. The page image script is `${CLAUDE_SKILL_DIR}/../_office/render.py`. Code for common operations is in `${CLAUDE_SKILL_DIR}/reference/operations.md`.

## 1. Choose the method

| Task | Method |
|---|---|
| Read the text | The `read` tool, with `pages` for a long file. |
| Extract tables | pdfplumber (reference/operations.md, section Tables). |
| Look at a page (layout, charts, scans) | `render.py images file.pdf --pages 2`, then read the PNG. |
| Merge, split, rotate, crop, reorder pages | pypdf (reference/operations.md). |
| Watermark, stamp, page numbers | pypdf and reportlab (reference/operations.md). |
| Encrypt or decrypt | pypdf (reference/operations.md). |
| Fill a form with fields | `scripts/forms.py` (section 3). |
| Fill a form with no fields | `scripts/find_text.py` and `scripts/overlay_text.py` (section 4). |
| Make a new PDF | Section 5. |
| Text from a scan | OCR (reference/operations.md, section OCR). |
| Show the PDF to the user | The `show_document` tool. |

## 2. Set up

Install only what the task needs. On macOS and Linux the command is often `python3`.

| Library | Install | Use |
|---|---|---|
| pypdf | `python -m pip install pypdf` | Pages, merge, split, forms, encryption |
| pdfplumber | `python -m pip install pdfplumber` | Text with positions, tables |
| reportlab | `python -m pip install reportlab` | Make PDFs, write text on pages |
| pypdfium2 | `python -m pip install pypdfium2` | Page images |
| pytesseract | `python -m pip install pytesseract`, and the Tesseract program | OCR |

Check an import before you use a library: `python -c "import pypdf"`.

## 3. Fill a form that has fields

1. List the fields:
   `python "${CLAUDE_SKILL_DIR}/scripts/forms.py" fields form.pdf`
2. If the list is empty, the form has no fields. Go to section 4.
3. Match each field to the information of the user. Use the name, the type, the page, and the position. If a field name is not clear, look at the page image to see the label near the field position. The `rect` is in points from the bottom-left corner of the page.
4. Write a JSON file with the values:

   ```json
   {"full_name": "Ana Silva", "date": "2026-11-04", "agree": true, "country": "Portugal"}
   ```

   A check box takes true or false. A radio group or a choice field takes one of its `options`.
5. Fill the form:
   `python "${CLAUDE_SKILL_DIR}/scripts/forms.py" fill form.pdf values.json -o "form (filled).pdf"`
   Add `--flatten` only if the user wants values that nobody can change.
6. Check the result (section 6).

Do not guess information that the user did not give. Leave the field empty and tell the user which fields are empty.

## 4. Fill a form that has no fields

1. Look at each page: `render.py images form.pdf --dpi 80`, then read the PNG files.
2. Find the position of each label:
   `python "${CLAUDE_SKILL_DIR}/scripts/find_text.py" form.pdf "Name:"`
   Use `--words --page 1` to list all words, and `--lines --page 1` to list the fill-in lines.
3. Calculate the position of each value. Positions are in points from the top-left corner.
   - Value to the right of a label: `x` = label `x1` + 6, `top` = label `top`.
   - Value on a fill-in line: `x` = line `x0` + 4, `top` = line `top` - size - 2.
   - Check box: put "X" at the center of the box.
4. Write the entries:

   ```json
   [
     {"page": 1, "x": 152, "top": 118, "text": "Ana Silva"},
     {"page": 1, "x": 71, "top": 300, "text": "X", "size": 12, "bold": true}
   ]
   ```

5. Write the text on the pages:
   `python "${CLAUDE_SKILL_DIR}/scripts/overlay_text.py" form.pdf entries.json -o "form (filled).pdf"`
6. Look at the result (section 6). Move each value that is not in its place, and run step 5 again from the original file.

## 5. Make a new PDF

Select the method from the content:

| Content | Method |
|---|---|
| A report, a letter, or a document with headings and tables | Make a Word file with the `docx` skill, then convert it: `soffice --headless --convert-to pdf report.docx`. Or use reportlab Platypus (reference/operations.md). |
| Exact positions: a certificate, a label, a form | reportlab canvas (reference/operations.md). |
| A page from HTML | If the project has a browser tool or Playwright, print the HTML page to PDF. |

Rules:

- Use the page size of the user: letter in the US and Canada, A4 in other countries.
- Keep margins of at least 0.75 inch (54 points).
- The built-in reportlab fonts (Helvetica, Times, Courier) have Latin characters only. For other characters, register a TrueType font (`TTFont`).
- Do not draw Unicode subscript or superscript characters with the built-in fonts. Use `<sub>` and `<super>` in a Platypus `Paragraph`.

## 6. Check the result

1. Read the text with the `read` tool.
2. Make page images and read them: `render.py images result.pdf --dpi 80 --pages 1-3`. Look for text in the wrong place, text that overlaps, and empty pages.
3. Call `show_document` so that the user can see the PDF.
4. Delete the PNG files and the JSON files when you are done, unless the user wants them.

## Cautions

- A scan has no text. `read` and pdfplumber return nothing for it. Use OCR.
- A PDF with a password needs the password from the user. Do not try to break the password.
- Do not change the original file. Write the result to a new file, unless the user asks for a change in place.
