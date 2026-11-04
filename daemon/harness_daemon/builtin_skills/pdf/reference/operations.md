# PDF operations: code examples

Page numbers in pypdf start at 0. Page numbers for the user start at 1.

## Merge

```python
from pypdf import PdfWriter

writer = PdfWriter()
for path in ["a.pdf", "b.pdf", "c.pdf"]:
    writer.append(path)
writer.write("merged.pdf")
```

`writer.append("b.pdf", pages=(0, 3))` adds only pages 1 to 3.

## Split

```python
from pypdf import PdfReader, PdfWriter

reader = PdfReader("big.pdf")
for i, page in enumerate(reader.pages, 1):
    writer = PdfWriter()
    writer.add_page(page)
    writer.write(f"page-{i:03d}.pdf")
```

## Extract, delete, or reorder pages

```python
reader = PdfReader("in.pdf")
writer = PdfWriter()
for n in [3, 1, 2]:                 # the new order, numbers start at 1
    writer.add_page(reader.pages[n - 1])
writer.write("out.pdf")
```

## Rotate and crop

```python
writer = PdfWriter(clone_from="in.pdf")
writer.pages[0].rotate(90)          # clockwise, a multiple of 90
page = writer.pages[1]
page.cropbox.lower_left = (50, 50)  # points from the bottom-left corner
page.cropbox.upper_right = (562, 742)
writer.write("out.pdf")
```

## Watermark or stamp

Make the stamp with reportlab, then merge it on each page:

```python
import io
from pypdf import PdfReader, PdfWriter
from reportlab.pdfgen import canvas

def stamp_page(width, height, text):
    buf = io.BytesIO()
    c = canvas.Canvas(buf, pagesize=(width, height))
    c.setFont("Helvetica-Bold", 60)
    c.setFillColorRGB(0.8, 0.1, 0.1, alpha=0.2)
    c.translate(width / 2, height / 2)
    c.rotate(45)
    c.drawCentredString(0, 0, text)
    c.save()
    buf.seek(0)
    return PdfReader(buf).pages[0]

writer = PdfWriter(clone_from="in.pdf")
for page in writer.pages:
    w, h = float(page.mediabox.width), float(page.mediabox.height)
    page.merge_page(stamp_page(w, h, "DRAFT"))
writer.write("draft.pdf")
```

Page numbers: the same method, with `c.drawCentredString(width / 2, 30, f"{n} / {total}")` for each page.

## Encrypt and decrypt

```python
writer = PdfWriter(clone_from="in.pdf")
writer.encrypt(user_password="open-me", owner_password="owner-secret", algorithm="AES-256")
writer.write("locked.pdf")

reader = PdfReader("locked.pdf")
reader.decrypt("open-me")
writer = PdfWriter(clone_from=reader)
writer.write("unlocked.pdf")
```

AES-256 needs the `cryptography` package: `python -m pip install cryptography`.

## Metadata

```python
reader = PdfReader("in.pdf")
print(reader.metadata)
writer = PdfWriter(clone_from=reader)
writer.add_metadata({"/Title": "Annual Report", "/Author": "Finance team"})
writer.write("out.pdf")
```

## Text with layout

```python
import pdfplumber

with pdfplumber.open("in.pdf") as pdf:
    for page in pdf.pages:
        print(page.extract_text(layout=True))
```

## Tables

```python
import pdfplumber
import pandas as pd

frames = []
with pdfplumber.open("report.pdf") as pdf:
    for page in pdf.pages:
        for table in page.extract_tables():
            if table and len(table) > 1:
                frames.append(pd.DataFrame(table[1:], columns=table[0]))
pd.concat(frames).to_excel("tables.xlsx", index=False)
```

If the tables have no lines, try `page.extract_tables({"vertical_strategy": "text", "horizontal_strategy": "text"})`. Compare the result with the page image: table extraction often joins or splits cells.

## Images in a PDF

```python
reader = PdfReader("in.pdf")
for n, page in enumerate(reader.pages, 1):
    for image in page.images:
        with open(f"p{n}-{image.name}", "wb") as f:
            f.write(image.data)
```

## OCR of a scan

Install Tesseract first (Windows: `winget install UB-Mannheim.TesseractOCR`; macOS: `brew install tesseract`; Linux: the `tesseract-ocr` package). Then:

```python
import pypdfium2 as pdfium
import pytesseract

pdf = pdfium.PdfDocument("scan.pdf")
for n in range(len(pdf)):
    image = pdf[n].render(scale=300 / 72).to_pil()
    print(f"--- Page {n + 1} ---")
    print(pytesseract.image_to_string(image, lang="eng"))
```

On Windows, if Python does not find Tesseract, set `pytesseract.pytesseract.tesseract_cmd = r"C:\Program Files\Tesseract-OCR\tesseract.exe"`.

## Make a PDF with reportlab Platypus (flowing text)

```python
from reportlab.lib.pagesizes import letter
from reportlab.lib.styles import getSampleStyleSheet
from reportlab.lib.units import inch
from reportlab.lib import colors
from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle, PageBreak

styles = getSampleStyleSheet()
doc = SimpleDocTemplate("report.pdf", pagesize=letter, leftMargin=inch, rightMargin=inch,
                        topMargin=inch, bottomMargin=inch, title="Report")
story = [
    Paragraph("Annual Report", styles["Title"]),
    Paragraph("Summary", styles["Heading1"]),
    Paragraph("Revenue increased by 12%. H<sub>2</sub>O and x<super>2</super> use tags.", styles["BodyText"]),
    Spacer(1, 12),
]
table = Table([["Region", "Revenue"], ["North", "1,200"], ["South", "900"]], colWidths=[3 * inch, 1.5 * inch])
table.setStyle(TableStyle([
    ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#1F3864")),
    ("TEXTCOLOR", (0, 0), (-1, 0), colors.white),
    ("GRID", (0, 0), (-1, -1), 0.5, colors.grey),
    ("ALIGN", (1, 1), (-1, -1), "RIGHT"),
]))
story += [table, PageBreak(), Paragraph("Details", styles["Heading1"])]

def footer(canvas, doc):
    canvas.setFont("Helvetica", 9)
    canvas.drawCentredString(letter[0] / 2, 0.5 * inch, f"Page {doc.page}")

doc.build(story, onFirstPage=footer, onLaterPages=footer)
```

`Paragraph` text is a small markup language: escape `&` as `&amp;` and `<` as `&lt;` in normal text.

## Make a PDF with the reportlab canvas (exact positions)

```python
from reportlab.lib.pagesizes import letter, landscape
from reportlab.pdfgen import canvas

c = canvas.Canvas("certificate.pdf", pagesize=landscape(letter))
w, h = landscape(letter)
c.setFont("Times-Bold", 36)
c.drawCentredString(w / 2, h - 150, "Certificate of Completion")   # y is from the bottom
c.setFont("Times-Roman", 18)
c.drawCentredString(w / 2, h - 220, "Ana Silva")
c.rect(36, 36, w - 72, h - 72)
c.showPage()
c.save()
```

## Fonts for other characters

```python
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont

pdfmetrics.registerFont(TTFont("DejaVu", "DejaVuSans.ttf"))   # a path to a .ttf file
c.setFont("DejaVu", 12)
```

On Windows, fonts are in `C:\Windows\Fonts` (for example `arial.ttf`). On macOS, in `/System/Library/Fonts` and `/Library/Fonts`. On Linux, in `/usr/share/fonts`.
