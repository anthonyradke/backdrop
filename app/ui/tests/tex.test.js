"use strict";
const test = require("node:test");
const assert = require("node:assert");
const vm = require("node:vm");
const { load, SCENE } = require("./load.js");

const ctx = load(SCENE);
const WE = ctx.WE;

// A one-mipmap .tex file: header, one image, `data` as the mipmap (LZ4 when `lz4size` is set).
function tex(format, container, data, lz4size = 0) {
  const p = [];
  const magic = (t) => { p.push(...Buffer.from(t.padEnd(8, "\0").slice(0, 8)), 0); };
  const u = (x) => { const b = Buffer.alloc(4); b.writeInt32LE(x); p.push(...b); };
  magic("TEXV0005"); magic("TEXI0001");
  u(format); u(0); u(2); u(2); u(2); u(2); u(0);
  magic(container); u(1);
  if (container >= "TEXB0003") u(-1);
  if (container >= "TEXB0004") u(0);
  u(1); u(2); u(2);
  if (container >= "TEXB0002") { u(lz4size ? 1 : 0); u(lz4size); }
  u(data.length); p.push(...data);
  return Uint8Array.from(p);
}

test("lz4 decodes literals and overlapping matches, and rejects bad input", () => {
  assert.deepStrictEqual([...WE.lz4(Uint8Array.from([0x14, 65, 0x01, 0x00]), 9)], Array(9).fill(65));
  assert.throws(() => WE.lz4(Uint8Array.from([0x10, 65, 0x00, 0x00]), 5));
  assert.throws(() => WE.lz4(Uint8Array.from([0x50, 1, 2, 3, 4, 5]), 3));
});

test("half-float mipmaps upload from any container version", () => {
  const halfFloats = vm.runInContext("halfFloats", ctx);
  for (const c of ["TEXB0001", "TEXB0002", "TEXB0003", "TEXB0004"]) {
    const data = new Uint8Array(16).map((_, i) => i);
    const d = WE.parseTex(tex(WE.TEX_FORMAT.RG16F, c, data)).images[0][0].data;
    const h = halfFloats(d);
    assert.strictEqual(h.length, 8, c);
    assert.strictEqual(h[1], 2 | (3 << 8), c);
  }
});

test("a .tex asking for an impossible LZ4 size is refused before allocating", () => {
  assert.throws(() => WE.parseTex(tex(0, "TEXB0003", [0x14, 65, 1, 0], 2_000_000_000)), /bad mipmap size/);
  assert.throws(() => WE.parseTex(tex(0, "TEXB0003", [0x14, 65, 1, 0], -5)), /bad mipmap size/);
  const ok = WE.parseTex(tex(0, "TEXB0003", [0x14, 65, 1, 0], 9));
  assert.strictEqual(ok.images[0][0].data.length, 9);
});

test("truncated .tex files throw instead of reading past the end", () => {
  const full = tex(0, "TEXB0003", new Uint8Array(16));
  for (let n = 0; n < full.length; n += 7) assert.throws(() => WE.parseTex(full.subarray(0, n)), `cut at ${n}`);
});
