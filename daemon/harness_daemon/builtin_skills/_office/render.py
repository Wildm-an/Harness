"""Render a document to PDF or to page images, so that you can look at the layout.

    python render.py pdf report.docx                 # report.pdf in the same folder
    python render.py images deck.pptx --dpi 60       # one PNG for each page or slide
    python render.py images report.pdf --pages 1-3
    python render.py grid deck.pptx --cols 4         # one PNG with all slides, with numbers

Office files (.docx, .pptx, .xlsx, .odt, ...) go to PDF through LibreOffice (soffice).
PDF pages become PNG files through pypdfium2 (pip install pypdfium2) or pdftoppm (Poppler).
grid needs Pillow (pip install pillow).

The script prints the paths of the files that it makes. Open a PNG with the read tool to look at it.
"""

from __future__ import annotations

import argparse
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

SOFFICE_PLACES = [
    r"C:\Program Files\LibreOffice\program\soffice.exe",
    r"C:\Program Files (x86)\LibreOffice\program\soffice.exe",
    "/Applications/LibreOffice.app/Contents/MacOS/soffice",
    "/usr/bin/soffice",
    "/usr/local/bin/soffice",
    "/snap/bin/libreoffice",
]


def find_soffice() -> str | None:
    for name in ("soffice", "libreoffice"):
        found = shutil.which(name)
        if found:
            return found
    return next((p for p in SOFFICE_PLACES if os.path.exists(p)), None)


def need_soffice() -> str:
    soffice = find_soffice()
    if not soffice:
        sys.exit(
            "LibreOffice is not installed, so the script cannot convert Office files. "
            "Install it from https://www.libreoffice.org (Windows: winget install TheDocumentFoundation.LibreOffice; "
            "macOS: brew install --cask libreoffice; Linux: the libreoffice package). "
            "You can also ask the user to open the file to check it."
        )
    return soffice


def to_pdf(src: Path, outdir: Path) -> Path:
    if src.suffix.lower() == ".pdf":
        return src
    soffice = need_soffice()
    outdir.mkdir(parents=True, exist_ok=True)
    # A separate profile folder lets the conversion run when LibreOffice is open on the desktop.
    with tempfile.TemporaryDirectory() as profile:
        cmd = [soffice, f"-env:UserInstallation={Path(profile).as_uri()}", "--headless",
               "--convert-to", "pdf", "--outdir", str(outdir), str(src)]
        try:
            result = subprocess.run(cmd, capture_output=True, text=True, timeout=180)
        except subprocess.TimeoutExpired:
            sys.exit("LibreOffice did not finish in 180 seconds.")
    pdf = outdir / (src.stem + ".pdf")
    if not pdf.exists():
        sys.exit(f"LibreOffice did not make a PDF.\n{result.stdout}\n{result.stderr}".strip())
    return pdf


def parse_pages(spec: str | None, count: int) -> list[int]:
    if not spec:
        return list(range(1, count + 1))
    pages: list[int] = []
    for part in spec.replace(" ", "").split(","):
        start, _, end = part.partition("-")
        pages.extend(range(int(start), int(end or start) + 1))
    return [p for p in dict.fromkeys(pages) if 1 <= p <= count]


def to_images(pdf: Path, outdir: Path, dpi: int, pages: str | None) -> list[Path]:
    outdir.mkdir(parents=True, exist_ok=True)
    try:
        import pypdfium2 as pdfium
    except ImportError:
        pdfium = None
    paths: list[Path] = []
    if pdfium is not None:
        doc = pdfium.PdfDocument(str(pdf))
        for n in parse_pages(pages, len(doc)):
            image = doc[n - 1].render(scale=dpi / 72).to_pil()
            path = outdir / f"{pdf.stem}-{n:03d}.png"
            image.save(path)
            paths.append(path)
        return paths
    pdftoppm = shutil.which("pdftoppm")
    if not pdftoppm:
        sys.exit("To make images, install pypdfium2 (pip install pypdfium2) or Poppler (pdftoppm).")
    count = _pdf_page_count(pdf)
    for n in parse_pages(pages, count):
        prefix = outdir / f"{pdf.stem}-{n:03d}"
        subprocess.run([pdftoppm, "-png", "-r", str(dpi), "-f", str(n), "-l", str(n), "-singlefile",
                        str(pdf), str(prefix)], check=True)
        paths.append(prefix.with_suffix(".png"))
    return paths


def _pdf_page_count(pdf: Path) -> int:
    try:
        from pypdf import PdfReader

        return len(PdfReader(str(pdf)).pages)
    except ImportError:
        pdfinfo = shutil.which("pdfinfo")
        if pdfinfo:
            out = subprocess.run([pdfinfo, str(pdf)], capture_output=True, text=True).stdout
            for line in out.splitlines():
                if line.startswith("Pages:"):
                    return int(line.split()[1])
    return 9999


def grid(images: list[Path], out: Path, cols: int) -> Path:
    try:
        from PIL import Image, ImageDraw
    except ImportError:
        sys.exit("grid needs Pillow: pip install pillow")
    thumbs = []
    for path in images:
        with Image.open(path) as im:
            im = im.convert("RGB")
            im.thumbnail((400, 400))
            thumbs.append(im.copy())
    if not thumbs:
        sys.exit("No pages to put in the grid.")
    cell_w = max(t.width for t in thumbs)
    cell_h = max(t.height for t in thumbs)
    label_h, pad = 22, 10
    rows = (len(thumbs) + cols - 1) // cols
    sheet = Image.new("RGB", (cols * (cell_w + pad) + pad, rows * (cell_h + label_h + pad) + pad), "white")
    draw = ImageDraw.Draw(sheet)
    for i, thumb in enumerate(thumbs):
        x = pad + (i % cols) * (cell_w + pad)
        y = pad + (i // cols) * (cell_h + label_h + pad)
        draw.text((x, y + 4), str(i + 1), fill="black")
        sheet.paste(thumb, (x, y + label_h))
        draw.rectangle([x - 1, y + label_h - 1, x + thumb.width, y + label_h + thumb.height], outline="gray")
    sheet.save(out)
    return out


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="command", required=True)
    for name, text in (("pdf", "Convert an Office file to PDF."),
                       ("images", "Make one PNG for each page."),
                       ("grid", "Make one PNG with all pages, with numbers.")):
        p = sub.add_parser(name, help=text)
        p.add_argument("file", type=Path)
        p.add_argument("--outdir", type=Path, help="The folder for the output. Default: the folder of the file.")
        if name != "pdf":
            p.add_argument("--dpi", type=int, default=80 if name == "images" else 50)
            p.add_argument("--pages", help="For example 1-3 or 2,5. Default: all pages.")
        if name == "grid":
            p.add_argument("--cols", type=int, default=4)
    args = parser.parse_args()
    src = args.file.resolve()
    if not src.exists():
        sys.exit(f"The file does not exist: {src}")
    outdir = (args.outdir or src.parent).resolve()
    if args.command == "pdf":
        print(to_pdf(src, outdir))
        return
    with tempfile.TemporaryDirectory() as tmp:
        pdf = to_pdf(src, Path(tmp)) if src.suffix.lower() != ".pdf" else src
        if args.command == "images":
            for path in to_images(pdf, outdir, args.dpi, args.pages):
                print(path)
        else:
            images = to_images(pdf, Path(tmp) / "pages", args.dpi, args.pages)
            print(grid(images, outdir / f"{src.stem}-grid.png", args.cols))


if __name__ == "__main__":
    main()
