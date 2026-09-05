#!/usr/bin/env python3
"""
Draw the home-screen icons (docs/V17_TOUCH_SPEC.md §2).

    python3 tools/make_icons.py

Writes, into icons/:

    icon-192.png            192  the manifest's "any" icon
    icon-512.png            512  the manifest's "any" icon
    icon-maskable-512.png   512  the same mark, inside the 80% safe circle
    apple-touch-icon.png    180  what iOS puts on the home screen

The mark is the gate's (js/gate.js `.gmark`): a ring with three topographic
contour strokes crossing it, on the app's own dark ground. Its SVG is a 44x44
viewBox with one circle and three cubic-bezier paths written in the SVG's own
relative `c` syntax; PATHS below is that syntax transcribed, and `bez()` walks
it. Keeping the numbers rather than redrawing something similar is the point —
the icon on the home screen is the same mark as the screen it unlocks.

Committed PNGs: the app has no build step for images and no network, so these
are generated once and checked in. Re-run only if the mark changes.
"""
import math
import os

from PIL import Image, ImageDraw

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "icons")

BG = (14, 20, 24)          # --bg
RING = (79, 179, 206)      # --acc
TOPO = (124, 208, 230)     # --acc2
TOPO3 = (143, 163, 174)    # --mut

# js/gate.js `.gmark`, viewBox 0 0 44 44. Each entry is (start, [rel cubic legs]).
PATHS = [
    ((5, 28), [(4, -6, 8, -2, 12, -7), (5, -5, 7, 1, 11, -4), (5, -5, 6, -1, 11, -5)], TOPO, 2.2),
    ((6, 34), [(4, -6, 8, -2, 12, -7), (5, -5, 7, 1, 11, -4), (5, -5, 6, -1, 10, -5)], TOPO, 2.2),
    ((8, 21), [(3, -4, 6, -1, 9, -5), (5, -5, 5, 0.6, 8, -3)], TOPO3, 1.7),
]


def bez(p0, leg, n=24):
    """One relative cubic leg -> a list of absolute points (p0 excluded)."""
    x0, y0 = p0
    c1 = (x0 + leg[0], y0 + leg[1])
    c2 = (x0 + leg[2], y0 + leg[3])
    p1 = (x0 + leg[4], y0 + leg[5])
    out = []
    for i in range(1, n + 1):
        t = i / n
        u = 1 - t
        x = u * u * u * x0 + 3 * u * u * t * c1[0] + 3 * u * t * t * c2[0] + t * t * t * p1[0]
        y = u * u * u * y0 + 3 * u * u * t * c1[1] + 3 * u * t * t * c2[1] + t * t * t * p1[1]
        out.append((x, y))
    return out, p1


def draw_mark(size, inset):
    """The mark on the dark ground. `inset` is the fraction of the edge kept
    clear — 0 for the plain icons, 0.10 for the maskable one, whose outer 20 %
    a launcher is free to crop."""
    # 4x supersampling: PIL has no antialiased stroke, and a 192-px ring drawn
    # hard-edged looks like a screenshot of a bug.
    S = 4
    img = Image.new("RGB", (size * S, size * S), BG)
    d = ImageDraw.Draw(img)
    span = size * S * (1 - 2 * inset)
    k = span / 44.0
    ox = oy = size * S * inset

    def P(pt):
        return (ox + pt[0] * k, oy + pt[1] * k)

    # the ring
    w = max(1, int(round(2.6 * k)))
    r = 19 * k
    cx = cy = ox + 22 * k
    d.ellipse([cx - r, cy - r, cx + r, cy + r], outline=RING, width=w)

    # the three contour strokes, clipped to just inside the ring
    for start, legs, colour, wid in PATHS:
        pts = [start]
        cur = start
        for leg in legs:
            seg, cur = bez(cur, leg)
            pts.extend(seg)
        keep = [P(p) for p in pts
                if math.hypot(p[0] - 22, p[1] - 22) <= 18.2]
        if len(keep) > 1:
            d.line(keep, fill=colour, width=max(1, int(round(wid * k))), joint="curve")

    return img.resize((size, size), Image.LANCZOS)


def main():
    os.makedirs(OUT, exist_ok=True)
    for name, size, inset in [
        ("icon-192.png", 192, 0.0),
        ("icon-512.png", 512, 0.0),
        ("icon-maskable-512.png", 512, 0.10),
        ("apple-touch-icon.png", 180, 0.0),
    ]:
        p = os.path.join(OUT, name)
        draw_mark(size, inset).save(p, "PNG", optimize=True)
        print(f"icons/{name}  {os.path.getsize(p) / 1024:.1f} kB")


if __name__ == "__main__":
    main()
