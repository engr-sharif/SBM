#!/usr/bin/env python3
"""
Build data/ortho_mine.jpg + data/ortho_mine.json — the 6-inch mine-area orthophoto.

Source: the survey's full-resolution 3-inch GeoTIFF tiles,
  "LiDAR and Aerial Survey Data/SBM - Aerial Imagery/2024-01-30 Sulphur Bank Mine 3in Ortho_A1.tif"
(0.25 ft/px, LZW, RGBA). The mine-area window falls entirely inside tile A1, so this reads
that one tile — no mosaicking. Geo-registration comes from the TIFF's own ModelTiepoint /
ModelPixelScale (identical to the .tfw), never from an assumed corner.

The window is box-averaged 0.25 ft -> 0.5 ft/px in a single resize with a float source box,
so the output is geo-exact rather than snapped to whole source pixels.

About 74% of the window has real 3-inch coverage; the rest is outside the flight's collection
footprint (alpha = 0) and is backfilled from data/ortho_site.jpg, which is what the site-wide
basemap already shows there.

Usage:
  python tools/build_ortho_mine.py "/path/to/2024-01-30 Sulphur Bank Mine 3in Ortho_A1.tif"
"""
import json, os, struct, sys

import numpy as np
from PIL import Image

Image.MAX_IMAGE_PIXELS = None

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, "data")

# target window (State Plane ft) and output resolution
X0, Y0, X1, Y1 = 6370069.0, 2127238.0, 6372941.0, 2131120.0
RES = 0.5


def geotiff_origin(path):
    """Read pixel size and top-left corner from the TIFF's GeoTIFF tags (classic TIFF)."""
    with open(path, "rb") as f:
        head = f.read(8)
        en = "<" if head[:2] == b"II" else ">"
        off = struct.unpack(en + "I", head[4:8])[0]
        f.seek(off)
        n = struct.unpack(en + "H", f.read(2))[0]
        buf = f.read(n * 12)
        tags = {}
        for i in range(n):
            e = buf[i * 12:(i + 1) * 12]
            tag, typ, cnt = struct.unpack(en + "HHI", e[:8])
            if tag in (33550, 33922):                      # ModelPixelScale, ModelTiepoint
                voff = struct.unpack(en + "I", e[8:12])[0]
                cur = f.tell()
                f.seek(voff)
                tags[tag] = struct.unpack(en + "d" * cnt, f.read(8 * cnt))
                f.seek(cur)
        scale, tie = tags[33550], tags[33922]
        return tie[3], tie[4], scale[0]                    # x of px0, y of px0, ft/px


def main():
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    src = sys.argv[1]
    sx0, sy1, pix = geotiff_origin(src)
    print(f"source origin E {sx0:.4f} N {sy1:.4f} @ {pix} ft/px")

    W = int(round((X1 - X0) / RES))
    H = int(round((Y1 - Y0) / RES))
    col = lambda e: (e - sx0) / pix
    row = lambda nth: (sy1 - nth) / pix

    im = Image.open(src)
    im.load()
    print(f"decoded {im.size} {im.mode}")
    sw, sh = im.size

    # the tile may stop a fraction of a pixel short of the window's south edge
    availH = H
    while row(Y1 - availH * RES) > sh:
        availH -= 1
    if availH < H:
        print(f"tile covers {availH} of {H} output rows; last row(s) replicated")

    box = (col(X0), row(Y1), col(X1), row(Y1 - availH * RES))
    sub = np.array(im.resize((W, availH), Image.BOX, box=box))
    del im

    rgb = sub[:, :, :3].astype(np.uint8)
    valid = sub[:, :, 3] >= 128 if sub.shape[2] == 4 else np.ones(sub.shape[:2], bool)
    del sub
    print(f"real 3-in coverage: {100 * valid.mean():.1f}% of the window")

    canvas = np.zeros((H, W, 3), np.uint8)
    mask = np.zeros((H, W), bool)
    canvas[:availH] = rgb
    mask[:availH] = valid
    for y in range(availH, H):                              # replicate the final row
        canvas[y] = rgb[availH - 1]
        mask[y] = valid[availH - 1]
    del rgb, valid

    # backfill the uncollected part from the site-wide ortho
    sj = os.path.join(DATA, "ortho_site.json")
    if os.path.exists(sj) and not mask.all():
        o = json.load(open(sj))
        site = Image.open(os.path.join(DATA, "ortho_site.jpg")).convert("RGB")
        rx = (o["x1"] - o["x0"]) / site.size[0]
        ry = (o["y1"] - o["y0"]) / site.size[1]
        fill = site.resize((W, H), Image.BICUBIC, box=(
            (X0 - o["x0"]) / rx, (o["y1"] - Y1) / ry, (X1 - o["x0"]) / rx, (o["y1"] - Y0) / ry))
        canvas = np.where(mask[..., None], canvas, np.array(fill)).astype(np.uint8)
        print("backfilled uncollected area from ortho_site")

    out = os.path.join(DATA, "ortho_mine.jpg")
    Image.fromarray(canvas).save(out, "JPEG", quality=82, optimize=True)
    json.dump({"x0": X0, "y0": Y0, "x1": X1, "y1": Y1},
              open(os.path.join(DATA, "ortho_mine.json"), "w"))
    print(f"data/ortho_mine.jpg  {W}x{H}  {os.path.getsize(out) / 1e6:.1f} MB")


if __name__ == "__main__":
    main()
