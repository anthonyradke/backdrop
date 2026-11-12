// Reads Wallpaper Engine's .tex texture files: an image container holding raw, LZ4-compressed, DXT
// or embedded PNG/JPEG data, plus optional frame tables for animated textures.
"use strict";
var WE = window.WE || (window.WE = {});

WE.TEX_FORMAT = { RGBA8: 0, RGB8: 1, RGB565: 2, DXT5: 4, DXT3: 6, DXT1: 7, RG8: 8, R8: 9, RG16F: 10, R16F: 11, BC7: 12, RGBA1010102: 13, RGBA16F: 14, RGB16F: 15 };
WE.TEX_FLAGS = { NO_INTERPOLATION: 1, CLAMP: 2, GIF: 4 };
// Largest decompressed mipmap accepted (a 8192 x 8192 RGBA image is 256 MB).
const MAX_TEX_BYTES = 256 << 20;

// LZ4 block format, the only compression .tex uses.
WE.lz4 = function (src, size) {
  const out = new Uint8Array(size);
  let s = 0, d = 0;
  while (s < src.length) {
    const token = src[s++];
    let n = token >> 4;
    if (n === 15) { let b; do { b = src[s++]; n += b; } while (b === 255); }
    out.set(src.subarray(s, s + n), d);
    s += n; d += n;
    if (s >= src.length) break;
    const offset = src[s] | (src[s + 1] << 8);
    s += 2;
    let len = token & 15;
    if (len === 15) { let b; do { b = src[s++]; len += b; } while (b === 255); }
    len += 4;
    if (!offset || offset > d || d + len > size) throw new Error("bad LZ4 data");
    // Matches may overlap their own output, so this has to go byte by byte.
    for (let i = 0; i < len; i++, d++) out[d] = out[d - offset];
  }
  return out;
};

function reader(bytes) {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let o = 0;
  return {
    get pos() { return o; },
    u32() { const x = v.getUint32(o, true); o += 4; return x; },
    i32() { const x = v.getInt32(o, true); o += 4; return x; },
    f32() { const x = v.getFloat32(o, true); o += 4; return x; },
    magic() { const s = String.fromCharCode(...bytes.subarray(o, o + 8)); o += 9; return s; },
    cstr() { const a = o; while (o < bytes.length && bytes[o]) o++; o++; return a; },
    bytes(n) {
      if (n < 0 || o + n > bytes.length) throw new Error("tex: truncated");
      const b = bytes.subarray(o, o + n); o += n; return b;
    },
    left() { return bytes.length - o; },
  };
}

WE.parseTex = function (bytes) {
  const r = reader(bytes);
  const m1 = r.magic(), m2 = r.magic();
  if (!m1.startsWith("TEXV") || !m2.startsWith("TEXI")) throw new Error("not a tex file");
  const tex = { format: r.u32(), flags: r.u32(), texWidth: r.u32(), texHeight: r.u32(), width: r.u32(), height: r.u32(), images: [], frames: null, mp4: false, fif: -1 };
  r.u32();
  const container = r.magic();
  const count = r.u32();
  let version = +container.slice(4);
  if (version >= 3) tex.fif = r.i32();
  if (version >= 4) {
    tex.mp4 = r.u32() === 1;
    // Only video keeps the extra per-mipmap fields; everything else is laid out like version 3.
    if (!tex.mp4) version = 3;
  }
  for (let i = 0; i < count; i++) {
    const mips = [], n = r.u32();
    for (let j = 0; j < n; j++) {
      if (version >= 4) { r.u32(); r.u32(); r.cstr(); r.u32(); }
      const w = r.u32(), h = r.u32();
      let lz4 = false, size = 0;
      if (version >= 2) { lz4 = r.u32() === 1; size = r.i32(); }
      const raw = r.bytes(r.i32());
      // LZ4 can't expand data more than about 255 times; a bigger size is a broken file asking
      // for a huge allocation.
      if (lz4 && (size < 0 || size > Math.min(raw.length * 255 + 64, MAX_TEX_BYTES))) throw new Error(`tex: bad mipmap size ${size}`);
      mips.push({ width: w, height: h, data: lz4 ? WE.lz4(raw, size) : raw });
    }
    tex.images.push(mips);
  }
  if (tex.flags & WE.TEX_FLAGS.GIF && r.left() > 9) {
    const magic = r.magic(), v = +magic.slice(4);
    const n = r.u32();
    if (v >= 3) { tex.gifWidth = r.u32(); tex.gifHeight = r.u32(); }
    tex.frames = [];
    const num = v === 1 ? () => r.i32() : () => r.f32();
    for (let i = 0; i < n; i++) {
      tex.frames.push({ image: r.u32(), time: r.f32(), x: num(), y: num(), w: num(), wy: num(), hx: num(), h: num() });
    }
    if (!tex.gifWidth && tex.frames.length) { tex.gifWidth = tex.frames[0].w; tex.gifHeight = tex.frames[0].h; }
  }
  return tex;
};

// Software DXT decoding, for GPUs without the compressed texture extension.
function rgb565(c) {
  return [((c >> 11) & 31) * 255 / 31, ((c >> 5) & 63) * 255 / 63, (c & 31) * 255 / 31];
}
WE.decodeDXT = function (data, w, h, format) {
  const out = new Uint8Array(w * h * 4), F = WE.TEX_FORMAT;
  const block = format === F.DXT1 ? 8 : 16;
  let o = 0;
  for (let by = 0; by < h; by += 4) {
    for (let bx = 0; bx < w; bx += 4, o += block) {
      const c = format === F.DXT1 ? o : o + 8;
      const c0 = data[c] | (data[c + 1] << 8), c1 = data[c + 2] | (data[c + 3] << 8);
      const a = rgb565(c0), b = rgb565(c1);
      const pal = [a, b];
      if (c0 > c1 || format !== F.DXT1) {
        pal.push(a.map((v, i) => (2 * v + b[i]) / 3), a.map((v, i) => (v + 2 * b[i]) / 3));
      } else {
        pal.push(a.map((v, i) => (v + b[i]) / 2), [0, 0, 0]);
      }
      const bits = data[c + 4] | (data[c + 5] << 8) | (data[c + 6] << 16) | (data[c + 7] << 24);
      let alpha = null;
      if (format === F.DXT5) {
        const a0 = data[o], a1 = data[o + 1];
        const t = [a0, a1];
        if (a0 > a1) for (let i = 1; i < 7; i++) t.push(((7 - i) * a0 + i * a1) / 7);
        else { for (let i = 1; i < 5; i++) t.push(((5 - i) * a0 + i * a1) / 5); t.push(0, 255); }
        alpha = (p) => {
          const bit = p * 3, byte = o + 2 + (bit >> 3), shift = bit & 7;
          return t[((data[byte] | (data[byte + 1] << 8)) >> shift) & 7];
        };
      } else if (format === F.DXT3) {
        alpha = (p) => ((data[o + (p >> 1)] >> ((p & 1) * 4)) & 15) * 17;
      }
      for (let y = 0; y < 4 && by + y < h; y++) {
        for (let x = 0; x < 4 && bx + x < w; x++) {
          const p = y * 4 + x, idx = (bits >>> (p * 2)) & 3, px = pal[idx], t = ((by + y) * w + bx + x) * 4;
          out[t] = px[0]; out[t + 1] = px[1]; out[t + 2] = px[2];
          out[t + 3] = alpha ? alpha(p) : format === F.DXT1 && c0 <= c1 && idx === 3 ? 0 : 255;
        }
      }
    }
  }
  return out;
};
