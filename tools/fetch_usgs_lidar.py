#!/usr/bin/env python3
"""Fetch the public USGS 3DEP lidar over the SBMM site (build-time only).

The app's own canopy data stops at the mine window, because only one tile of the
surveyor's January-2024 point cloud was ever delivered. The USGS 3D Elevation
Program flew the whole county, and its point clouds are public. This tool pulls
the part of one of them that lies over the site, so tools/build_trees.py can
find the trees the app has no canopy model for.

    python3 tools/fetch_usgs_lidar.py WORKDIR [--depth 12] [--jobs 12]

SOURCE. The USGS publishes each lidar project twice: as LAZ tiles on
rockyweb.usgs.gov, and as an Entwine Point Tile (EPT) octree in the public
bucket `usgs-lidar-public` on AWS. The EPT copy is used here because an octree
can be asked for a rectangle: only the nodes over the site are downloaded
(a few hundred MB) rather than sixteen whole tiles (1.4 GB).

    project   CA_NorthCoastRanges_2_B23  (published 2025)
    index     https://s3-us-west-2.amazonaws.com/usgs-lidar-public/<project>/ept.json
    CRS       EPSG:3857 (web mercator, metres); heights NAVD88 metres

NOTHING HERE RUNS IN THE APP. The app makes no network calls; this is a
build-time download, like the masters the DEMs were cut from. The downloaded
nodes are NOT committed (they are large and public) — the tree table baked
from them is.

Needs: pyproj, and curl on the path (every request goes through it).
"""
import argparse
import json
import os
import subprocess
import sys

BASE = "https://s3-us-west-2.amazonaws.com/usgs-lidar-public"
PROJECT = "CA_NorthCoastRanges_2_B23"

# the site DEM's extent, EPSG:6418 US survey feet (data/dem_site.json)
SITE = dict(x0=6368100.0, y0=2122800.0, x1=6368100.0 + 4850 * 2.0, y1=2122800.0 + 4450 * 2.0)
BUFFER_FT = 60.0


def get_json(url):
    # curl, not urllib: it honours the proxy and CA settings of whatever box this runs on
    out = subprocess.run(["curl", "-sS", "-f", "--retry", "6", "--retry-delay", "2", "--retry-all-errors",
                          "--max-time", "60", url], capture_output=True, check=True).stdout
    return json.loads(out.decode("utf-8"))


def site_bbox_3857():
    # PROJ would otherwise try to download datum grids, and hang where it cannot
    os.environ.setdefault("PROJ_NETWORK", "OFF")
    from pyproj import Transformer
    t = Transformer.from_crs(6418, 3857, always_xy=True)
    xs, ys = [], []
    for x in (SITE["x0"] - BUFFER_FT, SITE["x1"] + BUFFER_FT):
        for y in (SITE["y0"] - BUFFER_FT, SITE["y1"] + BUFFER_FT):
            mx, my = t.transform(x, y)
            xs.append(mx)
            ys.append(my)
    return min(xs), min(ys), max(xs), max(ys)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("workdir")
    ap.add_argument("--project", default=PROJECT)
    ap.add_argument("--depth", type=int, default=12,
                    help="deepest octree level to fetch (12 = ~0.35 m point spacing)")
    ap.add_argument("--jobs", type=int, default=12)
    ap.add_argument("--list-only", action="store_true")
    a = ap.parse_args()

    root = f"{BASE}/{a.project}"
    os.makedirs(a.workdir, exist_ok=True)
    data_dir = os.path.join(a.workdir, "ept-data")
    os.makedirs(data_dir, exist_ok=True)

    ept = get_json(root + "/ept.json")
    with open(os.path.join(a.workdir, "ept.json"), "w") as f:
        json.dump(ept, f)
    bx0, by0, bz0, bx1, by1, bz1 = ept["bounds"]
    side = bx1 - bx0
    sx0, sy0, sx1, sy1 = site_bbox_3857()
    print(f"site bbox (EPSG:3857): {sx0:.0f} {sy0:.0f} {sx1:.0f} {sy1:.0f}")

    def touches(d, x, y):
        s = side / (1 << d)
        nx0, ny0 = bx0 + x * s, by0 + y * s
        return not (nx0 > sx1 or nx0 + s < sx0 or ny0 > sy1 or ny0 + s < sy0)

    # walk the hierarchy: a value of -1 points at a further hierarchy file. The
    # files are small and there are several hundred of them over the site, so
    # each generation is fetched in parallel.
    from concurrent.futures import ThreadPoolExecutor
    want, pending, seen = {}, ["0-0-0-0"], set()
    with ThreadPoolExecutor(max_workers=a.jobs) as pool:
        while pending:
            batch = [k for k in dict.fromkeys(pending) if k not in seen]
            seen.update(batch)
            pending = []
            for h in pool.map(lambda k: get_json(f"{root}/ept-hierarchy/{k}.json"), batch):
                for k, n in h.items():
                    d, x, y, z = (int(v) for v in k.split("-"))
                    if d > a.depth or not touches(d, x, y):
                        continue
                    if n == -1:
                        pending.append(k)
                    elif n > 0:
                        want[k] = n
            print(f"  hierarchy: {len(seen)} files read, {len(want)} nodes so far", flush=True)
    pts = sum(want.values())
    print(f"{len(want)} nodes over the site to depth {a.depth}, {pts / 1e6:.1f} M points")
    with open(os.path.join(a.workdir, "nodes.json"), "w") as f:
        json.dump(want, f)
    if a.list_only:
        return

    todo = [k for k in want if not os.path.exists(os.path.join(data_dir, k + ".laz"))]
    print(f"{len(todo)} to download")
    if todo:
        lst = os.path.join(a.workdir, "urls.txt")
        with open(lst, "w") as f:
            for k in todo:
                f.write(k + "\n")
        cmd = (f"xargs -P {a.jobs} -I{{}} curl -sS -f --retry 6 --retry-delay 2 --retry-all-errors --max-time 300 "
               f"-o {data_dir}/{{}}.laz.part {root}/ept-data/{{}}.laz "
               f"< {lst}")
        subprocess.run(cmd, shell=True, check=False)
        for k in todo:
            p = os.path.join(data_dir, k + ".laz.part")
            if os.path.exists(p) and os.path.getsize(p) > 0:
                os.replace(p, os.path.join(data_dir, k + ".laz"))
    missing = [k for k in want if not os.path.exists(os.path.join(data_dir, k + ".laz"))]
    print(f"done: {len(want) - len(missing)} of {len(want)} nodes on disk" +
          (f" — {len(missing)} MISSING, re-run to retry" if missing else ""))
    sys.exit(1 if missing else 0)


if __name__ == "__main__":
    main()
