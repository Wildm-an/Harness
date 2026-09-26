"""Draws the source app icon (1024x1024 PNG): a terminal prompt on a slate tile."""
import math, struct, zlib, sys

N = 1024
BG = (15, 23, 42)       # #0F172A
EDGE = (51, 65, 85)     # #334155
GREEN = (34, 197, 94)   # #22C55E
TEXT = (248, 250, 252)  # #F8FAFC

def rounded_box(x, y, cx, cy, hw, hh, r):
    qx, qy = abs(x - cx) - hw + r, abs(y - cy) - hh + r
    return math.hypot(max(qx, 0), max(qy, 0)) + min(max(qx, qy), 0) - r

def segment(x, y, ax, ay, bx, by, w):
    px, py, dx, dy = x - ax, y - ay, bx - ax, by - ay
    t = max(0, min(1, (px * dx + py * dy) / (dx * dx + dy * dy)))
    return math.hypot(px - dx * t, py - dy * t) - w

def cover(d):  # Signed distance to pixel coverage (anti-aliasing).
    return max(0.0, min(1.0, 0.5 - d))

rows = []
for y in range(N):
    row = bytearray([0])
    for x in range(N):
        px, py = x + 0.5, y + 0.5
        tile = rounded_box(px, py, 512, 512, 448, 448, 200)
        a = cover(tile)
        if a == 0:
            row += bytes(4); continue
        col = list(BG)
        e = cover(abs(tile + 12) - 12)  # Inner edge line.
        col = [c * (1 - e) + k * e for c, k in zip(col, EDGE)]
        chev = min(segment(px, py, 300, 340, 470, 512, 44), segment(px, py, 470, 512, 300, 684, 44))
        g = cover(chev)
        col = [c * (1 - g) + k * g for c, k in zip(col, GREEN)]
        bar = rounded_box(px, py, 640, 668, 120, 38, 38)
        t = cover(bar)
        col = [c * (1 - t) + k * t for c, k in zip(col, TEXT)]
        row += bytes([round(col[0]), round(col[1]), round(col[2]), round(a * 255)])
    rows.append(bytes(row))

def chunk(kind, data):
    return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF)

png = b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", N, N, 8, 6, 0, 0, 0))
png += chunk(b"IDAT", zlib.compress(b"".join(rows), 9)) + chunk(b"IEND", b"")
open(sys.argv[1], "wb").write(png)
