// Puppets: a character sheet cut into a mesh and bent by a skeleton, stored in a .mdl file. Effects
// run on the flat sheet (their masks are painted on it), then the mesh carries the result to the
// screen, so a puppet layer ends in one extra skinned pass.
"use strict";
var WE = window.WE || (window.WE = {});

const STD_HERALD = 0x01800009, ALT_HERALD = 0x0180000f;

class Binary {
  constructor(bytes) {
    this.b = bytes;
    this.v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    this.o = 0;
  }
  u8() { return this.v.getUint8(this.o++); }
  u16() { const x = this.v.getUint16(this.o, true); this.o += 2; return x; }
  u32() { const x = this.v.getUint32(this.o, true); this.o += 4; return x; }
  i32() { const x = this.v.getInt32(this.o, true); this.o += 4; return x; }
  f32() { const x = this.v.getFloat32(this.o, true); this.o += 4; return x; }
  str() {
    const a = this.o;
    while (this.o < this.b.length && this.b[this.o]) this.o++;
    const s = new TextDecoder().decode(this.b.subarray(a, this.o));
    this.o++;
    return s;
  }
}

function parseMesh(r) {
  r.str(); // MDLVxxxx
  if (r.i32() === 9) throw new Error("puppet isn't finished");
  r.i32(); r.i32();
  r.str();
  r.i32();
  let alt = false, size = r.u32();
  if (size === 0) {
    alt = true;
    while (size !== ALT_HERALD) size = r.u32();
    size = r.u32();
  } else if (size === STD_HERALD) size = r.u32();
  // The newer format adds normals and tangents after the position.
  const stride = alt ? 80 : 52;
  if (!size || size % stride) throw new Error(`unknown vertex size ${size}`);
  const count = size / stride;
  const pos = new Float32Array(count * 3), uv = new Float32Array(count * 2), weights = new Float32Array(count * 4), joints = new Uint8Array(count * 4);
  const extra = stride - 52;
  for (let i = 0; i < count; i++) {
    pos[i * 3] = r.f32(); pos[i * 3 + 1] = r.f32(); pos[i * 3 + 2] = r.f32();
    r.o += extra;
    for (let j = 0; j < 4; j++) joints[i * 4 + j] = r.u32();
    for (let j = 0; j < 4; j++) weights[i * 4 + j] = r.f32();
    uv[i * 2] = r.f32(); uv[i * 2 + 1] = r.f32();
  }
  const indexBytes = r.u32();
  const indices = new Uint16Array(indexBytes / 2);
  for (let i = 0; i < indices.length; i++) indices[i] = r.u16();
  return { pos, uv, weights, joints, indices, alt };
}

function parseSkeleton(r, alt) {
  const version = +r.str().slice(4);
  r.u32();
  const count = r.u16();
  r.u16();
  const bones = [];
  for (let i = 0; i < count; i++) {
    r.str();
    r.i32();
    const parent = r.i32();
    if (r.u32() !== 64) throw new Error("unknown bone size");
    const m = [];
    for (let j = 0; j < 16; j++) m.push(r.f32());
    r.str();
    bones.push({ parent: parent >= 0 && parent < i ? parent : -1, local: m });
  }
  if (version > 1) {
    r.u16();
    if (r.u8()) r.o += count * 64;
    const n = r.u32();
    r.o += n * 12;
    r.u32();
    if (r.u8()) r.o += count * 76;
    if (r.u8()) r.o += count * 4;
  }
  return bones;
}

function parseAnimations(r, alt) {
  // Attachments and the odd stray bytes can sit between the skeleton and the animations.
  let version = -1;
  while (r.o < r.b.length) {
    const s = r.str();
    if (s.length !== 8) continue;
    if (s.startsWith("MDAT")) {
      r.u32();
      const n = r.u16();
      for (let i = 0; i < n; i++) { r.u16(); r.str(); r.o += 64; }
    } else if (s.startsWith("MDLA")) { version = +s.slice(4); break; }
  }
  const anims = [];
  if (version <= 0) return anims;
  r.u32();
  const count = r.u32();
  for (let i = 0; i < count; i++) {
    let id = 0;
    while (id === 0) id = r.i32();
    if (id < 0) throw new Error("bad animation id");
    r.i32();
    let name = r.str();
    if (!name) name = r.str();
    const mode = r.str() || "loop";
    const fps = r.f32(), length = r.i32();
    r.i32();
    const bones = [];
    for (let b = 0, n = r.u32(); b < n; b++) {
      r.i32();
      const bytes = r.u32(), frames = [];
      if (bytes % 36) throw new Error("bad bone frames");
      for (let f = 0; f < bytes / 36; f++) {
        const p = [r.f32(), r.f32(), r.f32()], a = [r.f32(), r.f32(), r.f32()], s = [r.f32(), r.f32(), r.f32()];
        frames.push({ p, s, q: euler(a) });
      }
      bones.push(frames);
    }
    anims.push({ id, name, mode, fps, length, bones });
    if (alt) r.o += 2;
    else if (version === 3) r.o += 1;
    else {
      const extra = r.u32();
      for (let e = 0; e < extra; e++) { r.f32(); r.str(); }
    }
  }
  return anims;
}

// Quaternions as [x, y, z, w].
function quatMul(a, b) {
  return [
    a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
    a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
    a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
    a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
  ];
}
const axis = (i, t) => { const q = [0, 0, 0, Math.cos(t / 2)]; q[i] = Math.sin(t / 2); return q; };
function euler([x, y, z]) { return quatMul(axis(2, z), quatMul(axis(1, y), axis(0, x))); }
const conj = (q) => [-q[0], -q[1], -q[2], q[3]];
function slerp(a, b, t) {
  let d = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3], s = 1;
  if (d < 0) { d = -d; s = -1; }
  let k0 = 1 - t, k1 = t * s;
  if (d < 0.9995) {
    const th = Math.acos(d), n = Math.sin(th);
    k0 = Math.sin((1 - t) * th) / n; k1 = (Math.sin(t * th) / n) * s;
  }
  const o = [a[0] * k0 + b[0] * k1, a[1] * k0 + b[1] * k1, a[2] * k0 + b[2] * k1, a[3] * k0 + b[3] * k1];
  const l = Math.hypot(...o) || 1;
  return o.map((v) => v / l);
}

const IDENT = [0, 0, 0, 1];
function compose(p, q, s) {
  const [x, y, z, w] = q;
  const xx = x * x, yy = y * y, zz = z * z, xy = x * y, xz = x * z, yz = y * z, wx = w * x, wy = w * y, wz = w * z;
  return [
    (1 - 2 * (yy + zz)) * s[0], 2 * (xy + wz) * s[0], 2 * (xz - wy) * s[0], 0,
    2 * (xy - wz) * s[1], (1 - 2 * (xx + zz)) * s[1], 2 * (yz + wx) * s[1], 0,
    2 * (xz + wy) * s[2], 2 * (yz - wx) * s[2], (1 - 2 * (xx + yy)) * s[2], 0,
    p[0], p[1], p[2], 1,
  ];
}

class Puppet {
  constructor(scene, mesh, bones, anims, layers, uvScale) {
    this.scene = scene;
    this.bones = bones;
    this.anims = anims;
    const gl = scene.gl, M = WE.M;
    this.count = mesh.indices.length;
    this.vao = gl.createVertexArray();
    gl.bindVertexArray(this.vao);
    const attr = (slot, data, size, int) => {
      gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
      gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
      gl.enableVertexAttribArray(slot);
      if (int) gl.vertexAttribIPointer(slot, size, gl.UNSIGNED_BYTE, 0, 0);
      else gl.vertexAttribPointer(slot, size, gl.FLOAT, false, 0, 0);
    };
    const uv = mesh.uv.slice();
    for (let i = 0; i < uv.length; i += 2) { uv[i] /= uvScale[0]; uv[i + 1] /= uvScale[1]; }
    attr(0, mesh.pos, 3);
    attr(1, uv, 2);
    if (bones.length) {
      attr(WE.ATTRIB.a_BlendIndices, mesh.joints, 4, true);
      attr(WE.ATTRIB.a_BlendWeights, mesh.weights, 4);
    }
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, mesh.indices, gl.STATIC_DRAW);
    gl.bindVertexArray(null);
    // Rest pose: each bone's world transform, inverted, cancels it back out.
    const world = [];
    bones.forEach((b, i) => {
      world[i] = b.parent >= 0 ? M.mul(world[b.parent], b.local) : b.local;
      b.inverse = M.invert(world[i]);
    });
    this.matrices = new Float32Array(bones.length * 12);
    this.layers = this.blendLayers(layers);
  }

  // Each layer's share of the pose, the rest going to the skeleton's rest position.
  blendLayers(layers) {
    const on = (layers || []).filter((l) => l.visible !== false && this.anims.some((a) => a.id === l.animation));
    const total = on.reduce((n, l) => n + (l.blend ?? 1), 0);
    this.rest = 1;
    const out = [];
    for (const l of [...on].reverse()) {
      const anim = this.anims.find((a) => a.id === l.animation), blend = l.blend ?? 1;
      let share;
      if (total > 1) { share = blend / total; this.rest = 0; } else { share = this.rest * blend; this.rest = Math.max(0, this.rest * (1 - blend)); }
      out.unshift({ anim, rate: l.rate ?? 1, blend, share });
    }
    return out;
  }

  pose(time) {
    const M = WE.M, bones = this.bones, world = new Array(bones.length);
    const frames = this.layers.map((l) => {
      const a = l.anim, len = Math.max(1, a.length), span = a.mode === "mirror" ? len * 2 : len;
      const at = ((time * l.rate * a.fps) % span + span) % span;
      let f0 = Math.floor(at) % span, f1 = (f0 + 1) % span;
      if (a.mode === "mirror") {
        const fold = (f) => (f >= len ? len - 1 - (f - len) : f);
        f0 = fold(f0); f1 = fold(f1);
      }
      return { l, f0, f1, t: at - Math.floor(at) };
    });
    for (let i = 0; i < bones.length; i++) {
      const b = bones[i], k = this.rest;
      const p = [b.local[12] * k, b.local[13] * k, b.local[14] * k], s = [k, k, k];
      let q = IDENT;
      for (const { l, f0, f1, t } of frames) {
        const track = l.anim.bones[i];
        if (!track?.length) continue;
        const base = track[0], a = track[Math.min(f0, track.length - 1)], c = track[Math.min(f1, track.length - 1)];
        const inv = conj(base.q);
        const delta = slerp(quatMul(a.q, inv), quatMul(c.q, inv), t);
        q = quatMul(q, quatMul(slerp(delta, IDENT, 1 - l.blend), slerp(base.q, IDENT, 1 - l.share)));
        for (let j = 0; j < 3; j++) {
          p[j] += l.share * base.p[j] + l.blend * ((a.p[j] - base.p[j]) * (1 - t) + (c.p[j] - base.p[j]) * t);
          s[j] += l.share * base.s[j] + l.blend * ((a.s[j] - base.s[j]) * (1 - t) + (c.s[j] - base.s[j]) * t);
        }
      }
      const local = compose(p, slerp(q, IDENT, k), s);
      world[i] = b.parent >= 0 ? M.mul(world[b.parent], local) : local;
    }
    const out = this.matrices;
    for (let i = 0; i < bones.length; i++) {
      const m = M.mul(world[i], bones[i].inverse);
      for (let c = 0; c < 4; c++) for (let r = 0; r < 3; r++) out[i * 12 + c * 3 + r] = m[c * 4 + r];
    }
  }

  draw(scene, pass) {
    const gl = scene.gl, u = pass.program.uniforms.g_Bones;
    if (u) {
      this.pose(scene.time);
      gl.uniformMatrix4x3fv(u.loc, false, this.matrices);
    }
    gl.bindVertexArray(this.vao);
    gl.drawElements(gl.TRIANGLES, this.count, gl.UNSIGNED_SHORT, 0);
    gl.bindVertexArray(scene.quadVao);
  }
}

WE.loadPuppet = async function (scene, path, layers, uvScale) {
  const bytes = await scene.assets.bytes(path);
  if (!bytes) throw new Error("not found");
  const r = new Binary(bytes);
  const mesh = parseMesh(r);
  let bones = [], anims = [];
  try {
    bones = parseSkeleton(r, mesh.alt);
    anims = parseAnimations(r, mesh.alt);
  } catch (e) {
    // The mesh alone still puts the sheet's pieces together; it just won't move.
    scene.warn(`puppet ${path}: ${e.message}`);
    bones = [];
  }
  return new Puppet(scene, mesh, bones, anims, layers, uvScale);
};

WE.parsePuppet = (bytes) => { const r = new Binary(bytes); const mesh = parseMesh(r); const bones = parseSkeleton(r, mesh.alt); return { mesh, bones, anims: parseAnimations(r, mesh.alt) }; };
