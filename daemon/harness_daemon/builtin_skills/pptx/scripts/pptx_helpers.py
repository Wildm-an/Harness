"""Helpers for python-pptx: text boxes, bullets, shapes, images, tables, and charts with exact positions.

    import sys
    sys.path.insert(0, r"<skill folder>/scripts")
    from pptx_helpers import *

    prs = new_presentation()                     # 16:9, 13.333 x 7.5 in
    s = blank_slide(prs)
    set_background(s, "0F172A")
    add_text(s, "Quarterly Review", 0.8, 2.6, 11.7, 1.2, size=44, bold=True, color="FFFFFF")
    add_text(s, "October 2026", 0.8, 3.9, 11.7, 0.6, size=20, color="94A3B8")
    s = blank_slide(prs)
    add_text(s, "Revenue grew in all regions", 0.6, 0.4, 12.1, 0.9, size=32, bold=True)
    add_bullets(s, ["North: +12%", "South: +8%", ("New stores drove the growth", 1)], 0.6, 1.5, 5.8, 4.5, size=18)
    add_chart(s, "bar", ["North", "South"], {"Revenue": [1.2, 0.9]}, 6.8, 1.5, 6.0, 4.5)
    prs.save("deck.pptx")

All positions and sizes are in inches. Colors are hex strings such as "1F4E79". Sizes of text are points.
"""

from __future__ import annotations

from pptx import Presentation
from pptx.chart.data import CategoryChartData
from pptx.dml.color import RGBColor
from pptx.enum.chart import XL_CHART_TYPE, XL_LEGEND_POSITION
from pptx.enum.shapes import MSO_SHAPE
from pptx.enum.text import MSO_ANCHOR, MSO_AUTO_SIZE, PP_ALIGN
from pptx.oxml.ns import qn
from pptx.util import Inches, Pt

__all__ = [
    "new_presentation", "blank_slide", "layout_slide", "set_background", "add_text", "add_bullets",
    "add_shape", "add_line", "add_image", "add_table", "add_chart", "add_notes", "rgb",
    "Inches", "Pt", "MSO_SHAPE", "PP_ALIGN", "MSO_ANCHOR",
]

ALIGN = {"left": PP_ALIGN.LEFT, "center": PP_ALIGN.CENTER, "right": PP_ALIGN.RIGHT, "justify": PP_ALIGN.JUSTIFY}
ANCHOR = {"top": MSO_ANCHOR.TOP, "middle": MSO_ANCHOR.MIDDLE, "bottom": MSO_ANCHOR.BOTTOM}
CHARTS = {
    "bar": XL_CHART_TYPE.COLUMN_CLUSTERED, "barh": XL_CHART_TYPE.BAR_CLUSTERED,
    "stacked": XL_CHART_TYPE.COLUMN_STACKED, "line": XL_CHART_TYPE.LINE_MARKERS,
    "pie": XL_CHART_TYPE.PIE, "doughnut": XL_CHART_TYPE.DOUGHNUT, "area": XL_CHART_TYPE.AREA,
    "scatter": XL_CHART_TYPE.XY_SCATTER,
}


def rgb(hex_color: str) -> RGBColor:
    return RGBColor.from_string(hex_color.lstrip("#"))


def new_presentation(widescreen: bool = True, template: str | None = None):
    """A new presentation: 16:9 (13.333 x 7.5 in) or 4:3 (10 x 7.5 in). A template keeps its own size."""
    prs = Presentation(template) if template else Presentation()
    if not template:
        prs.slide_width = Inches(13.333) if widescreen else Inches(10)
        prs.slide_height = Inches(7.5)
    return prs


def layout_slide(prs, name_or_number):
    """A slide with a layout of the template, by name ("Title and Content") or number (1 is the first)."""
    layouts = list(prs.slide_layouts)
    if isinstance(name_or_number, int):
        layout = layouts[name_or_number - 1]
    else:
        layout = next((l for l in layouts if l.name.lower() == str(name_or_number).lower()), None)
        if layout is None:
            raise KeyError(f"No layout {name_or_number!r}. The layouts are: {[l.name for l in layouts]}")
    return prs.slides.add_slide(layout)


def blank_slide(prs):
    """A slide with no placeholders."""
    layouts = list(prs.slide_layouts)
    blank = next((l for l in layouts if l.name.lower() == "blank"), None)
    if blank is None:
        blank = min(layouts, key=lambda l: len(l.placeholders))
    slide = prs.slides.add_slide(blank)
    for ph in list(slide.placeholders):
        ph._element.getparent().remove(ph._element)
    return slide


def set_background(slide, color: str) -> None:
    fill = slide.background.fill
    fill.solid()
    fill.fore_color.rgb = rgb(color)


def _style_run(run, size, bold, italic, color, font):
    if size:
        run.font.size = Pt(size)
    if bold is not None:
        run.font.bold = bold
    if italic is not None:
        run.font.italic = italic
    if color:
        run.font.color.rgb = rgb(color)
    if font:
        run.font.name = font


def _box(slide, left, top, width, height, valign, margin):
    box = slide.shapes.add_textbox(Inches(left), Inches(top), Inches(width), Inches(height))
    tf = box.text_frame
    tf.word_wrap = True
    tf.auto_size = MSO_AUTO_SIZE.NONE
    tf.vertical_anchor = ANCHOR[valign]
    for side in ("left", "right", "top", "bottom"):
        setattr(tf, f"margin_{side}", Inches(margin))
    return box


def add_text(slide, text, left, top, width, height, size: float = 18, bold: bool | None = None,
             italic: bool | None = None, color: str | None = "1F2937", font: str | None = None,
             align: str = "left", valign: str = "top", line_spacing: float | None = None, margin: float = 0.05):
    """A text box. text is a string, or a list of strings for more paragraphs."""
    box = _box(slide, left, top, width, height, valign, margin)
    tf = box.text_frame
    lines = text if isinstance(text, list) else [text]
    for i, line in enumerate(lines):
        p = tf.paragraphs[0] if i == 0 else tf.add_paragraph()
        p.alignment = ALIGN[align]
        if line_spacing:
            p.line_spacing = line_spacing
        run = p.add_run()
        run.text = str(line)
        _style_run(run, size, bold, italic, color, font)
    return box


def _bullet(paragraph, level: int, char: str, size: float, color: str | None) -> None:
    ppr = paragraph._p.get_or_add_pPr()
    indent = int(Pt(size).emu * 1.1)
    ppr.set("marL", str(indent * (level + 1)))
    ppr.set("indent", str(-indent))
    for tag in ("a:buNone", "a:buChar", "a:buAutoNum", "a:buClr"):
        for el in ppr.findall(qn(tag)):
            ppr.remove(el)
    if color:
        clr = ppr.makeelement(qn("a:buClr"), {})
        srgb = clr.makeelement(qn("a:srgbClr"), {"val": color.lstrip("#")})
        clr.append(srgb)
        ppr.append(clr)
    if char == "number":
        ppr.append(ppr.makeelement(qn("a:buAutoNum"), {"type": "arabicPeriod"}))
    else:
        ppr.append(ppr.makeelement(qn("a:buChar"), {"char": char}))


def add_bullets(slide, items: list, left, top, width, height, size: float = 18, color: str | None = "1F2937",
                bullet: str = "•", bullet_color: str | None = None, font: str | None = None,
                space_after: float = 6, valign: str = "top"):
    """A text box with real bullets. An item is a string, or (text, level). bullet="number" numbers the items."""
    box = _box(slide, left, top, width, height, valign, 0.05)
    tf = box.text_frame
    for i, item in enumerate(items):
        text, level = (item, 0) if isinstance(item, str) else (item[0], int(item[1]))
        p = tf.paragraphs[0] if i == 0 else tf.add_paragraph()
        item_size = size if level == 0 else max(size - 2 * level, 10)
        _bullet(p, level, bullet, item_size, bullet_color)
        p.space_after = Pt(space_after)
        run = p.add_run()
        run.text = str(text)
        _style_run(run, item_size, None, None, color, font)
    return box


def add_shape(slide, left, top, width, height, fill: str | None = "E5E7EB", line: str | None = None,
              shape=MSO_SHAPE.RECTANGLE, text: str | None = None, size: float = 16, color: str = "1F2937",
              bold: bool | None = None, align: str = "center"):
    """A rectangle, rounded rectangle (MSO_SHAPE.ROUNDED_RECTANGLE), oval, and so on, with optional text."""
    sp = slide.shapes.add_shape(shape, Inches(left), Inches(top), Inches(width), Inches(height))
    if fill:
        sp.fill.solid()
        sp.fill.fore_color.rgb = rgb(fill)
    else:
        sp.fill.background()
    if line:
        sp.line.color.rgb = rgb(line)
    else:
        sp.line.fill.background()
    sp.shadow.inherit = False
    if text is not None:
        tf = sp.text_frame
        tf.word_wrap = True
        p = tf.paragraphs[0]
        p.alignment = ALIGN[align]
        run = p.add_run()
        run.text = text
        _style_run(run, size, bold, None, color, None)
    return sp


def add_line(slide, x1, y1, x2, y2, color: str = "9CA3AF", width_pt: float = 1.0):
    connector = slide.shapes.add_connector(1, Inches(x1), Inches(y1), Inches(x2), Inches(y2))
    connector.line.color.rgb = rgb(color)
    connector.line.width = Pt(width_pt)
    return connector


def add_image(slide, path: str, left, top, width, height, mode: str = "contain"):
    """A picture in a box. contain: all of the picture shows, centered. cover: the picture fills the box and is cropped."""
    from PIL import Image

    with Image.open(path) as im:
        iw, ih = im.size
    box_ratio, image_ratio = width / height, iw / ih
    if mode == "cover":
        pic = slide.shapes.add_picture(path, Inches(left), Inches(top), Inches(width), Inches(height))
        if image_ratio > box_ratio:
            crop = (1 - box_ratio / image_ratio) / 2
            pic.crop_left = pic.crop_right = crop
        else:
            crop = (1 - image_ratio / box_ratio) / 2
            pic.crop_top = pic.crop_bottom = crop
        return pic
    if image_ratio > box_ratio:
        w, h = width, width / image_ratio
    else:
        w, h = height * image_ratio, height
    return slide.shapes.add_picture(path, Inches(left + (width - w) / 2), Inches(top + (height - h) / 2),
                                    Inches(w), Inches(h))


def add_table(slide, rows: list[list], left, top, width, height, col_widths: list[float] | None = None,
              size: float = 14, header_fill: str = "1F3864", header_color: str = "FFFFFF",
              stripe_fill: str | None = "F3F4F6", color: str = "1F2937"):
    shape = slide.shapes.add_table(len(rows), max(len(r) for r in rows), Inches(left), Inches(top),
                                   Inches(width), Inches(height))
    table = shape.table
    if col_widths:
        for col, w in zip(table.columns, col_widths):
            col.width = Inches(w)
    for r, values in enumerate(rows):
        for c, value in enumerate(values):
            cell = table.cell(r, c)
            cell.text = "" if value is None else str(value)
            cell.fill.solid()
            if r == 0:
                cell.fill.fore_color.rgb = rgb(header_fill)
            else:
                cell.fill.fore_color.rgb = rgb(stripe_fill if stripe_fill and r % 2 == 0 else "FFFFFF")
            for p in cell.text_frame.paragraphs:
                for run in p.runs:
                    _style_run(run, size, r == 0, None, header_color if r == 0 else color, None)
    return shape


def add_chart(slide, kind: str, categories: list, series: dict[str, list], left, top, width, height,
              colors: list[str] | None = None, legend: bool | None = None, labels: bool = False,
              number_format: str | None = None, font_size: float = 12):
    """A native chart that the user can edit in PowerPoint. kind: bar, barh, stacked, line, pie, doughnut, area."""
    data = CategoryChartData()
    data.categories = categories
    for name, values in series.items():
        data.add_series(name, values)
    frame = slide.shapes.add_chart(CHARTS[kind], Inches(left), Inches(top), Inches(width), Inches(height), data)
    chart = frame.chart
    chart.font.size = Pt(font_size)
    show_legend = legend if legend is not None else (len(series) > 1 or kind in ("pie", "doughnut"))
    chart.has_legend = show_legend
    if show_legend:
        chart.legend.position = XL_LEGEND_POSITION.BOTTOM
        chart.legend.include_in_layout = False
    plot = chart.plots[0]
    if labels:
        plot.has_data_labels = True
        if number_format:
            plot.data_labels.number_format = number_format
            plot.data_labels.number_format_is_linked = False
    if colors:
        if kind in ("pie", "doughnut"):
            for i, point in enumerate(plot.series[0].points):
                point.format.fill.solid()
                point.format.fill.fore_color.rgb = rgb(colors[i % len(colors)])
        else:
            for i, s in enumerate(plot.series):
                fmt = s.format
                if kind == "line":
                    fmt.line.color.rgb = rgb(colors[i % len(colors)])
                else:
                    fmt.fill.solid()
                    fmt.fill.fore_color.rgb = rgb(colors[i % len(colors)])
    return frame


def add_notes(slide, text: str) -> None:
    """Speaker notes for the slide."""
    slide.notes_slide.notes_text_frame.text = text

