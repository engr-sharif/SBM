#!/usr/bin/env python3
"""Recover the full-sheet pixel → State Plane affine for every registered sheet
and write it into data/sheets_full.json.

Why this exists
---------------
§9 of docs/V9_SPEC.md asks for measuring and marking inside the floating sheet
viewer, and says to use "the sheet affine in data/sheets_full.json". There was
no such affine: sheets_full.json is only a render index (sheet, title, w, h),
and the registration in data/design_ea.json describes the *de-rotated crop* of
each sheet's plan area (`raster`: a State Plane bbox at 0.5 ft/px) plus the
sheet's scale (`sx`, ft per PDF point) and drafting-grid rotation (`rot_deg`).
Nothing recorded where that crop sat on the page, so the viewer's own pixels
could not be turned into coordinates.

Recovery
--------
The crop and the full sheet are two renders of the same PDF page, so the
transform between them is a pure similarity whose scale and rotation are both
already known:

    ft per full-sheet px  = sx * (page_width_pt / render_width_px)
    ft per crop px        = raster.ft_per_px          (0.5)
    rotation              = rot_deg

Only the translation is unknown — two numbers — and two numbers are exactly
what phase correlation recovers. So the page is re-rendered at the viewer's own
resolution, warped into the crop's frame with the known scale and rotation, and
phase-correlated against the crop's own alpha channel (the crop has its paper
knocked out to transparency, which makes the ink a clean correlation signal).

That is not a fit with free parameters: with scale and rotation locked, a wrong
answer does not look plausible, it looks like noise. Every accepted sheet is
scored two ways and both are reported:

    peak   the normalised phase-correlation peak (a true match is a spike)
    ncc    normalised cross-correlation of the crop against the warped sheet
           at the recovered offset

and a third, independent check is applied where it can be: EA's native
geodatabase geometry for that sheet (data/design_gis.json, which knows nothing
about the PDF) is mapped through the recovered affine and has to land inside
the sheet's plan area. A sheet that fails any of these is written with
`affine: null` and the viewer treats it as not georeferenced, which is the
behaviour §9 specifies for an unregistered sheet — a wrong affine would be far
worse than none.

Usage
-----
    python tools/build_sheet_affine.py            # writes data/sheets_full.json
    python tools/build_sheet_affine.py --dry-run  # report only

Then re-run tools/build_data.py to refresh datajs/d_sheets_full.js.
"""
import argparse
import json
import math
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

FINAL = ("/mnt/user-data/uploads/SBMM/Residental RA Support/"
         "EA_ResidentialCleanupDesign/Final Residential Design/"
         "Appendix A. Engineering Drawings.pdf")
PRE90 = ("/mnt/user-data/uploads/SBMM/Residental RA Support/"
         "EA_ResidentialCleanupDesign/90% Design 050125/Pre-Final Design_90%/"
         "Appendix A. Engineering Drawings.pdf")

# acceptance gates — deliberately strict, see the module docstring
MIN_PEAK = 0.06
MIN_NCC = 0.20


def rot2(deg):
    a = math.radians(deg)
    c, s = math.cos(a), math.sin(a)
    # (row, col) space; sign convention is ours and is used consistently below
    return ((c, -s), (s, c))


def matmul(A, v):
    return (A[0][0] * v[0] + A[0][1] * v[1], A[1][0] * v[0] + A[1][1] * v[1])


def warp(src, out_shape, A, b, np, ndimage):
    """out[p] = src[A @ p + b], bilinear, zero outside."""
    return ndimage.affine_transform(src, np.array(A), offset=np.array(b),
                                    output_shape=out_shape, order=1, cval=0.0)


def phase_corr(a, b, np):
    """Offset (drow, dcol) of `b` inside `a`, and the normalised peak."""
    H = 1 << (max(a.shape[0], b.shape[0]) - 1).bit_length()
    W = 1 << (max(a.shape[1], b.shape[1]) - 1).bit_length()
    A = np.zeros((H, W), np.float32)
    B = np.zeros((H, W), np.float32)
    A[:a.shape[0], :a.shape[1]] = a - a.mean()
    B[:b.shape[0], :b.shape[1]] = b - b.mean()
    FA = np.fft.rfft2(A)
    FB = np.fft.rfft2(B)
    R = FA * np.conj(FB)
    R /= (np.abs(R) + 1e-9)
    c = np.fft.irfft2(R, s=(H, W))
    k = np.unravel_index(np.argmax(c), c.shape)
    dr = k[0] if k[0] < H // 2 else k[0] - H
    dc = k[1] if k[1] < W // 2 else k[1] - W
    return dr, dc, float(c[k])


def ncc(a, b, np):
    a = a - a.mean()
    b = b - b.mean()
    d = math.sqrt(float((a * a).sum()) * float((b * b).sum()))
    return float((a * b).sum() / d) if d > 0 else 0.0


def solve_sheet(name, sh, full, doc_pages, np, ndimage, pymupdf, Image, verbose):
    r = sh.get("raster")
    if not r:
        return None, "no registered raster"
    png = os.path.join(ROOT, "data", "design", r["file"])
    if not os.path.isfile(png):
        return None, "raster png missing: " + r["file"]
    page = doc_pages(name, sh)
    if page is None:
        return None, "source page not available"

    long_edge = max(full["w"], full["h"])
    zoom = long_edge / max(page.rect.width, page.rect.height)
    pix = page.get_pixmap(matrix=pymupdf.Matrix(zoom, zoom), alpha=False)
    F = np.asarray(Image.frombytes("RGB", (pix.width, pix.height), pix.samples)
                   .convert("L"), dtype=np.float32)
    if F.shape[1] != full["w"] or F.shape[0] != full["h"]:
        return None, ("re-render %dx%d != viewer render %dx%d"
                      % (F.shape[1], F.shape[0], full["w"], full["h"]))
    Fink = (255.0 - F) / 255.0

    ftF = sh["sx"] * (page.rect.width / F.shape[1])     # ft per full-sheet px
    fpp = r["ft_per_px"]                                # ft per crop px
    s = ftF / fpp                                       # crop px per sheet px

    C = np.asarray(Image.open(png))
    if C.ndim != 3 or C.shape[2] < 4:
        return None, "raster has no alpha channel to correlate on"
    alpha = C[..., 3].astype(np.float32) / 255.0
    if alpha.max() <= 0:
        return None, "raster alpha is empty"
    # Two correlation signals, because the crops are not all the same kind of
    # picture. On a line-art sheet the alpha mask alone IS the drawing. On the
    # sheets with a colour aerial under the plan (C-106 is the clear case) the
    # mask is nearly solid and carries almost no structure, so the darkness of
    # the ink inside the mask is the only thing worth matching. Whichever scores
    # better against the same warped render wins; both are reported.
    grey = C[..., :3].astype(np.float32).mean(axis=2) / 255.0
    Cvariants = [("alpha", alpha), ("ink", (1.0 - grey) * alpha)]
    Cvariants = [(n, v) for n, v in Cvariants if float(v.std()) > 1e-4]
    if not Cvariants:
        return None, "raster carries no correlatable structure"
    Cink = Cvariants[0][1]

    # 1. scale the sheet into the crop's ground resolution
    #    S[p] = Fink[p / s]   ->  A = (1/s) I, b = 0
    Sh = (int(round(F.shape[0] * s)), int(round(F.shape[1] * s)))
    S = warp(Fink, Sh, ((1.0 / s, 0.0), (0.0, 1.0 / s)), (0.0, 0.0), np, ndimage)

    best = None
    for ang, (cname, Cink) in [(a, cv) for a in (sh["rot_deg"], -sh["rot_deg"])
                               for cv in Cvariants]:
        # 2. rotate into the crop's north-up frame, with OUR matrix so the
        #    composition below is exact rather than reverse-engineered
        Rm = rot2(ang)
        corners = [(0, 0), (0, Sh[1]), (Sh[0], 0), (Sh[0], Sh[1])]
        cen = (Sh[0] / 2.0, Sh[1] / 2.0)
        rc = [matmul(((Rm[0][0], Rm[0][1]), (Rm[1][0], Rm[1][1])),
                     (p[0] - cen[0], p[1] - cen[1])) for p in corners]
        h2 = int(math.ceil(max(p[0] for p in rc) - min(p[0] for p in rc)))
        w2 = int(math.ceil(max(p[1] for p in rc) - min(p[1] for p in rc)))
        cen2 = (h2 / 2.0, w2 / 2.0)
        # W[q] = S[ Rm @ (q - cen2) + cen ]
        bb = (cen[0] - Rm[0][0] * cen2[0] - Rm[0][1] * cen2[1],
              cen[1] - Rm[1][0] * cen2[0] - Rm[1][1] * cen2[1])
        Wimg = warp(S, (h2, w2), Rm, bb, np, ndimage)
        if Wimg.shape[0] < Cink.shape[0] or Wimg.shape[1] < Cink.shape[1]:
            pad = np.zeros((max(h2, Cink.shape[0]), max(w2, Cink.shape[1])), np.float32)
            pad[:h2, :w2] = Wimg
            Wimg = pad
        dr, dc, peak = phase_corr(Wimg, Cink, np)
        # score the match itself, not only the spike
        # overlap of the crop, shifted by (dr, dc), with the warped sheet
        r0, c0 = max(0, dr), max(0, dc)
        r1 = min(Wimg.shape[0], Cink.shape[0] + dr)
        c1 = min(Wimg.shape[1], Cink.shape[1] + dc)
        if r1 - r0 < 20 or c1 - c0 < 20:
            continue
        sub = Wimg[r0:r1, c0:c1]
        ref = Cink[r0 - dr:r1 - dr, c0 - dc:c1 - dc]
        sc = ncc(sub, ref, np)
        if verbose:
            print("      ang %+9.3f  %-5s peak %.4f  ncc %+.3f  shift %d,%d"
                  % (ang, cname, peak, sc, dr, dc))
        if best is None or sc > best["ncc"]:
            best = dict(ang=ang, dr=dr, dc=dc, peak=peak, ncc=sc, signal=cname,
                        Rm=Rm, bb=bb, cen=cen, cen2=cen2, s=s)

    if best is None:
        return None, "no candidate orientation produced a comparable overlap"
    if best["peak"] < MIN_PEAK or best["ncc"] < MIN_NCC:
        return None, ("match too weak (peak %.3f, ncc %.3f)"
                      % (best["peak"], best["ncc"]))

    # ---- compose crop-pixel -> sheet-pixel, then sheet-pixel -> State Plane ----
    # crop pixel (jc, ic) sits at W coord (jc + dr, ic + dc)
    # W -> S :  p = Rm @ (q - cen2) + cen
    # S -> F :  Fcoord = p / s
    Rm, bb, s2 = best["Rm"], best["bb"], best["s"]
    dr, dc = best["dr"], best["dc"]

    def crop_to_sheet(jc, ic):
        q = (jc + dr, ic + dc)
        p = (Rm[0][0] * q[0] + Rm[0][1] * q[1] + bb[0],
             Rm[1][0] * q[0] + Rm[1][1] * q[1] + bb[1])
        return (p[0] / s2, p[1] / s2)        # (row_v, col_u) in full-sheet px

    # three crop points define the affine both ways
    p00 = crop_to_sheet(0.0, 0.0)
    p10 = crop_to_sheet(1.0, 0.0)
    p01 = crop_to_sheet(0.0, 1.0)
    # sheet = M @ crop + t, with M columns = d/d(jc), d/d(ic)
    M = ((p10[1] - p00[1], p01[1] - p00[1]),      # du/djc, du/dic
         (p10[0] - p00[0], p01[0] - p00[0]))      # dv/djc, dv/dic
    t = (p00[1], p00[0])                          # (u, v) at crop (0,0)
    det = M[0][0] * M[1][1] - M[0][1] * M[1][0]
    if abs(det) < 1e-12:
        return None, "degenerate transform"
    Mi = ((M[1][1] / det, -M[0][1] / det),
          (-M[1][0] / det, M[0][0] / det))        # sheet -> crop

    # crop pixel -> State Plane: x = x0 + (ic + .5)*fpp ; y = y1 - (jc + .5)*fpp
    # so, with (jc, ic) = Mi @ ((u,v) - t):
    #   jc = Mi00*(u-tu) + Mi01*(v-tv)
    #   ic = Mi10*(u-tu) + Mi11*(v-tv)
    a = Mi[1][0] * fpp
    b_ = Mi[1][1] * fpp
    c_ = r["x0"] + fpp * 0.5 - (Mi[1][0] * t[0] + Mi[1][1] * t[1]) * fpp
    d = -Mi[0][0] * fpp
    e = -Mi[0][1] * fpp
    f = r["y1"] - fpp * 0.5 + (Mi[0][0] * t[0] + Mi[0][1] * t[1]) * fpp

    aff = dict(a=a, b=b_, c=c_, d=d, e=e, f=f)

    # ---- self-check: round-trip the crop's own corners ----
    def to_sp(u, v):
        return (a * u + b_ * v + c_, d * u + e * v + f)

    err = 0.0
    for (jc, ic) in [(0, 0), (0, C.shape[1] - 1), (C.shape[0] - 1, 0),
                     (C.shape[0] - 1, C.shape[1] - 1)]:
        v, u = crop_to_sheet(jc + 0.5, ic + 0.5)
        gx, gy = to_sp(u, v)
        wx = r["x0"] + (ic + 0.5) * fpp
        wy = r["y1"] - (jc + 0.5) * fpp
        err = max(err, math.hypot(gx - wx, gy - wy))

    # ---- independent check: EA's own geodatabase geometry for this sheet ----
    # design_gis.json comes from EA's GIS deliverable and knows nothing about
    # the PDF or this correlation. If the affine is right, the design polygons
    # EA drew on this sheet land on this sheet's plan area. If it is wrong they
    # land off the paper. This is the "never accept one method" rule from the
    # registration notes in CLAUDE.md, applied to a different quantity.
    gis = gis_check(name, a, b_, c_, d, e, f, F.shape[1], F.shape[0])

    out = dict(a=round(a, 9), b=round(b_, 9), c=round(c_, 4),
               d=round(d, 9), e=round(e, 9), f=round(f, 4),
               ft_per_px=round(math.hypot(a, d), 6),
               rot_deg=round(best["ang"], 4),
               peak=round(best["peak"], 4), ncc=round(best["ncc"], 4),
               signal=best["signal"],
               roundtrip_ft=round(err, 4),
               gis_check=gis,
               method=("phase correlation of the full-sheet render against the "
                       "registered de-rotated crop, with scale and rotation "
                       "locked to the sheet's own registration; confirmed "
                       "against EA's native geodatabase geometry for the same "
                       "sheet where that exists"))
    # A wrong affine puts EA's geometry nowhere near the paper — the failing
    # case is ~0 %, not 80 %. Design polygons legitimately run past the plan
    # viewport's clip on a tightly cropped sheet, so the gate is set where the
    # two populations are unambiguously separated rather than at "perfect".
    if gis and gis.get("n") and gis["inside_pct"] < 50:
        return None, ("only %d%% of EA's own geometry for this sheet lands on "
                      "the paper through the recovered affine"
                      % gis["inside_pct"])
    return out, None


_GIS = None


def gis_check(name, a, b, c, d, e, f, W, H):
    """Map every native design vertex EA attributes to this sheet through the
    inverse affine and report what fraction lands on the sheet."""
    global _GIS
    if _GIS is None:
        p = os.path.join(ROOT, "data", "design_gis.json")
        _GIS = json.load(open(p)) if os.path.isfile(p) else {"features": []}
    det = a * e - b * d
    if abs(det) < 1e-15:
        return None
    ia, ib = e / det, -b / det
    id_, ie = -d / det, a / det

    def to_px(x, y):
        return (ia * (x - c) + ib * (y - f), id_ * (x - c) + ie * (y - f))

    n = 0
    inside = 0
    for ft in _GIS.get("features", []):
        pr = ft.get("properties") or {}
        if pr.get("sheet") != name:
            continue
        g = ft.get("geometry") or {}
        rings = []
        if g.get("type") == "Polygon":
            rings = g["coordinates"]
        elif g.get("type") == "LineString":
            rings = [g["coordinates"]]
        for ring in rings:
            for q in ring:
                u, v = to_px(q[0], q[1])
                n += 1
                if 0 <= u < W and 0 <= v < H:
                    inside += 1
    if not n:
        return {"n": 0, "note": "no native geometry attributed to this sheet"}
    return {"n": n, "inside_pct": int(round(100.0 * inside / n))}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--sheet", help="only this sheet")
    ap.add_argument("-v", "--verbose", action="store_true")
    args = ap.parse_args()

    import numpy as np
    from scipy import ndimage
    import pymupdf
    from PIL import Image

    idx_path = os.path.join(ROOT, "data", "sheets_full.json")
    idx = json.load(open(idx_path))
    ea = json.load(open(os.path.join(ROOT, "data", "design_ea.json")))

    docs = {}
    if os.path.isfile(FINAL):
        docs["Final"] = pymupdf.open(FINAL)
    if os.path.isfile(PRE90):
        docs["90%"] = pymupdf.open(PRE90)
    if not docs:
        sys.exit("neither source PDF is reachable — nothing to recover from")

    def page_for(name, sh):
        ds = sh.get("design_set", "Final")
        doc = docs.get(ds)
        if doc is None:
            return None
        p = sh["page"] - 1
        return doc[p] if 0 <= p < doc.page_count else None

    ok = weak = skipped = 0
    for s in idx["sheets"]:
        name = s["sheet"]
        if args.sheet and name != args.sheet:
            continue
        sh = ea["sheets"].get(name)
        if not sh:
            s["affine"] = None
            s["affine_note"] = "sheet is not georeferenced"
            skipped += 1
            print("%-6s  —  not registered" % name)
            continue
        if s.get("affine_source") == "native":
            # Placed from EA's native geometry by tools/register_sheet_native.py,
            # with one affine per plan viewport. The crop-vs-page correlation
            # below would only ever find the primary viewport and would throw
            # the others away, so the record is that tool's to write, not ours.
            ok += 1
            print("%-6s  kept  native-geometry registration (%d viewport%s) — "
                  "re-run tools/register_sheet_native.py to change it"
                  % (name, len(s.get("viewports") or []), "" if len(s.get("viewports") or []) == 1 else "s"))
            continue
        if args.verbose:
            print("%-6s" % name)
        aff, why = solve_sheet(name, sh, s, page_for, np, ndimage, pymupdf,
                               Image, args.verbose)
        if aff is None:
            s["affine"] = None
            s["affine_note"] = why
            weak += 1
            print("%-6s  —  %s" % (name, why))
        else:
            s["affine"] = aff
            s.pop("affine_note", None)
            ok += 1
            g = aff.get("gis_check") or {}
            print("%-6s  ok   %.4f ft/px  rot %+8.3f  peak %.3f  ncc %+.3f  "
                  "round-trip %.2f ft  EA geometry on sheet %s"
                  % (name, aff["ft_per_px"], aff["rot_deg"], aff["peak"],
                     aff["ncc"], aff["roundtrip_ft"],
                     ("%d%% of %d pts" % (g["inside_pct"], g["n"]))
                     if g.get("n") else "n/a"))

    idx["affine_note"] = (
        "Per-sheet affine from full-sheet render pixels (u = column, v = row, "
        "origin top-left) to EPSG:6418 State Plane feet: x = a*u + b*v + c, "
        "y = d*u + e*v + f. Recovered by tools/build_sheet_affine.py — see that "
        "file for the method and the acceptance gates. `affine: null` means the "
        "sheet has no place on the ground and the viewer must refuse to "
        "georeference a mark on it.")
    print("\n%d recovered · %d rejected · %d unregistered" % (ok, weak, skipped))
    if args.dry_run:
        print("(dry run — nothing written)")
        return
    json.dump(idx, open(idx_path, "w"), indent=1)
    print("wrote " + idx_path)
    print("now run: python tools/build_data.py   (refreshes datajs/d_sheets_full.js)")


if __name__ == "__main__":
    main()
