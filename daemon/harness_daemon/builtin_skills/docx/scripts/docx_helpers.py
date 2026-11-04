"""Helpers for python-docx: the Word features that python-docx has no simple function for.

Import this file in your build script:

    import sys
    sys.path.insert(0, r"<skill folder>/scripts")
    from docx_helpers import *

    doc = new_document(page="letter", font="Calibri", size=11)
    doc.add_heading("Annual Report", level=0)
    add_toc(doc)
    page_break(doc)
    doc.add_heading("Summary", level=1)
    add_bullets(doc, ["First point", "Second point"])
    add_numbered(doc, ["Step one", "Step two"])
    add_table(doc, [["Name", "Value"], ["A", "1"]], widths=[3.0, 1.5])
    add_page_numbers(doc.sections[0])
    doc.save("report.docx")

All sizes are in inches unless the name says otherwise. Colors are hex strings such as "1F4E79".
"""

from __future__ import annotations

from docx import Document
from docx.enum.section import WD_ORIENT
from docx.enum.table import WD_TABLE_ALIGNMENT
from docx.enum.text import WD_ALIGN_PARAGRAPH, WD_BREAK
from docx.oxml import OxmlElement
from docx.oxml.ns import qn
from docx.shared import Inches, Pt, RGBColor

__all__ = [
    "new_document", "set_font", "style_headings", "page_break", "add_bullets", "add_numbered",
    "add_table", "shade_cell", "set_col_widths", "repeat_header_row", "keep_with_next",
    "add_toc", "add_field", "add_page_numbers", "add_hyperlink", "add_image", "add_caption",
    "set_landscape", "set_margins", "update_fields_on_open",
    "Inches", "Pt", "RGBColor", "WD_ALIGN_PARAGRAPH",
]

PAGE_SIZES = {"letter": (8.5, 11.0), "a4": (8.27, 11.69), "legal": (8.5, 14.0)}


def new_document(page: str = "letter", margins: float = 1.0, font: str = "Calibri", size: float = 11,
                 template: str | None = None):
    """A new document with a page size, margins, and a body font. Use "a4" outside the US and Canada.

    template: a .docx or .dotx file whose styles to use. Its content is removed.
    """
    doc = Document(template) if template else Document()
    if template:
        body = doc.element.body
        for child in list(body):
            if child.tag != qn("w:sectPr"):
                body.remove(child)
    for section in doc.sections:
        width, height = PAGE_SIZES[page.lower()]
        section.page_width, section.page_height = Inches(width), Inches(height)
        set_margins(section, margins)
    if not template:
        set_font(doc, font, size)
    return doc


def set_margins(section, all_sides: float | None = None, top: float | None = None, bottom: float | None = None,
                left: float | None = None, right: float | None = None) -> None:
    for name, value in (("top", top), ("bottom", bottom), ("left", left), ("right", right)):
        value = value if value is not None else all_sides
        if value is not None:
            setattr(section, f"{name}_margin", Inches(value))


def set_font(doc, name: str, size: float | None = None, style: str = "Normal") -> None:
    """Set the font of a style, also for East Asian text (python-docx sets only the Latin font)."""
    st = doc.styles[style]
    st.font.name = name
    if size:
        st.font.size = Pt(size)
    rpr = st.element.get_or_add_rPr()
    fonts = rpr.find(qn("w:rFonts"))
    if fonts is None:
        fonts = OxmlElement("w:rFonts")
        rpr.insert(0, fonts)
    for attr in ("w:ascii", "w:hAnsi", "w:eastAsia", "w:cs"):
        fonts.set(qn(attr), name)
    for theme_attr in ("w:asciiTheme", "w:hAnsiTheme", "w:eastAsiaTheme", "w:cstheme"):
        fonts.attrib.pop(qn(theme_attr), None)


def style_headings(doc, font: str | None = None, color: str | None = None,
                   sizes: dict[int, float] | None = None, bold: bool = True) -> None:
    """Change the built-in heading styles. Keep them: the table of contents and the navigation pane use them."""
    sizes = sizes or {}
    for level in range(0, 10):
        name = "Title" if level == 0 else f"Heading {level}"
        try:
            st = doc.styles[name]
        except KeyError:
            continue
        if font:
            set_font(doc, font, sizes.get(level), style=name)
        elif level in sizes:
            st.font.size = Pt(sizes[level])
        if color:
            st.font.color.rgb = RGBColor.from_string(color)
        if level:
            st.font.bold = bold


def page_break(doc) -> None:
    doc.add_paragraph().add_run().add_break(WD_BREAK.PAGE)


def add_bullets(doc, items: list, level: int = 0) -> list:
    """Bullet list items with the built-in list styles. An item that is a list is one level deeper."""
    paragraphs = []
    for item in items:
        if isinstance(item, (list, tuple)):
            paragraphs += add_bullets(doc, list(item), level + 1)
            continue
        style = "List Bullet" if level == 0 else f"List Bullet {min(level + 1, 3)}"
        paragraphs.append(doc.add_paragraph(str(item), style=style))
    return paragraphs


def _numbering_ids(doc, style: str) -> tuple[str, str]:
    """The numId of a list style, and its abstractNumId."""
    st = doc.styles[style].element
    num_id = st.find(".//" + qn("w:numId")).get(qn("w:val"))
    numbering = doc.part.numbering_part.element
    for num in numbering.findall(qn("w:num")):
        if num.get(qn("w:numId")) == num_id:
            return num_id, num.find(qn("w:abstractNumId")).get(qn("w:val"))
    raise KeyError(f"No numbering for the style {style}.")


def add_numbered(doc, items: list, restart: bool = True, style: str = "List Number") -> list:
    """A numbered list. restart=True starts the list at 1, also after an earlier numbered list."""
    _, abstract_id = _numbering_ids(doc, style)
    numbering = doc.part.numbering_part.element
    num_id = None
    if restart:
        used = [int(n.get(qn("w:numId"))) for n in numbering.findall(qn("w:num"))]
        num_id = str(max(used, default=0) + 1)
        num = OxmlElement("w:num")
        num.set(qn("w:numId"), num_id)
        abstract = OxmlElement("w:abstractNumId")
        abstract.set(qn("w:val"), abstract_id)
        num.append(abstract)
        override = OxmlElement("w:lvlOverride")
        override.set(qn("w:ilvl"), "0")
        start = OxmlElement("w:startOverride")
        start.set(qn("w:val"), "1")
        override.append(start)
        num.append(override)
        numbering.append(num)
    paragraphs = []
    for item in items:
        p = doc.add_paragraph(str(item), style=style)
        if num_id:
            numpr = p._p.get_or_add_pPr().get_or_add_numPr()
            numpr.get_or_add_ilvl().val = 0
            numpr.get_or_add_numId().val = int(num_id)
        paragraphs.append(p)
    return paragraphs


def shade_cell(cell, fill: str) -> None:
    """Fill a table cell with a color."""
    tcpr = cell._tc.get_or_add_tcPr()
    for old in tcpr.findall(qn("w:shd")):
        tcpr.remove(old)
    shd = OxmlElement("w:shd")
    shd.set(qn("w:val"), "clear")
    shd.set(qn("w:color"), "auto")
    shd.set(qn("w:fill"), fill)
    tcpr.append(shd)


def set_col_widths(table, widths: list[float]) -> None:
    """Set the column widths. Word needs the width on each cell and on the grid."""
    table.autofit = False
    grid = table._tbl.tblGrid
    for col, width in zip(grid.findall(qn("w:gridCol")), widths):
        col.set(qn("w:w"), str(int(width * 1440)))
    for row in table.rows:
        for cell, width in zip(row.cells, widths):
            cell.width = Inches(width)


def repeat_header_row(row) -> None:
    """Repeat this row at the top of each page when the table goes over a page break."""
    trpr = row._tr.get_or_add_trPr()
    header = OxmlElement("w:tblHeader")
    header.set(qn("w:val"), "true")
    trpr.append(header)


def add_table(doc, rows: list[list], widths: list[float] | None = None, header: bool = True,
              style: str = "Table Grid", header_fill: str | None = "D9E2F3", font_size: float | None = None,
              align: str = "center"):
    """A table from a list of rows. The first row is the header row when header=True."""
    table = doc.add_table(rows=len(rows), cols=max(len(r) for r in rows))
    table.style = doc.styles[style]
    table.alignment = {"left": WD_TABLE_ALIGNMENT.LEFT, "center": WD_TABLE_ALIGNMENT.CENTER}[align]
    for r, values in enumerate(rows):
        for c, value in enumerate(values):
            cell = table.cell(r, c)
            cell.text = "" if value is None else str(value)
            for run in cell.paragraphs[0].runs:
                if font_size:
                    run.font.size = Pt(font_size)
                if header and r == 0:
                    run.bold = True
            if header and r == 0 and header_fill:
                shade_cell(cell, header_fill)
    if header:
        repeat_header_row(table.rows[0])
    if widths:
        set_col_widths(table, widths)
    return table


def keep_with_next(paragraph, on: bool = True) -> None:
    """Keep the paragraph on the same page as the next one (for example, a caption and its table)."""
    paragraph.paragraph_format.keep_with_next = on


def add_field(paragraph, code: str, placeholder: str = ""):
    """A field such as PAGE, NUMPAGES, DATE, or TOC. Word calculates the value."""
    def fld_char(kind: str):
        run = OxmlElement("w:r")
        char = OxmlElement("w:fldChar")
        char.set(qn("w:fldCharType"), kind)
        run.append(char)
        return run

    p = paragraph._p
    p.append(fld_char("begin"))
    instr_run = OxmlElement("w:r")
    instr = OxmlElement("w:instrText")
    instr.set("{http://www.w3.org/XML/1998/namespace}space", "preserve")
    instr.text = f" {code} "
    instr_run.append(instr)
    p.append(instr_run)
    p.append(fld_char("separate"))
    shown = OxmlElement("w:r")
    text = OxmlElement("w:t")
    text.text = placeholder
    shown.append(text)
    p.append(shown)
    p.append(fld_char("end"))
    return paragraph


def add_toc(doc, levels: str = "1-3", title: str | None = "Contents"):
    """A table of contents from the heading styles. Word fills it when the user opens the file.

    The script cannot calculate page numbers. update_fields_on_open() makes Word ask to update the fields.
    """
    if title:
        doc.add_paragraph(title, style="TOC Heading" if "TOC Heading" in [s.name for s in doc.styles] else "Heading 1")
    p = doc.add_paragraph()
    add_field(p, f'TOC \\o "{levels}" \\h \\z \\u', "Open in Word and update the field to show the table of contents.")
    update_fields_on_open(doc)
    return p


def update_fields_on_open(doc) -> None:
    settings = doc.settings.element
    if settings.find(qn("w:updateFields")) is None:
        el = OxmlElement("w:updateFields")
        el.set(qn("w:val"), "true")
        settings.append(el)


def add_page_numbers(section, template: str = "Page {PAGE} of {NUMPAGES}", align: str = "center",
                     font_size: float | None = 9) -> None:
    """Page numbers in the footer of a section. {PAGE} and {NUMPAGES} become fields."""
    footer = section.footer
    p = footer.paragraphs[0] if footer.paragraphs else footer.add_paragraph()
    p.alignment = {"left": WD_ALIGN_PARAGRAPH.LEFT, "center": WD_ALIGN_PARAGRAPH.CENTER,
                   "right": WD_ALIGN_PARAGRAPH.RIGHT}[align]
    rest = template
    while rest:
        before, brace, after = rest.partition("{")
        if before:
            p.add_run(before)
        if not brace:
            break
        name, _, rest = after.partition("}")
        add_field(p, name, "1")
    if font_size:
        for run in p.runs:
            run.font.size = Pt(font_size)


def add_hyperlink(paragraph, url: str, text: str, color: str = "0563C1", underline: bool = True):
    """A link to a web address in a paragraph."""
    r_id = paragraph.part.relate_to(url, "http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink",
                                    is_external=True)
    link = OxmlElement("w:hyperlink")
    link.set(qn("r:id"), r_id)
    run = OxmlElement("w:r")
    rpr = OxmlElement("w:rPr")
    style = OxmlElement("w:rStyle")
    style.set(qn("w:val"), "Hyperlink")
    rpr.append(style)
    c = OxmlElement("w:color")
    c.set(qn("w:val"), color)
    rpr.append(c)
    if underline:
        u = OxmlElement("w:u")
        u.set(qn("w:val"), "single")
        rpr.append(u)
    run.append(rpr)
    t = OxmlElement("w:t")
    t.text = text
    t.set("{http://www.w3.org/XML/1998/namespace}space", "preserve")
    run.append(t)
    link.append(run)
    paragraph._p.append(link)
    return link


def add_image(doc, path: str, width: float | None = None, align: str = "center"):
    """A picture in its own paragraph. Give only the width: the height keeps the aspect ratio."""
    doc.add_picture(path, width=Inches(width) if width else None)
    p = doc.paragraphs[-1]
    p.alignment = {"left": WD_ALIGN_PARAGRAPH.LEFT, "center": WD_ALIGN_PARAGRAPH.CENTER}[align]
    return p


def add_caption(doc, text: str, label: str = "Figure"):
    """A caption with an automatic number, for example "Figure 1: Sales by region"."""
    p = doc.add_paragraph(style="Caption" if "Caption" in [s.name for s in doc.styles] else None)
    p.add_run(f"{label} ")
    add_field(p, f"SEQ {label} \\* ARABIC", "1")
    p.add_run(f": {text}")
    return p


def set_landscape(section) -> None:
    """Turn a section to landscape. Add a new section first to turn only some pages."""
    if section.orientation != WD_ORIENT.LANDSCAPE:
        section.orientation = WD_ORIENT.LANDSCAPE
        section.page_width, section.page_height = section.page_height, section.page_width
