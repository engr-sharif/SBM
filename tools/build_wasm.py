#!/usr/bin/env python3
"""
Build the WASM compute core and write its payload (docs/V21_WASM_SPEC.md §3).

    python tools/build_wasm.py            # release build + datajs/w_kernels.js
    python tools/build_wasm.py --check    # is the committed payload current?

Why a payload and not a .wasm file: this app has to work over file://, where
nothing can be fetched -- see CLAUDE.md's first hard constraint. So the module
ships exactly the way every other datum does, as base64 inside a <script>, and
js/jobs.js hands the BYTES to each worker, which instantiates them. The .wasm
itself is never committed; the payload is.

The payload also carries a hash of the CRATE SOURCE, and test/check.mjs fails
the preflight when the two disagree -- a stale payload is caught before a
browser opens rather than by a golden moving three steps later.

Rust is a build dependency of this file only. The app never needs it, and a
checkout with no toolchain runs the JavaScript kernels.
"""
import base64, hashlib, json, os, shutil, subprocess, sys

ROOT  = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CRATE = os.path.join(ROOT, "wasm", "sbmm-kernels")
OUT   = os.path.join(ROOT, "datajs", "w_kernels.js")
WASM  = os.path.join(CRATE, "target", "wasm32-unknown-unknown", "release", "sbmm_kernels.wasm")
LIMIT = 400 * 1024        # spec §3: it is in the field build, so it stays small


def crate_files():
    """Every file the build reads, sorted -- the hash's definition."""
    out = []
    for base, dirs, files in os.walk(CRATE):
        dirs[:] = [d for d in dirs if d not in ("target", ".git")]
        for f in sorted(files):
            if f.endswith((".rs", ".toml")) or f == "Cargo.lock":
                out.append(os.path.join(base, f))
    return sorted(out)


def src_hash():
    hsh = hashlib.sha256()
    for p in crate_files():
        hsh.update(os.path.relpath(p, CRATE).replace(os.sep, "/").encode())
        hsh.update(b"\0")
        with open(p, "rb") as fh:
            hsh.update(fh.read())
        hsh.update(b"\0")
    return hsh.hexdigest()


def crate_version():
    with open(os.path.join(CRATE, "Cargo.toml"), "r", encoding="utf-8") as fh:
        for line in fh:
            if line.startswith("version"):
                return line.split("=", 1)[1].strip().strip('"')
    return "0.0.0"


def payload_meta():
    """The meta block of the committed payload, or None."""
    if not os.path.exists(OUT):
        return None
    with open(OUT, "r", encoding="utf-8") as fh:
        txt = fh.read()
    key = 'SBMM_DATA["wasm_kernels_meta"]='
    i = txt.find(key)
    if i < 0:
        return None
    j = txt.find(";", i)
    try:
        return json.loads(txt[i + len(key):j])
    except Exception:
        return None


def check():
    meta = payload_meta()
    want = src_hash()
    if meta is None:
        print("datajs/w_kernels.js is missing or unreadable")
        return 1
    if meta.get("src_sha256") != want:
        print("datajs/w_kernels.js is STALE\n  payload %s\n  crate   %s"
              % (meta.get("src_sha256"), want))
        return 1
    print("datajs/w_kernels.js is current (%s, %d bytes of wasm)"
          % (meta.get("src_sha256", "")[:12], meta.get("wasm_bytes", 0)))
    return 0


def build():
    subprocess.check_call(["cargo", "build", "--release",
                           "--target", "wasm32-unknown-unknown", "--offline"],
                          cwd=CRATE)
    with open(WASM, "rb") as fh:
        raw = fh.read()
    # wasm-opt is optional and absent on the build box; when it is there, use it.
    if shutil.which("wasm-opt"):
        tmp = WASM + ".opt"
        subprocess.check_call(["wasm-opt", "-Oz", WASM, "-o", tmp])
        with open(tmp, "rb") as fh:
            raw = fh.read()
        os.remove(tmp)
        print("wasm-opt -Oz applied")
    else:
        print("wasm-opt not on PATH -- shipping the cargo output as built")

    if len(raw) > LIMIT:
        sys.exit("wasm is %d bytes, over the %d-byte field-build budget" % (len(raw), LIMIT))

    meta = {
        "version":     crate_version(),
        "src_sha256":  src_hash(),
        "wasm_sha256": hashlib.sha256(raw).hexdigest(),
        "wasm_bytes":  len(raw),
    }
    b64 = base64.b64encode(raw).decode("ascii")
    with open(OUT, "w", encoding="utf-8", newline="\n") as fh:
        fh.write("window.SBMM_DATA=window.SBMM_DATA||{};")
        fh.write('SBMM_DATA["wasm_kernels_meta"]=%s;' % json.dumps(meta, sort_keys=True))
        fh.write('SBMM_DATA["wasm_kernels"]="%s";\n' % b64)
    print("datajs/w_kernels.js  %d bytes of wasm -> %d bytes of payload  (%s)"
          % (len(raw), os.path.getsize(OUT), meta["src_sha256"][:12]))
    return 0


if __name__ == "__main__":
    sys.exit(check() if "--check" in sys.argv[1:] else build())
