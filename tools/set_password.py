#!/usr/bin/env python3
"""
Change the SBMM Site Explorer password gate.

    python tools/set_password.py "NewPassword"     # set it
    python tools/set_password.py --print "Pw"      # just show the hash, change nothing

The gate (js/gate.js) stores SHA-256(SALT + password) and never the password
itself, so there is nothing to read back out of the app: a forgotten password is
replaced, not recovered.

What this touches:
  js/gate.js        — the HASH constant (the salt is read from the same file)
  docs/HANDOFF.md   — the single documented copy of the plaintext, in a PRIVATE
                      repo. `test/gate.mjs` reads it from there, so the browser
                      harnesses keep working with no further edit.

After running this, rebuild the single file:  python tools/build_dist.py
Anyone who had already unlocked in their browser is asked again, because the
remembered token in localStorage carries the old hash.

It is a DETERRENT, not security — everything the browser needs is in the file.
"""
import argparse
import hashlib
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
GATE = os.path.join(ROOT, "js", "gate.js")
HANDOFF = os.path.join(ROOT, "docs", "HANDOFF.md")

SALT_RE = re.compile(r'(var\s+SALT\s*=\s*")([^"]*)(";)')
HASH_RE = re.compile(r'(var\s+HASH\s*=\s*")([0-9a-fA-F]{64})(";)')
DOC_RE  = re.compile(r'(gate password is `)([^`]+)(`)')


def read(path):
    with open(path, encoding="utf-8") as f:
        return f.read()


def write(path, text):
    with open(path, "w", encoding="utf-8", newline="\n") as f:
        f.write(text)


def main():
    ap = argparse.ArgumentParser(description="set the SBMM Site Explorer gate password")
    ap.add_argument("password", nargs="?", help="the new password (prompted for if omitted)")
    ap.add_argument("--print", dest="only_print", action="store_true",
                    help="print the hash and change nothing")
    args = ap.parse_args()

    src = read(GATE)
    m_salt = SALT_RE.search(src)
    m_hash = HASH_RE.search(src)
    if not m_salt or not m_hash:
        sys.exit("could not find SALT / HASH in js/gate.js — has the file been restructured?")
    salt = m_salt.group(2)

    pw = args.password
    if pw is None:
        import getpass
        pw = getpass.getpass("new password: ")
        if pw != getpass.getpass("again: "):
            sys.exit("the two entries differ — nothing changed")
    if not pw:
        sys.exit("an empty password would let anyone in by pressing Enter — nothing changed")

    digest = hashlib.sha256((salt + pw).encode("utf-8")).hexdigest()
    print(f"salt   {salt!r}")
    print(f"sha256 {digest}")
    if args.only_print:
        print("(--print: nothing written)")
        return

    if digest == m_hash.group(2):
        print("js/gate.js already carries that hash — nothing to change there")
    else:
        src = HASH_RE.sub(lambda m: m.group(1) + digest + m.group(3), src, count=1)
        write(GATE, src)
        print(f"js/gate.js       HASH updated ({m_hash.group(2)[:12]}… -> {digest[:12]}…)")

    if os.path.exists(HANDOFF):
        doc = read(HANDOFF)
        if DOC_RE.search(doc):
            doc = DOC_RE.sub(lambda m: m.group(1) + pw + m.group(3), doc, count=1)
            write(HANDOFF, doc)
            print("docs/HANDOFF.md  documented password updated (private repo — the only copy)")
        else:
            print("docs/HANDOFF.md  WARNING: no ``gate password is `...`'' line found; "
                  "add one or test/gate.mjs cannot find the password")

    print("\nnext:  python tools/build_dist.py     (the dist inlines js/gate.js)")
    print("       everyone's remembered unlock is invalidated by the hash change")


if __name__ == "__main__":
    main()
