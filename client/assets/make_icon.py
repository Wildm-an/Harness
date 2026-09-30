"""Draws the source app icon (1024x1024 PNG): a white "{H}" on a transparent background.

The characters are as tall as the mark of the Claude app icon: 74% of the icon height. At that
height the three characters are wider than the icon, so the braces are narrower than in the font.

Needs Pillow and the Cascadia Code font of Windows. Make the icon files with:
    python assets/make_icon.py assets/icon.png
    npx tauri icon assets/icon.png
"""
import sys
from PIL import Image, ImageDraw, ImageFont

N = 1024
TEXT_HEIGHT = round(0.74 * N)  # The height of the braces, the tallest characters.
MARGIN = 24  # The space on each side of the text.
GAP = 0.04  # The space between the characters, as a part of the text height.
WHITE = (255, 255, 255, 255)
FONT = "C:/Windows/Fonts/CascadiaCode.ttf"
SIZE = 4000  # Draw large, then scale down, for smooth edges.

font = ImageFont.truetype(FONT, SIZE)
font.set_variation_by_name("Bold")


def glyph(ch: str) -> tuple[Image.Image, int]:
    """The ink of one character, and the top of the ink relative to the baseline."""
    canvas = Image.new("L", (2 * SIZE, 2 * SIZE), 0)
    base = (SIZE // 2, 3 * SIZE // 2)
    ImageDraw.Draw(canvas).text(base, ch, font=font, fill=255, anchor="ls")
    box = canvas.getbbox()
    return canvas.crop(box), box[1] - base[1]


(brace_l, top_b), (letter, top_h), (brace_r, _) = glyph("{"), glyph("H"), glyph("}")
text_h = brace_l.height
scale = TEXT_HEIGHT / text_h
gap = GAP * text_h

# Make the braces narrower until the text fits in the icon. The H keeps its shape.
room = (N - 2 * MARGIN) / scale
squeeze = min(1.0, (room - letter.width - 2 * gap) / (brace_l.width + brace_r.width))
brace_l = brace_l.resize((round(brace_l.width * squeeze), brace_l.height), Image.LANCZOS)
brace_r = brace_r.resize((round(brace_r.width * squeeze), brace_r.height), Image.LANCZOS)

# Put the characters on one baseline, then scale the text to its height.
width = round(brace_l.width + letter.width + brace_r.width + 2 * gap)
text = Image.new("L", (width, text_h), 0)
x = 0
for mask, top in ((brace_l, top_b), (letter, top_h), (brace_r, top_b)):
    text.paste(mask, (round(x), top - top_b))
    x += mask.width + gap
text = text.resize((round(width * scale), TEXT_HEIGHT), Image.LANCZOS)

icon = Image.new("RGBA", (N, N), (0, 0, 0, 0))
white = Image.new("RGBA", text.size, WHITE)
white.putalpha(text)
icon.alpha_composite(white, ((N - text.width) // 2, (N - text.height) // 2))
icon.save(sys.argv[1])
print(f"The braces are {squeeze:.0%} of their width in the font.")
