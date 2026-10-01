"""v31 — stamp the byte size of every script index.html loads into js/loader.js.

The loading screen (js/loader.js) shows real progress from the first byte: how
many of the boot payload's megabytes have arrived, at what rate, and which file
is on its way. A browser cannot tell a page how big a script it has not
received yet is, so the sizes ride in the loader itself, in page order, between
the SBMM_SIZES markers. Each row is [path, bytes, kind]:

    kind ""   a static <script src> tag, parsed before boot
    kind "h"  a heavy payload (index.html's SBMM_HEAVY) — skipped on a phone
    kind "d"  a heavy payload loaded AFTER boot (js/payloads.js) — not in the
              boot total at all

    python3 tools/stamp_sizes.py          # rewrite the block
    python3 tools/stamp_sizes.py --check  # exit 1 if it is stale

test/check.mjs runs the same comparison (the `sizes` check) with a tolerance:
the app's own js/*.js change size on every commit and a few kB of drift moves
no progress bar, but a regenerated payload or a new script must be restamped.
"""
import json, os, re, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
LATE = re.compile(r"_lazy\.js$|_rasters\.js$|/i_sheet_full_")   # = index.html's LATE


def rows():
    html = open(os.path.join(ROOT, "index.html"), encoding="utf-8").read()
    heavy_m = re.search(r"/\* SBMM_HEAVY_BEGIN \*/\s*window\.SBMM_HEAVY\s*=\s*\[(.*?)\]", html, re.S)
    heavy = re.findall(r'"([^"]+)"', heavy_m.group(1)) if heavy_m else []
    out, done_heavy = [], False
    # walk the page in order: every static tag, and the heavy list at the
    # position of its block
    for m in re.finditer(r'<script src="([^"]+)"></script>|/\* SBMM_HEAVY_BEGIN \*/', html):
        if m.group(1):
            src = m.group(1)
            if src == "js/loader.js":      # it is running when it reads this
                continue
            out.append([src, size(src), ""])
        elif not done_heavy:
            done_heavy = True
            for src in heavy:
                out.append([src, size(src), "d" if LATE.search(src) else "h"])
    return out


def size(src):
    p = os.path.join(ROOT, src.split("?")[0])
    return os.path.getsize(p) if os.path.exists(p) else 0


def block(rs):
    lines = ",\n".join("    " + json.dumps(r, separators=(",", ":")) for r in rs)
    return "/* SBMM_SIZES_BEGIN */\n  var SIZES = [\n" + lines + "\n  ];\n  /* SBMM_SIZES_END */"


def main():
    path = os.path.join(ROOT, "js", "loader.js")
    js = open(path, encoding="utf-8").read()
    new = re.sub(r"/\* SBMM_SIZES_BEGIN \*/.*?/\* SBMM_SIZES_END \*/", lambda m: block(rows()), js,
                 count=1, flags=re.S)
    if "--check" in sys.argv[1:]:
        if new != js:
            print("js/loader.js SIZES is stale — run: python3 tools/stamp_sizes.py")
            return 1
        print("js/loader.js SIZES is current")
        return 0
    with open(path, "w", encoding="utf-8") as f:
        f.write(new)
    rs = rows()
    boot = sum(r[1] for r in rs if r[2] != "d")
    late = sum(r[1] for r in rs if r[2] == "d")
    print(f"stamped {len(rs)} scripts into js/loader.js — boot {boot/1e6:.1f} MB, "
          f"after boot {late/1e6:.1f} MB")
    return 0


if __name__ == "__main__":
    sys.exit(main())
