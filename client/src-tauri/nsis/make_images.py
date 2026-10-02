"""Make the images of the NSIS installer from the app icon. Run it after a change of the icon:

    python client/src-tauri/nsis/make_images.py

The installer has the color of the Harness sidebar, with the logo in the middle (installer.nsi):

- brand/logo-<scale>.bmp: the {H} logo, 80 px at 100 % display scale. The welcome page, the
  finish page, and the install page show it in the middle.
- brand/header-<scale>.bmp: the logo and the name, 40 px high at 100 %. The header of the other
  pages shows it in the middle.
- header.bmp and sidebar.bmp: the images that the Tauri config needs. The installer hides them.

There is one file for each display scale of Windows (100 % to 200 %), so the logo is sharp.
NSIS needs 24-bit BMP files. The script needs Pillow and the Segoe UI font of Windows.
"""

from __future__ import annotations

from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

HERE = Path(__file__).resolve().parent
BRAND = HERE / "brand"
ICON = HERE.parent / "icons" / "icon.png"  # The white {H} on a transparent background.
FONTS = Path("C:/Windows/Fonts")

BG = (31, 30, 29)  # The sidebar of Harness (--sidebar in styles.css, #1f1e1d).
TEXT = (250, 249, 245)  # --text, #faf9f5.
SCALES = (100, 125, 150, 175, 200)
LOGO_PX = 80
HEADER_W, HEADER_H = 150, 40


def mark(size: int) -> Image.Image:
    return Image.open(ICON).convert("RGBA").resize((size, size), Image.LANCZOS)


def logo(scale: int) -> Image.Image:
    size = LOGO_PX * scale // 100
    img = Image.new("RGBA", (size, size), BG + (255,))
    img.alpha_composite(mark(size))
    return img


def header(scale: int) -> Image.Image:
    w, h = HEADER_W * scale // 100, HEADER_H * scale // 100
    img = Image.new("RGBA", (w, h), BG + (255,))
    m = mark(h)
    name = ImageFont.truetype(str(FONTS / "segoeuib.ttf"), int(h * 0.45))
    text_w = ImageDraw.Draw(img).textlength("Harness", font=name)
    gap = int(h * 0.15)
    left = int((w - (m.width + gap + text_w)) / 2)
    img.alpha_composite(m, (left, 0))
    ImageDraw.Draw(img).text((left + m.width + gap, h // 2), "Harness", font=name, fill=TEXT, anchor="lm")
    return img


def save(img: Image.Image, path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    img.convert("RGB").save(path, "BMP")
    print(f"Wrote {path}")


if __name__ == "__main__":
    for scale in SCALES:
        save(logo(scale), BRAND / f"logo-{scale}.bmp")
        save(header(scale), BRAND / f"header-{scale}.bmp")
    save(Image.new("RGB", (150, 57), BG), HERE / "header.bmp")
    save(Image.new("RGB", (164, 314), BG), HERE / "sidebar.bmp")
