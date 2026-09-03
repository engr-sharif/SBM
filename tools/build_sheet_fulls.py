"""Render every plan sheet of the EA residential drawing set as a full, uncropped
JPG for the app's floating sheet viewer.

The registered overlays (data/design/design_Cxxx.png) are *crops* of the drawing
area, rotated into State Plane. That is the right thing for a map overlay and the
wrong thing for reading a drawing: the title block, general notes, legend, section
callouts and detail bubbles all live outside the plan viewport. These renders are
the whole 36x24 sheet, exactly as plotted.

Output: data/design/sheet_full_<SHEET>.jpg + data/sheets_full.json
"""
import io
import json
import os
import sys

import pymupdf
from PIL import Image

FINAL = ("/mnt/user-data/uploads/SBMM/Residental RA Support/"
         "EA_ResidentialCleanupDesign/Final Residential Design/"
         "Appendix A. Engineering Drawings.pdf")
PRE90 = "/mnt/user-data/uploads/SBMM/c110_page.pdf"
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "data", "design")
IDX = os.path.join(ROOT, "data", "sheets_full.json")

# page index (0-based) -> sheet number, drawing title, taken from each sheet's
# own title block (see the extraction in the phase-B log, not guessed).
FINAL_SHEETS = [
    (0,  "G-001", "Title Sheet"),
    (1,  "G-002", "General Notes, Legend, and Abbreviations"),
    (2,  "C-101", "Site Index"),
    (3,  "C-102", "Staging Area"),
    (4,  "C-103", "Lot 13 Site"),
    (5,  "C-104", "Lot 15 Site"),
    (6,  "C-105", "Lot 19 Site"),
    (7,  "C-106", "Lot 25 Site"),
    (8,  "C-107", "Southern Residence Site"),
    (9,  "C-108", "SW Lot Site"),
    (10, "C-109", "NW Lot Site"),
    (11, "C-111", "Lots 1, 5, and 7 Site"),
    (12, "C-112", "Lot 17 Site"),
    (13, "C-201", "East Temporary Stockpile"),
    (14, "C-202", "North Lobe Grading"),
    (15, "C-203", "Borrow Source Demonstration Area"),
    (16, "C-501", "Detail Sheet I"),
    (17, "C-502", "Detail Sheet II"),
    (18, "C-503", "Detail Sheet III"),
]

# Long edge in pixels. A 36 in sheet at 4200 px is ~117 dpi: text in the general
# notes is 6-7 px tall, which reads cleanly once the viewer zooms past ~1.5x, and
# keeps a q68 JPG under about a megabyte for the line-art sheets.
LONG_EDGE = 4200
QUALITY = 68


def render(page, sheet, title, design_set, dst):
    zoom = LONG_EDGE / max(page.rect.width, page.rect.height)
    pix = page.get_pixmap(matrix=pymupdf.Matrix(zoom, zoom), alpha=False)
    im = Image.frombytes("RGB", (pix.width, pix.height), pix.samples)
    q = QUALITY
    while True:
        buf = io.BytesIO()
        im.save(buf, "JPEG", quality=q, optimize=True, progressive=True)
        b = buf.getvalue()
        # A couple of sheets carry a colour aerial under the plan and blow past
        # the budget at q68; step the quality down rather than the resolution,
        # because it is the *text* that has to stay readable.
        if len(b) <= 1_250_000 or q <= 46:
            break
        q -= 6
    open(dst, "wb").write(b)
    return dict(sheet=sheet, title=title, design_set=design_set,
                file=os.path.basename(dst), w=im.width, h=im.height,
                bytes=len(b), quality=q)


def main():
    os.makedirs(OUT, exist_ok=True)
    index = []
    doc = pymupdf.open(FINAL)
    for i, sheet, title in FINAL_SHEETS:
        dst = os.path.join(OUT, "sheet_full_%s.jpg" % sheet.replace("-", ""))
        m = render(doc[i], sheet, title, "Final", dst)
        index.append(m)
        print("%-6s %-42s %5dx%-5d q%-3d %7.0f kB"
              % (sheet, title, m["w"], m["h"], m["quality"], m["bytes"] / 1024),
              flush=True)
    d90 = pymupdf.open(PRE90)
    m = render(d90[0], "C-110", "Lot 31 Site", "90%",
               os.path.join(OUT, "sheet_full_C110.jpg"))
    index.append(m)
    print("%-6s %-42s %5dx%-5d q%-3d %7.0f kB (90%% Pre-Final)"
          % ("C-110", "Lot 31 Site", m["w"], m["h"], m["quality"],
             m["bytes"] / 1024), flush=True)

    index.sort(key=lambda d: d["sheet"])
    json.dump({
        "source": ("EA Engineering, Appendix A. Engineering Drawings, Final "
                   "Residential Design, September 2025 (100% Plans for "
                   "Construction), project 1578546. C-110 is from the 90% "
                   "Pre-Final Design set (May 2025) and is a superseded design."),
        "note": ("Full uncropped sheets as plotted (36x24 in), rendered at "
                 "%d px on the long edge (~%d dpi)." % (LONG_EDGE,
                                                        round(LONG_EDGE / 36))),
        "sheets": index,
    }, open(IDX, "w"), indent=1)
    tot = sum(d["bytes"] for d in index)
    print("total %d sheets, %.1f MB" % (len(index), tot / 1e6))


if __name__ == "__main__":
    main()
