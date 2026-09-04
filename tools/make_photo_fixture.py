#!/usr/bin/env python3
"""
Write test/fixtures/photo_exif.jpg — the JPEG the field harness feeds to the
Photo tool (docs/V11_SPEC.md §4.5).

The fixture has to carry three things js/field.js's `readExif` reads, because a
photo with none of them proves nothing:

    IFD0   0x0112 Orientation        = 6   (rotate 90 CW: a landscape frame
                                            that must come out portrait)
    Exif   0x9003 DateTimeOriginal   = "2026:08:14 09:41:07"
    GPS    0x0001..0x0004            = a latitude/longitude ON THIS SITE

The GPS position is derived from a State Plane point through the same affine
the app uses (data/affine.json), so `SBMM.fromLL` puts the photo back within a
hundredth of a foot of TARGET_SP and the harness can assert ±2 ft.

The APP1 segment is assembled here by hand with `struct` rather than handed to
a library, so the byte layout the parser has to survive is written down in one
place. The pixels come from Pillow, which is the only non-stdlib part; the
fixture is COMMITTED, so this script is only run when the fixture needs to
change.

    python3 tools/make_photo_fixture.py
"""
import io, json, os, struct, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "test", "fixtures", "photo_exif.jpg")

# A recognisable spot inside the 1-ft mine window, well within every DEM.
TARGET_SP = (6371600.0, 2128900.0)
TAKEN = "2026:08:14 09:41:07"
ORIENTATION = 6
W, H = 800, 600            # landscape source; orientation 6 makes it portrait


def to_ll(x, y):
    """The app's SBMM.toLL, in Python: SP ft -> (lon, lat)."""
    a = json.load(open(os.path.join(ROOT, "data", "affine.json")))
    lon = a["lon"][0] * x + a["lon"][1] * y + a["lon"][2]
    lat = a["lat"][0] * x + a["lat"][1] * y + a["lat"][2]
    return lon, lat


def dms(v):
    """Degrees as three EXIF RATIONALs. Seconds keep 1e-4 s (~0.003 ft here)."""
    v = abs(v)
    d = int(v)
    m = int((v - d) * 60)
    s = (v - d - m / 60.0) * 3600.0
    return [(d, 1), (m, 1), (int(round(s * 10000)), 10000)]


def build_exif(lon, lat):
    """One APP1 payload: 'Exif\\0\\0' + a big-endian TIFF with IFD0, Exif and GPS."""
    # ---- values that do not fit in a tag's 4 inline bytes live after the IFDs
    taken = (TAKEN + "\0").encode("ascii")

    lat_r = dms(lat)
    lon_r = dms(lon)
    lat_ref = (b"N\0" if lat >= 0 else b"S\0")
    lon_ref = (b"E\0" if lon >= 0 else b"W\0")

    # Layout, all offsets relative to the TIFF header ("MM\0*" at 0):
    #   8              IFD0 (2 entries + Exif ptr + GPS ptr = 3 entries)
    #   after IFD0     Exif IFD (1 entry)
    #   after that     GPS IFD (4 entries)
    #   after that     the out-of-line values
    ifd0_n = 3
    exif_n = 1
    gps_n = 4
    ifd0_off = 8
    ifd0_len = 2 + 12 * ifd0_n + 4
    exif_off = ifd0_off + ifd0_len
    exif_len = 2 + 12 * exif_n + 4
    gps_off = exif_off + exif_len
    gps_len = 2 + 12 * gps_n + 4
    data_off = gps_off + gps_len

    blobs = []          # (offset, bytes)
    cursor = data_off

    def put(b):
        nonlocal cursor
        off = cursor
        blobs.append((off, b))
        cursor += len(b) + (len(b) & 1)      # keep everything even-aligned
        return off

    taken_off = put(taken)
    lat_off = put(b"".join(struct.pack(">II", n, d) for n, d in lat_r))
    lon_off = put(b"".join(struct.pack(">II", n, d) for n, d in lon_r))

    def entry(tag, typ, cnt, payload):
        """payload: an int offset, or up to 4 raw bytes padded to the LEFT-aligned slot."""
        if isinstance(payload, bytes):
            payload = payload + b"\0" * (4 - len(payload))
            return struct.pack(">HHI", tag, typ, cnt) + payload
        return struct.pack(">HHII", tag, typ, cnt, payload)

    # SHORT values sit in the high half of the 4-byte slot in big-endian
    ifd0 = struct.pack(">H", ifd0_n) \
        + entry(0x0112, 3, 1, struct.pack(">HH", ORIENTATION, 0)) \
        + entry(0x8769, 4, 1, exif_off) \
        + entry(0x8825, 4, 1, gps_off) \
        + struct.pack(">I", 0)

    exif = struct.pack(">H", exif_n) \
        + entry(0x9003, 2, len(taken), taken_off) \
        + struct.pack(">I", 0)

    gps = struct.pack(">H", gps_n) \
        + entry(0x0001, 2, 2, lat_ref) \
        + entry(0x0002, 5, 3, lat_off) \
        + entry(0x0003, 2, 2, lon_ref) \
        + entry(0x0004, 5, 3, lon_off) \
        + struct.pack(">I", 0)

    tiff = bytearray(b"MM\x00\x2a" + struct.pack(">I", ifd0_off) + ifd0 + exif + gps)
    for off, b in blobs:
        if len(tiff) < off:
            tiff += b"\0" * (off - len(tiff))
        tiff[off:off + len(b)] = b
    return b"Exif\x00\x00" + bytes(tiff)


def splice_app1(jpeg, app1):
    """Insert the APP1 segment right after SOI, where every reader looks first."""
    assert jpeg[:2] == b"\xff\xd8", "not a JPEG"
    seg = b"\xff\xe1" + struct.pack(">H", len(app1) + 2) + app1
    return jpeg[:2] + seg + jpeg[2:]


def main():
    try:
        from PIL import Image, ImageDraw
    except ImportError:
        print("this script needs Pillow for the pixels (the fixture itself is committed)")
        return 1
    im = Image.new("RGB", (W, H), (34, 48, 56))
    d = ImageDraw.Draw(im)
    # something with an obvious top and left, so a wrong orientation is visible
    d.rectangle([0, 0, W - 1, 59], fill=(232, 179, 75))
    d.rectangle([0, 0, 59, H - 1], fill=(79, 179, 206))
    d.ellipse([W // 2 - 90, H // 2 - 90, W // 2 + 90, H // 2 + 90], outline=(255, 211, 77), width=8)
    d.text((90, 90), "SBMM field photo fixture", fill=(232, 238, 241))
    buf = io.BytesIO()
    im.save(buf, "JPEG", quality=85)

    lon, lat = to_ll(*TARGET_SP)
    out = splice_app1(buf.getvalue(), build_exif(lon, lat))
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "wb") as f:
        f.write(out)
    print(f"{os.path.relpath(OUT, ROOT)}  {len(out)} bytes")
    print(f"  target SP  {TARGET_SP[0]:.1f} E, {TARGET_SP[1]:.1f} N")
    print(f"  EXIF GPS   {lat:.8f}, {lon:.8f}")
    print(f"  taken      {TAKEN}   orientation {ORIENTATION}  {W}x{H}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
