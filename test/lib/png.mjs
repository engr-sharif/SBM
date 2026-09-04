/* SBMM Site Explorer — a PNG decoder for exactly what this repo ships.

   Every raster payload in the app is written by tools/build_*.py through Pillow
   as an 8-bit, non-interlaced PNG: colour type 2 (RGB) for the terrain-RGB DEMs,
   the CHM and the four design surfaces. That is a small enough corner of the
   format to decode in fifty lines of node with `zlib.inflateSync` and the five
   filter types, and decoding it here rather than in a browser is what lets
   test/kernels.mjs exercise every compute kernel with no Playwright at all.

   Deliberately NOT a general PNG library: 16-bit, palette, greyscale, interlaced
   (Adam7) and APNG all throw with a message naming what they found. A decoder
   that silently half-handled one of those would produce a terrain grid that
   looks plausible and is wrong, which is the one failure mode a test harness
   must not have.

   Returns { w, h, channels, data } — data is row-major from the TOP of the
   image (PNG row 0), `channels` bytes per pixel. The terrain-RGB convention
   (row 0 = north, v = R*256+G) is applied by test/lib/terrain.mjs, not here. */
import zlib from "node:zlib";

const SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

export function decodePNG(buf) {
  for (let i = 0; i < 8; i++)
    if (buf[i] !== SIG[i]) throw new Error("not a PNG (bad signature)");

  let w = 0, h = 0, depth = 0, color = 0, interlace = 0;
  const idat = [];
  let p = 8;
  while (p + 8 <= buf.length) {
    const len = buf.readUInt32BE(p);
    const type = buf.toString("latin1", p + 4, p + 8);
    const data = buf.subarray(p + 8, p + 8 + len);
    if (type === "IHDR") {
      w = data.readUInt32BE(0); h = data.readUInt32BE(4);
      depth = data[8]; color = data[9];
      if (data[10] !== 0) throw new Error("PNG compression method " + data[10] + " is not deflate");
      if (data[11] !== 0) throw new Error("PNG filter method " + data[11] + " is not the standard set");
      interlace = data[12];
    } else if (type === "IDAT") {
      idat.push(data);
    } else if (type === "IEND") {
      break;
    }
    p += 12 + len;                       // length + type + data + CRC
  }
  if (!w || !h) throw new Error("PNG has no IHDR");
  if (depth !== 8) throw new Error("PNG bit depth " + depth + " unsupported (this repo ships 8-bit)");
  if (interlace !== 0) throw new Error("interlaced PNG unsupported (this repo ships non-interlaced)");
  const channels = color === 2 ? 3 : color === 6 ? 4 : 0;
  if (!channels) throw new Error("PNG colour type " + color + " unsupported (need 2 = RGB or 6 = RGBA)");

  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = w * channels;
  if (raw.length < (stride + 1) * h)
    throw new Error("PNG data is short: " + raw.length + " bytes for " + h + " rows of " + stride);

  /* Unfilter in place into one output buffer. `prev` is the previous OUTPUT row,
     which is what all five filters are defined against (never the filtered row). */
  const out = new Uint8Array(stride * h);
  const bpp = channels;
  for (let y = 0; y < h; y++) {
    const ft = raw[y * (stride + 1)];
    const src = y * (stride + 1) + 1;
    const dst = y * stride;
    const up = dst - stride;
    switch (ft) {
      case 0:
        out.set(raw.subarray(src, src + stride), dst);
        break;
      case 1:                                                   // Sub
        for (let i = 0; i < bpp; i++) out[dst + i] = raw[src + i];
        for (let i = bpp; i < stride; i++) out[dst + i] = (raw[src + i] + out[dst + i - bpp]) & 255;
        break;
      case 2:                                                   // Up
        if (y === 0) out.set(raw.subarray(src, src + stride), dst);
        else for (let i = 0; i < stride; i++) out[dst + i] = (raw[src + i] + out[up + i]) & 255;
        break;
      case 3:                                                   // Average
        for (let i = 0; i < stride; i++) {
          const a = i >= bpp ? out[dst + i - bpp] : 0;
          const b = y > 0 ? out[up + i] : 0;
          out[dst + i] = (raw[src + i] + ((a + b) >> 1)) & 255;
        }
        break;
      case 4:                                                   // Paeth
        for (let i = 0; i < stride; i++) {
          const a = i >= bpp ? out[dst + i - bpp] : 0;
          const b = y > 0 ? out[up + i] : 0;
          const c = (y > 0 && i >= bpp) ? out[up + i - bpp] : 0;
          const q = a + b - c;
          const pa = q > a ? q - a : a - q, pb = q > b ? q - b : b - q, pc = q > c ? q - c : c - q;
          const pr = (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c);
          out[dst + i] = (raw[src + i] + pr) & 255;
        }
        break;
      default:
        throw new Error("unknown PNG filter type " + ft + " on row " + y);
    }
  }
  return { w, h, channels, data: out };
}

export default decodePNG;
