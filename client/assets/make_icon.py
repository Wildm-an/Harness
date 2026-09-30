"""Draws the source app icon (1024x1024 PNG): a white "{H}" on a transparent background.

Needs Pillow and the Cascadia Code font of Windows. Make the icon files with:
    python assets/make_icon.py assets/icon.png
    npx tauri icon assets/icon.png
"""
import sys
from PIL import Image, ImageDraw, ImageFont

N = 1024
TEXT = "{H}"
WHITE = (255, 255, 255, 255)
FONT = "C:/Windows/Fonts/CascadiaCode.ttf"
MARGIN = 64  # The space on each side of the text.

# Draw large, then scale down, for smooth edges.
S = 4
font = ImageFont.truetype(FONT, 1000 * S)
font.set_variation_by_name("Bold")
left, top, right, bottom = font.getbbox(TEXT)
big = Image.new("RGBA", (right - left, bottom - top), (0, 0, 0, 0))
ImageDraw.Draw(big).text((-left, -top), TEXT, font=font, fill=WHITE)
big = big.crop(big.getbbox())  # Only the ink of the text.

# Fit the text in the square and put it in the center.
room = N - 2 * MARGIN
scale = min(room / big.width, room / big.height)
small = big.resize((round(big.width * scale), round(big.height * scale)), Image.LANCZOS)
icon = Image.new("RGBA", (N, N), (0, 0, 0, 0))
icon.alpha_composite(small, ((N - small.width) // 2, (N - small.height) // 2))
icon.save(sys.argv[1])
