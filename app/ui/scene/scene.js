// Plays Wallpaper Engine scene wallpapers with WebGL2. A scene is a list of objects drawn in order:
// images run through chains of shader effects into layer framebuffers and land on the scene
// framebuffer, alongside particles and text. As in the engine, every framebuffer has the top of the
// picture in its first row, so textures and effects agree, and the final copy to the canvas flips it.
"use strict";
var WE = window.WE || (window.WE = {});

// ---------- files ----------

// Looks a file up in the scene, then in the effects it uses, then in Wallpaper Engine's own assets.
class Assets {
  constructor(base, stock) {
    this.base = base;
    this.stock = stock;
    this.effectRoots = [];
    this.cache = new Map();
  }
  roots() { return [this.base, ...this.effectRoots, this.stock].filter((r) => r != null); }
  addEffectRoot(root) { if (!this.effectRoots.includes(root)) this.effectRoots.push(root); }
  // Effect folders join the search path as they're found, so a miss isn't remembered.
  async find(path) {
    const hit = this.cache.get(path);
    if (hit) return hit;
    const url = (root) => root + path.split("/").map(encodeURIComponent).join("/");
    for (const root of this.roots()) {
      let r = null;
      try { r = await fetch(url(root)); } catch {}
      if (r && r.ok) {
        const buf = await r.arrayBuffer();
        this.cache.set(path, buf);
        return buf;
      }
    }
    return null;
  }
  async bytes(path) { const b = await this.find(path); return b && new Uint8Array(b); }
  async text(path) {
    const b = await this.find(path);
    return b && new TextDecoder().decode(b).replace(/^﻿/, "");
  }
  async json(path) {
    const t = await this.text(path);
    if (t == null) return null;
    try { return JSON.parse(t); } catch { return null; }
  }
  url(root, path) { return root + path.split("/").map(encodeURIComponent).join("/"); }
}

// ---------- math ----------

const M = {
  identity: () => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
  ortho: (l, r, b, t) => [2 / (r - l), 0, 0, 0, 0, 2 / (t - b), 0, 0, 0, 0, -1, 0, -(r + l) / (r - l), -(t + b) / (t - b), 0, 1],
  mul(a, b) {
    const o = new Array(16);
    for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) {
      o[c * 4 + r] = a[r] * b[c * 4] + a[r + 4] * b[c * 4 + 1] + a[r + 8] * b[c * 4 + 2] + a[r + 12] * b[c * 4 + 3];
    }
    return o;
  },
  translate: (x, y, z = 0) => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1],
  rotateZ(a) { const c = Math.cos(a), s = Math.sin(a); return [c, s, 0, 0, -s, c, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]; },
  invert(m) {
    const [a, b, c, d, e, f, g, h, i, j, k, l, n, o, p, q] = m;
    const s0 = a * f - b * e, s1 = a * g - c * e, s2 = a * h - d * e, s3 = b * g - c * f, s4 = b * h - d * f, s5 = c * h - d * g;
    const c5 = k * q - l * p, c4 = j * q - l * o, c3 = j * p - k * o, c2 = i * q - l * n, c1 = i * p - k * n, c0 = i * o - j * n;
    const det = s0 * c5 - s1 * c4 + s2 * c3 + s3 * c2 - s4 * c1 + s5 * c0;
    if (!det) return M.identity();
    const r = 1 / det;
    return [
      (f * c5 - g * c4 + h * c3) * r, (-b * c5 + c * c4 - d * c3) * r, (o * s5 - p * s4 + q * s3) * r, (-j * s5 + k * s4 - l * s3) * r,
      (-e * c5 + g * c2 - h * c1) * r, (a * c5 - c * c2 + d * c1) * r, (-n * s5 + p * s2 - q * s1) * r, (i * s5 - k * s2 + l * s1) * r,
      (e * c4 - f * c2 + h * c0) * r, (-a * c4 + b * c2 - d * c0) * r, (n * s4 - o * s2 + q * s0) * r, (-i * s4 + j * s2 - l * s0) * r,
      (-e * c3 + f * c1 - g * c0) * r, (a * c3 - b * c1 + c * c0) * r, (-n * s3 + o * s1 - p * s0) * r, (i * s3 - j * s1 + k * s0) * r,
    ];
  },
};
WE.M = M;

// ---------- keyframe animation ----------

function bezierAt(k0, k1, frame) {
  const span = k1.frame - k0.frame;
  if (span <= 0) return k1.value;
  const hasCurve = k0.front?.enabled && k1.back?.enabled;
  if (!hasCurve) return k0.value + (k1.value - k0.value) * ((frame - k0.frame) / span);
  const x1 = k0.frame + k0.front.x, y1 = k0.value + k0.front.y, x2 = k1.frame + k1.back.x, y2 = k1.value + k1.back.y;
  const curve = (p0, p1, p2, p3, t) => { const u = 1 - t; return u * u * u * p0 + 3 * u * u * t * p1 + 3 * u * t * t * p2 + t * t * t * p3; };
  let lo = 0, hi = 1;
  for (let i = 0; i < 16; i++) {
    const t = (lo + hi) / 2;
    if (curve(k0.frame, x1, x2, k1.frame, t) < frame) lo = t; else hi = t;
  }
  return curve(k0.value, y1, y2, k1.value, (lo + hi) / 2);
}

function channelAt(keys, frame) {
  if (!keys.length) return 0;
  if (frame <= keys[0].frame) return keys[0].value;
  for (let i = 1; i < keys.length; i++) if (frame <= keys[i].frame) return bezierAt(keys[i - 1], keys[i], frame);
  return keys[keys.length - 1].value;
}

WE.sampleAnimation = function (anim, time) {
  const o = anim.options || {};
  const len = o.length || 1, fps = o.fps || 30;
  let frame = time * fps;
  if (o.mode === "single") frame = Math.min(frame, len);
  else if (o.mode === "mirror") { const c = frame % (len * 2); frame = c > len ? len * 2 - c : c; } else frame %= len;
  const out = [];
  for (const k of ["c0", "c1", "c2", "c3"]) if (anim[k]) out.push(channelAt(anim[k], frame));
  return out;
};

// ---------- GPU helpers ----------

class Target {
  constructor(gl, width, height, float) {
    this.gl = gl;
    this.width = Math.max(1, Math.round(width));
    this.height = Math.max(1, Math.round(height));
    this.tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    if (float) gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA16F, this.width, this.height);
    else gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, this.width, this.height);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    this.fb = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.tex, 0);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
  }
  get texWidth() { return this.width; }
  get texHeight() { return this.height; }
  delete() { this.gl.deleteFramebuffer(this.fb); this.gl.deleteTexture(this.tex); }
}

function solidTexture(gl, rgba) {
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(rgba));
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  return { tex, width: 1, height: 1, texWidth: 1, texHeight: 1, format: 0, flags: 0 };
}

async function uploadTex(scene, parsed, name) {
  const gl = scene.gl, F = WE.TEX_FORMAT;
  const out = { name, tex: null, width: parsed.width, height: parsed.height, texWidth: parsed.texWidth, texHeight: parsed.texHeight, format: parsed.format, flags: parsed.flags, frames: parsed.frames, images: [] };
  const clamp = !!(parsed.flags & WE.TEX_FLAGS.CLAMP), nearest = !!(parsed.flags & WE.TEX_FLAGS.NO_INTERPOLATION);
  const params = (mips) => {
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, nearest ? gl.NEAREST : gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, nearest ? gl.NEAREST : mips > 1 ? gl.LINEAR_MIPMAP_LINEAR : gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, clamp ? gl.CLAMP_TO_EDGE : gl.REPEAT);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, clamp ? gl.CLAMP_TO_EDGE : gl.REPEAT);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAX_LEVEL, Math.max(0, mips - 1));
  };
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  if (parsed.mp4) {
    const blob = new Blob([parsed.images[0][0].data], { type: "video/mp4" });
    const video = document.createElement("video");
    video.src = URL.createObjectURL(blob);
    video.loop = true; video.muted = true; video.playsInline = true;
    out.video = video;
    out.tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, out.tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4));
    params(1);
    video.play().catch(() => {});
    scene.videos.push(out);
    return out;
  }
  for (const mips of parsed.images) {
    const tex = gl.createTexture();
    if (parsed.fif >= 0 && !parsed.mp4) {
      // A whole PNG or JPEG file inside the container. Textures load in parallel, so nothing may
      // stay bound across this await.
      const bmp = await createImageBitmap(new Blob([mips[0].data]), { premultiplyAlpha: "none", colorSpaceConversion: "none" });
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, bmp);
      if (!out.images.length) { out.texWidth = bmp.width; out.texHeight = bmp.height; }
      bmp.close();
      params(1);
    } else {
      gl.bindTexture(gl.TEXTURE_2D, tex);
      mips.forEach((m, level) => uploadLevel(scene, parsed.format, level, m));
      params(uploadableMips(mips));
    }
    out.images.push(tex);
  }
  out.tex = out.images[0];
  return out;
}

function uploadableMips(mips) {
  // A broken chain would leave the texture incomplete (black), so stop at the first gap.
  let n = 1;
  while (n < mips.length && mips[n].width === Math.max(1, mips[n - 1].width >> 1) && mips[n].height === Math.max(1, mips[n - 1].height >> 1)) n++;
  return n;
}

function uploadLevel(scene, format, level, m) {
  const gl = scene.gl, F = WE.TEX_FORMAT, w = m.width, h = m.height, d = m.data;
  const s3 = scene.ext.s3tc, bptc = scene.ext.bptc;
  if (format === F.DXT1 || format === F.DXT3 || format === F.DXT5) {
    if (s3) {
      const internal = format === F.DXT1 ? s3.COMPRESSED_RGBA_S3TC_DXT1_EXT : format === F.DXT3 ? s3.COMPRESSED_RGBA_S3TC_DXT3_EXT : s3.COMPRESSED_RGBA_S3TC_DXT5_EXT;
      gl.compressedTexImage2D(gl.TEXTURE_2D, level, internal, w, h, 0, d);
    } else {
      gl.texImage2D(gl.TEXTURE_2D, level, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, WE.decodeDXT(d, w, h, format));
    }
  } else if (format === F.BC7 && bptc) {
    gl.compressedTexImage2D(gl.TEXTURE_2D, level, bptc.COMPRESSED_RGBA_BPTC_UNORM_EXT, w, h, 0, d);
  } else if (format === F.RG8) {
    gl.texImage2D(gl.TEXTURE_2D, level, gl.RG8, w, h, 0, gl.RG, gl.UNSIGNED_BYTE, d);
  } else if (format === F.R8) {
    gl.texImage2D(gl.TEXTURE_2D, level, gl.R8, w, h, 0, gl.RED, gl.UNSIGNED_BYTE, d);
  } else if (format === F.R16F) {
    gl.texImage2D(gl.TEXTURE_2D, level, gl.R16F, w, h, 0, gl.RED, gl.HALF_FLOAT, new Uint16Array(d.buffer, d.byteOffset, d.length >> 1));
  } else if (format === F.RG16F) {
    gl.texImage2D(gl.TEXTURE_2D, level, gl.RG16F, w, h, 0, gl.RG, gl.HALF_FLOAT, new Uint16Array(d.buffer, d.byteOffset, d.length >> 1));
  } else if (format === F.RGBA16F) {
    gl.texImage2D(gl.TEXTURE_2D, level, gl.RGBA16F, w, h, 0, gl.RGBA, gl.HALF_FLOAT, new Uint16Array(d.buffer, d.byteOffset, d.length >> 1));
  } else {
    gl.texImage2D(gl.TEXTURE_2D, level, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, d);
  }
}

function setUniform(gl, u, v) {
  const n = Array.isArray(v) ? v : [v];
  switch (u.type) {
    case gl.FLOAT: u.size > 1 ? gl.uniform1fv(u.loc, n) : gl.uniform1f(u.loc, n[0] ?? 0); break;
    case gl.FLOAT_VEC2: gl.uniform2fv(u.loc, fill(n, 2 * u.size)); break;
    case gl.FLOAT_VEC3: gl.uniform3fv(u.loc, fill(n, 3 * u.size)); break;
    case gl.FLOAT_VEC4: gl.uniform4fv(u.loc, fill(n, 4 * u.size)); break;
    case gl.INT: case gl.BOOL: gl.uniform1i(u.loc, n[0] ?? 0); break;
    case gl.FLOAT_MAT4: gl.uniformMatrix4fv(u.loc, false, fill(n, 16 * u.size)); break;
    case gl.FLOAT_MAT3: gl.uniformMatrix3fv(u.loc, false, fill(n, 9 * u.size)); break;
    case gl.FLOAT_MAT4x3: gl.uniformMatrix4x3fv(u.loc, false, fill(n, 12 * u.size)); break;
  }
}

function fill(v, n) {
  if (v.length === n) return v;
  const o = new Float32Array(n);
  for (let i = 0; i < n; i++) o[i] = v[i] ?? (v.length === 1 ? v[0] : 0);
  return o;
}

// ---------- layers ----------

// Passes share these names with the shaders' `g_` uniforms that aren't set per material.
function sharedUniforms(scene) {
  return {
    g_Time: scene.time,
    g_Frametime: scene.dt,
    g_Daytime: scene.daytime,
    g_Screen: [scene.width, scene.height, scene.width / scene.height],
    g_PointerPosition: scene.pointer,
    g_PointerPositionLast: scene.pointerLast,
    g_ParallaxPosition: scene.parallax,
    g_TexelSize: [1 / scene.width, 1 / scene.height],
    g_TexelSizeHalf: [0.5 / scene.width, 0.5 / scene.height],
    g_LightAmbientColor: scene.ambient,
    g_LightSkylightColor: scene.skylight,
    g_EyePosition: [0, 0, 1],
    g_ViewUp: [0, 1, 0],
    g_ViewRight: [1, 0, 0],
    g_OrientationUp: [0, 1, 0],
    g_OrientationRight: [1, 0, 0],
    g_OrientationForward: [0, 0, 1],
    g_NormalModelMatrix: [1, 0, 0, 0, 1, 0, 0, 0, 1],
    g_EffectTextureProjectionMatrix: scene.identity,
    g_EffectTextureProjectionMatrixInverse: scene.identity,
    g_TextureReductionScale: 1,
    g_AudioSpectrum16Left: scene.audio16, g_AudioSpectrum16Right: scene.audio16,
    g_AudioSpectrum32Left: scene.audio32, g_AudioSpectrum32Right: scene.audio32,
    g_AudioSpectrum64Left: scene.audio64, g_AudioSpectrum64Right: scene.audio64,
  };
}

// What a blend-mode name means on the GPU. The separate alpha factors match the engine's.
function applyBlend(gl, mode) {
  gl.enable(gl.BLEND);
  if (mode === "translucent") gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
  else if (mode === "additive") gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE, gl.SRC_ALPHA, gl.ONE);
  else gl.blendFuncSeparate(gl.ONE, gl.ZERO, gl.ONE, gl.ZERO);
}

class Layer {
  constructor(scene, data) {
    this.scene = scene;
    this.data = data;
    this.id = data.id;
    this.name = data.name || "";
    this.parent = null;
    const v = (k, d) => scene.prop(this, k, data[k], d);
    this.origin = v("origin", [0, 0, 0]);
    this.scale = v("scale", [1, 1, 1]);
    this.angles = v("angles", [0, 0, 0]);
    this.visible = scene.bool(this, "visible", data.visible, true);
    this.alpha = v("alpha", [1]);
    this.color = v("color", [1, 1, 1]);
    this.brightness = v("brightness", [1]);
    this.parallaxDepth = v("parallaxDepth", [0, 0]);
    this.size = WE.parseVec(scene.value(data.size) ?? [0, 0]);
    this.alignment = data.alignment || "center";
    this.blendMode = +(scene.value(data.colorBlendMode) ?? 0);
  }
  // Applies the parent chain the way the engine does: rotation and scale carry into the children.
  world() {
    const chain = [];
    for (let o = this, n = 0; o && n < 32; o = o.parent, n++) chain.unshift(o);
    let r = { origin: chain[0].origin.slice(0, 3), scale: chain[0].scale.slice(0, 3), angle: chain[0].angles[2] || 0 };
    for (let i = 1; i < chain.length; i++) {
      const c = chain[i], px = (c.origin[0] || 0) * r.scale[0], py = (c.origin[1] || 0) * r.scale[1];
      const cos = Math.cos(r.angle), sin = Math.sin(r.angle);
      r = {
        origin: [r.origin[0] + px * cos - py * sin, r.origin[1] + px * sin + py * cos, r.origin[2] + (c.origin[2] || 0) * r.scale[2]],
        scale: [c.scale[0] * r.scale[0], c.scale[1] * r.scale[1], c.scale[2] * r.scale[2]],
        angle: (c.angles[2] || 0) + r.angle,
      };
    }
    return r;
  }
  shown() {
    for (let o = this, n = 0; o && n < 32; o = o.parent, n++) if (!o.visible[0]) return false;
    return true;
  }
  render() {}
}

// One shader pass. Texture slots hold names until the frame resolves them, because framebuffers
// change hands as the chain runs.
class Pass {
  constructor(layer, spec) {
    Object.assign(this, spec);
    this.layer = layer;
  }
}

class ImageLayer extends Layer {
  async init() {
    const s = this.scene, d = this.data;
    this.model = d.image ? await s.assets.json(d.image) : {};
    if (!this.model) throw new Error(`model ${d.image} not found`);
    const material = await this.material();
    if (!material) throw new Error(`no material for ${this.name}`);
    await this.buildBase(material);
    this.fit();
    await this.buildEffects();
    if (this.blendMode > 0) await this.buildColorBlend();
    if (this.model.puppet) await this.buildPuppet(material.passes[0]);
  }
  // The flat sheet goes through the effects as usual, then this pass draws the result on the mesh.
  async buildPuppet(pass) {
    const s = this.scene;
    try {
      this.puppet = await WE.loadPuppet(s, this.model.puppet, this.data.animationlayers, this.uvMax);
      const n = this.puppet.bones.length;
      const combos = n ? { SKINNING: 1, BONECOUNT: n } : {};
      this.skin = await s.makePass(this, { ...pass, textures: [] }, { combos }, null, null, null);
    } catch (e) {
      this.puppet = this.skin = null;
      s.warn(`puppet on "${this.name}": ${e.message}`);
    }
  }
  async material() { return this.model.material ? this.scene.assets.json(this.model.material) : null; }
  async buildBase(material) {
    const s = this.scene;
    this.passes = [];
    const first = material.passes[0];
    this.texture = await this.baseTexture(first);
    this.base = await s.makePass(this, first, null, null, null, this.texture);
    this.blending = first.blending || "normal";
  }
  async baseTexture(pass) {
    const name = pass.textures?.[0];
    if (!name) return null;
    return this.scene.texture(name);
  }
  fit() {
    const s = this.scene, m = this.model;
    let [w, h] = this.size;
    const t = this.texture;
    if ((!w || !h) && m.solidlayer) { w = s.width; h = s.height; }
    if ((!w || !h) && t) { w = t.frames ? t.gifWidth : t.width; h = t.frames ? t.gifHeight : t.height; }
    if ((!w || !h) && m.width) { w = m.width; h = m.height; }
    if (!w || !h) { w = s.width; h = s.height; }
    if (m.fullscreen) { w = s.width; h = s.height; this.fullscreen = true; }
    this.resize(w, h);
    if (t && !t.frames) {
      this.uvMax = [t.width / t.texWidth || 1, t.height / t.texHeight || 1];
    } else this.uvMax = [1, 1];
  }
  resize(w, h) {
    const s = this.scene;
    this.a?.delete(); this.b?.delete();
    this.w = w; this.h = h;
    this.a = new Target(s.gl, w, h, s.hdr);
    this.b = new Target(s.gl, w, h, s.hdr);
    s.targets.set(`_rt_imageLayerComposite_${this.id}_a`, this.a);
    s.targets.set(`_rt_imageLayerComposite_${this.id}_b`, this.b);
    this.ortho = M.ortho(0, w, 0, h);
  }
  async buildEffects() {
    const s = this.scene;
    this.effects = [];
    for (const e of this.data.effects || []) {
      const visible = s.bool(this, null, e.visible, true);
      if (!visible[0] && typeof e.visible !== "object") continue;
      try {
        this.effects.push({ visible, passes: await s.makeEffect(this, e) });
      } catch (err) {
        // A broken effect just goes missing; the layer still draws.
        s.warn(`effect ${e.file} on "${this.name}": ${err.message}`);
      }
    }
  }
  async buildColorBlend() {
    const s = this.scene;
    const mat = await s.assets.json("materials/util/effectpassthrough.json");
    if (!mat) return;
    try {
      this.colorBlend = await s.makePass(this, mat.passes[0], { combos: { BLENDMODE: this.blendMode } }, null, null, null);
    } catch (e) { s.warn(`blend on "${this.name}": ${e.message}`); }
  }
  // The quad in scene space, with y flipped so the top of the scene lands in row 0.
  rect(w) {
    const s = this.scene, sw = w.scale[0] * this.w, sh = w.scale[1] * this.h;
    let [x, y] = w.origin;
    if (this.fullscreen) { x = s.width / 2; y = s.height / 2; }
    let top = y + sh / 2, bottom = y - sh / 2, left = x - sw / 2, right = x + sw / 2;
    const al = this.alignment;
    if (al.includes("top")) { top -= sh / 2; bottom -= sh / 2; } else if (al.includes("bottom")) { top += sh / 2; bottom += sh / 2; }
    if (al.includes("left")) { left += sw / 2; right += sw / 2; } else if (al.includes("right")) { left -= sw / 2; right -= sw / 2; }
    return { x0: left - s.width / 2, x1: right - s.width / 2, y0: s.height / 2 - top, y1: s.height / 2 - bottom };
  }
  screenMatrix(w, r) {
    const s = this.scene;
    let m = s.projection;
    if (w.angle) {
      const cx = (r.x0 + r.x1) / 2, cy = (r.y0 + r.y1) / 2;
      m = M.mul(m, M.mul(M.translate(cx, cy), M.mul(M.rotateZ(-w.angle), M.translate(-cx, -cy))));
    }
    if (s.parallaxOn) {
      const px = (this.parallaxDepth[0] + s.parallaxAmount) * s.parallax[0] * s.width;
      const py = (this.parallaxDepth[1] + s.parallaxAmount) * s.parallax[1] * s.width;
      m = M.mul(m, M.translate(px, py));
    }
    return m;
  }
  beforeRender() {}
  render() {
    if (!this.shown()) return;
    const s = this.scene, gl = s.gl;
    this.beforeRender();
    const w = this.world(), r = this.rect(w);
    const screen = this.screenMatrix(w, r);
    const chain = [this.base];
    for (const e of this.effects) if (e.visible[0]) chain.push(...e.passes);
    if (this.skin) chain.push(this.skin);
    if (this.colorBlend) chain.push(this.colorBlend);
    if (this.model.passthrough && chain.length === 1) return;
    const passthrough = !!this.model.passthrough;
    let drawTo = this.b, main = this.a;
    let drawing = this.a; // the first draw lands in A, then they alternate
    let input = this.texture;
    let effectInput = null, inTarget = false;
    const quad = (x0, y0, x1, y1, u1, v1) => s.quad(x0, y0, x1, y1, u1, v1);
    for (let i = 0; i < chain.length; i++) {
      const p = chain[i], first = i === 0, last = i === chain.length - 1;
      const target = p.target ? p.fbos?.get(p.target) ?? s.namedTarget(p.target) : null;
      const toScene = last && !target;
      const dest = target || (toScene ? s.sceneTarget : drawing);
      let mvp;
      if (p === this.skin && toScene) {
        const cx = (r.x0 + r.x1) / 2, cy = (r.y0 + r.y1) / 2;
        mvp = M.mul(M.mul(screen, M.translate(cx, cy)), [w.scale[0], 0, 0, 0, 0, -w.scale[1], 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
      } else if (toScene) {
        mvp = screen;
        if (first) quad(r.x0, r.y0, r.x1, r.y1, this.uvMax[0], this.uvMax[1]);
        else quad(r.x0, r.y0, r.x1, r.y1, 1, 1);
      } else if (first) {
        if (passthrough) {
          mvp = screen;
          if (this.fullscreen) quad(-1, -1, 1, 1, 1, 1); else quad(r.x0, r.y0, r.x1, r.y1, 1, 1);
        } else {
          mvp = this.ortho;
          quad(0, 0, this.w, this.h, this.uvMax[0], this.uvMax[1], true);
        }
      } else {
        mvp = s.identity;
        quad(-1, -1, 1, 1, 1, 1);
      }
      const blend = chain.length === 1 ? this.blending : toScene ? this.blending : "normal";
      gl.colorMask(true, true, true, !toScene);
      const geometry = p === this.skin ? this.puppet : null;
      s.drawPass(p, dest, input, inTarget ? effectInput : null, { mvp, blend, layer: this, geometry });
      if (target) {
        if (!inTarget) { effectInput = input; inTarget = true; }
        input = dest;
      } else {
        input = dest;
        inTarget = false; effectInput = null;
        drawing = drawing === this.a ? this.b : this.a;
      }
    }
    gl.colorMask(true, true, true, true);
  }
}

class GroupLayer extends Layer {
  async init() {}
}

WE.LayerBase = Layer;
WE.ImageLayerBase = ImageLayer;

// ---------- the scene ----------

WE.Scene = class {
  constructor(canvas, opts) {
    this.canvas = canvas;
    this.opts = opts;
    this.warnings = [];
    this.warn = (m) => { this.warnings.push(m); opts.log?.(m); };
    const warned = new Set();
    this.warnOnce = (m) => { if (!warned.has(m)) { warned.add(m); this.warn(m); } };
    this.assets = new Assets(opts.base, opts.stock);
    this.layers = [];
    this.byId = new Map();
    this.order = [];
    this.targets = new Map();
    this.textures = new Map();
    this.programs = new Map();
    this.videos = [];
    this.sounds = [];
    this.identity = M.identity();
    this.time = 0; this.dt = 0; this.daytime = 0;
    this.pointer = [0.5, 0.5]; this.pointerLast = [0.5, 0.5]; this.pointerTarget = [0.5, 0.5];
    this.parallax = [0, 0];
    this.audio16 = new Float32Array(16); this.audio32 = new Float32Array(32); this.audio64 = new Float32Array(64);
    this.drivers = [];
    this.paused = false;
    this.running = false;
    this.fps = 30;
  }

  async load() {
    const a = this.assets, gl = this.canvas.getContext("webgl2", { alpha: false, antialias: false, depth: false, stencil: false, preserveDrawingBuffer: !!this.opts.keepBuffer, powerPreference: "low-power" });
    if (!gl) throw new Error("WebGL2 isn't available");
    this.gl = gl;
    this.ext = {
      s3tc: gl.getExtension("WEBGL_compressed_texture_s3tc"),
      bptc: gl.getExtension("EXT_texture_compression_bptc"),
      float: gl.getExtension("EXT_color_buffer_float"),
      hfloatLinear: gl.getExtension("OES_texture_float_linear"),
    };
    this.project = (await a.json("project.json")) || {};
    this.userProps = this.project.general?.properties || {};
    for (const [k, v] of Object.entries(this.opts.properties || {})) if (this.userProps[k]) this.userProps[k].value = v;
    const file = this.project.file || "scene.json";
    const data = await a.json(file);
    if (!data) throw new Error(`${file} not found`);
    this.data = data;
    const g = data.general || {};
    this.general = g;
    const proj = g.orthogonalprojection;
    if (proj && !proj.auto && proj.width) { this.width = proj.width; this.height = proj.height; }
    else {
      // Auto projection: the extent of the images. 3D scenes with a perspective camera land here too.
      let mx = 0, my = 0;
      for (const o of data.objects || []) {
        if (!o.image) continue;
        const or = WE.parseVec(this.value(o.origin) ?? "0 0 0"), sz = WE.parseVec(this.value(o.size) ?? "0 0");
        mx = Math.max(mx, Math.abs(or[0]) + sz[0] / 2); my = Math.max(my, Math.abs(or[1]) + sz[1] / 2);
      }
      this.width = mx ? mx * 2 : 1920; this.height = my ? my * 2 : 1080;
    }
    this.hdr = !!this.value(g.hdr) && !!this.ext.float;
    this.canvas.width = this.width;
    this.canvas.height = this.height;
    this.clearColor = WE.parseVec(this.value(g.clearcolor) ?? "0 0 0");
    this.clearEnabled = this.value(g.clearenabled) !== false;
    this.ambient = WE.parseVec(this.value(g.ambientcolor) ?? "0.3 0.3 0.3");
    this.skylight = WE.parseVec(this.value(g.skylightcolor) ?? "0 0 0");
    this.parallaxOn = !!this.value(g.cameraparallax);
    this.parallaxAmount = +(this.value(g.cameraparallaxamount) ?? 0);
    this.parallaxDelay = +(this.value(g.cameraparallaxdelay) ?? 0.1);
    this.parallaxInfluence = +(this.value(g.cameraparallaxmouseinfluence) ?? 0.5);
    this.projection = M.ortho(-this.width / 2, this.width / 2, -this.height / 2, this.height / 2);

    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.CULL_FACE);
    this.quadVao = gl.createVertexArray();
    this.quadBuf = gl.createBuffer();
    gl.bindVertexArray(this.quadVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuf);
    gl.bufferData(gl.ARRAY_BUFFER, 20 * 6 * 4, gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 20, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 2, gl.FLOAT, false, 20, 12);
    this.quadData = new Float32Array(30);

    this.sceneTarget = new Target(gl, this.width, this.height, this.hdr);
    this.snapshot = new Target(gl, this.width, this.height, this.hdr);
    this.white = solidTexture(gl, [255, 255, 255, 255]);
    this.black = solidTexture(gl, [0, 0, 0, 0]);
    this.normal = solidTexture(gl, [128, 128, 255, 255]);

    const objs = data.objects || [];
    const made = await Promise.all(objs.map((o) => this.makeLayer(o)));
    made.forEach((l, i) => { if (l) { this.layers.push(l); this.byId.set(objs[i].id, l); } });
    for (const l of this.layers) if (l.data.parent != null) l.parent = this.byId.get(l.data.parent) || null;
    this.buildOrder(objs);
    await this.setupBloom();
    await WE.startScripts?.(this);
    if (!this.layers.some((l) => l.base || l.draws)) throw new Error("nothing in this scene could be drawn");
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return this;
  }

  buildOrder(objs) {
    const seen = new Set();
    const add = (o) => {
      if (seen.has(o.id)) return;
      seen.add(o.id);
      for (const d of o.dependencies || []) if (d !== o.id) { const x = objs.find((p) => p.id === d); if (x) add(x); }
      const l = this.byId.get(o.id);
      if (l) this.order.push(l);
    };
    objs.forEach(add);
  }

  async makeLayer(o) {
    try {
      let layer;
      if (o.image) layer = new ImageLayer(this, o);
      else if (o.text && WE.TextLayer) layer = new WE.TextLayer(this, o);
      else if (o.particle && WE.ParticleLayer) layer = new WE.ParticleLayer(this, o);
      else if (o.sound && WE.SoundLayer) layer = new WE.SoundLayer(this, o);
      else layer = new GroupLayer(this, o);
      await layer.init();
      return layer;
    } catch (e) {
      this.warn(`object "${o.name}": ${e.message}`);
      // Children still need their parent's transform.
      return new GroupLayer(this, o);
    }
  }

  // ---------- property values ----------

  // A scene.json value without its wrapping: { value, user, script, animation } or a plain value.
  value(v) {
    if (v && typeof v === "object" && !Array.isArray(v)) {
      if (v.user != null) {
        const name = typeof v.user === "string" ? v.user : v.user.name;
        const p = this.userProps[name];
        if (p && p.value !== undefined) {
          if (typeof v.user === "object" && v.user.condition !== undefined) return String(p.value) === String(v.user.condition);
          return p.value;
        }
      }
      return "value" in v ? v.value : undefined;
    }
    return v;
  }
  // Numbers-and-vectors value that keeps updating when it's animated or scripted.
  prop(owner, key, v, def) {
    const val = this.value(v);
    const out = val === undefined || val === null ? def.slice() : WE.parseVec(val);
    if (v && typeof v === "object" && !Array.isArray(v)) this.drive(owner, key, v, out);
    return out;
  }
  bool(owner, key, v, def) {
    const val = this.value(v);
    const out = [val === undefined || val === null ? def : !!val];
    if (v && typeof v === "object") this.drive(owner, key, v, out);
    return out;
  }
  drive(owner, key, v, out) {
    if (v.animation && !v.animation.options?.startpaused) this.drivers.push({ kind: "anim", anim: v.animation, out });
    if (v.script && WE.addScript) WE.addScript(this, owner, key, v, out);
  }

  // ---------- resources ----------

  async texture(name) {
    if (this.textures.has(name)) return this.textures.get(name);
    const p = (async () => {
      if (name.startsWith("_rt_") || name.startsWith("_alias_")) return { rt: name };
      // $mediaThumbnail and friends come from the music player integration, which isn't here.
      if (name.startsWith("$")) return this.black;
      const path = name.endsWith(".tex") ? name : `materials/${name}.tex`;
      const bytes = await this.assets.bytes(path);
      if (!bytes) { this.warn(`texture ${name} not found`); return this.white; }
      try {
        return await uploadTex(this, WE.parseTex(bytes), name);
      } catch (e) {
        this.warn(`texture ${name}: ${e.message}`);
        return this.white;
      }
    })();
    this.textures.set(name, p);
    return p;
  }

  namedTarget(name) {
    if (this.targets.has(name)) return this.targets.get(name);
    // Render targets scenes refer to by name without an effect declaring them.
    const m = name.match(/_rt_(Full|Half|Quarter|Eighth)/i);
    const div = m ? { full: 1, half: 2, quarter: 4, eighth: 8 }[m[1].toLowerCase()] : 1;
    const t = new Target(this.gl, this.width / div, this.height / div, this.hdr);
    this.targets.set(name, t);
    return t;
  }

  async program(source, combos) {
    const key = source.name + JSON.stringify(Object.entries(combos).sort());
    if (!this.programs.has(key)) this.programs.set(key, WE.buildProgram(this.gl, source, combos));
    return this.programs.get(key);
  }

  // Builds a runnable pass from a material pass and whatever an effect overrides on it.
  async makePass(layer, mat, override, binds, target, tex0, fbos) {
    const a = this.assets;
    const shader = override?.shader || mat.shader;
    const source = await WE.loadShaderSource(a, shader);
    const names = {};
    const meta = source.meta.uniforms;
    for (const u of Object.values(meta)) {
      const slot = u.name.match(/^g_Texture(\d+)$/);
      if (slot && typeof u.meta.default === "string" && u.meta.default) names[+slot[1]] = u.meta.default;
    }
    const given = {};
    const take = (list) => (list || []).forEach((t, i) => {
      const n = t && typeof t === "object" ? t.name : t;
      if (n) { names[i] = n; given[i] = true; }
    });
    take(mat.textures); take(mat.usertextures); take(override?.textures); take(override?.usertextures);
    const textures = {};
    const combos = { ...(mat.combos || {}), ...(override?.combos || {}) };
    await Promise.all(Object.entries(names).map(async ([i, n]) => { textures[i] = await this.texture(n); }));
    if (tex0 && tex0 !== true) textures[0] = tex0;
    const set = {};
    for (const [k, v] of Object.entries(combos)) set[k] = v;
    for (const [i, t] of Object.entries(textures)) {
      if (t.format === WE.TEX_FORMAT.R8 || t.format === WE.TEX_FORMAT.RG8) set[`TEX${i}FORMAT`] = t.format;
    }
    if (tex0?.frames) set.SPRITESHEET = 1;
    const resolved = WE.resolveCombos(source.meta, set, given);
    if (layer.puppet !== undefined || layer.model?.puppet) { /* skinning is switched on by the puppet code */ }
    const program = await this.program(source, resolved);
    const constants = [];
    const lower = (o) => Object.fromEntries(Object.entries(o || {}).map(([k, v]) => [k.toLowerCase(), v]));
    const fromMat = lower(mat.constantshadervalues), fromOv = lower(override?.constantshadervalues);
    for (const u of Object.values(meta)) {
      const key = u.meta.material?.toLowerCase();
      if (!key || !program.uniforms[u.name]) continue;
      const raw = key in fromOv ? fromOv[key] : key in fromMat ? fromMat[key] : u.meta.default;
      if (raw === undefined) continue;
      constants.push({ name: u.name, value: this.prop(layer, null, raw, [0]) });
    }
    return new Pass(layer, { program, shader, blending: mat.blending || "normal", textures, binds: binds || null, target: target || null, constants, fbos });
  }

  // Effects are JSON pointing at materials pointing at shaders, with per-pass overrides in the scene.
  async makeEffect(layer, e) {
    const a = this.assets;
    const root = e.file.match(/^(effects\/[^/]+\/)/);
    if (root && this.opts.stock != null) a.addEffectRoot(this.opts.stock + root[1]);
    const effect = await a.json(e.file);
    if (!effect) throw new Error("not found");
    const fbos = new Map();
    for (const f of effect.fbos || []) {
      const scale = f.scale || 1;
      fbos.set(f.name, new Target(this.gl, layer.w / scale, layer.h / scale, this.hdr));
    }
    const passes = [];
    let ov = 0;
    const overrides = e.passes || [];
    for (const p of effect.passes || []) {
      if (p.command) {
        if (p.command !== "copy") continue;
        const source = await WE.loadShaderSource(a, "commands/copy").catch(() => null);
        const binds = { 0: p.source };
        const mat = { shader: source ? "commands/copy" : "passthrough", blending: "normal" };
        passes.push(await this.makePass(layer, mat, null, binds, p.target, null, fbos));
        continue;
      }
      const mat = await a.json(p.material);
      if (!mat) throw new Error(`material ${p.material} not found`);
      for (const mp of mat.passes) {
        const over = overrides[ov++] || null;
        const binds = {};
        for (const b of p.bind || []) binds[b.index] = b.name;
        passes.push(await this.makePass(layer, mp, over, binds, p.target, null, fbos));
      }
    }
    return passes;
  }

  // ---------- drawing ----------

  // Top-left, bottom-right, with texture v running down the picture as the corners go.
  quad(x0, y0, x1, y1, u1 = 1, v1 = 1) {
    const d = this.quadData, gl = this.gl;
    d[0] = x0; d[1] = y1; d[2] = 0; d[3] = 0; d[4] = v1;
    d[5] = x0; d[6] = y0; d[7] = 0; d[8] = 0; d[9] = 0;
    d[10] = x1; d[11] = y1; d[12] = 0; d[13] = u1; d[14] = v1;
    d[15] = x1; d[16] = y1; d[17] = 0; d[18] = u1; d[19] = v1;
    d[20] = x0; d[21] = y0; d[22] = 0; d[23] = 0; d[24] = 0;
    d[25] = x1; d[26] = y0; d[27] = 0; d[28] = u1; d[29] = 0;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuf);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, d);
  }

  // Scene framebuffer contents for shaders that sample what's behind them. Reading the framebuffer
  // being drawn to isn't allowed, so they get a copy.
  sceneCopy() {
    const gl = this.gl;
    if (this.snapshotFrame === this.frame && this.snapshotDraws === this.draws) return this.snapshot;
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, this.sceneTarget.fb);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, this.snapshot.fb);
    gl.blitFramebuffer(0, 0, this.width, this.height, 0, 0, this.width, this.height, gl.COLOR_BUFFER_BIT, gl.NEAREST);
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
    this.snapshotFrame = this.frame; this.snapshotDraws = this.draws;
    return this.snapshot;
  }

  resolveSlot(p, ref, dest) {
    if (ref?.rt) {
      const name = ref.rt;
      if (name === "_rt_FullFrameBuffer" || name === "_rt_MipMappedFrameBuffer") return this.sceneCopy();
      const t = p.fbos?.get(name) ?? this.namedTarget(name);
      return t;
    }
    return ref;
  }

  drawPass(p, dest, input, previous, o) {
    const gl = this.gl, prog = p.program, u = prog.uniforms;
    // Sampling the destination would be a feedback loop, so copies are made before binding it.
    const bound = [];
    const slots = { ...p.textures };
    if (input) slots[0] = input;
    if (p.binds) {
      for (const [i, name] of Object.entries(p.binds)) {
        if (name === "previous") slots[i] = previous || input;
        else slots[i] = { rt: name };
      }
    }
    let t0 = null;
    for (const [i, ref] of Object.entries(slots)) {
      let t = this.resolveSlot(p, ref, dest);
      if (t === dest) t = this.black;
      if (+i === 0) t0 = t;
      bound.push([+i, t]);
    }
    if (dest === this.sceneTarget && !o.noCount) this.draws = (this.draws || 0) + 1;

    gl.bindFramebuffer(gl.FRAMEBUFFER, dest.fb);
    gl.viewport(0, 0, dest.width, dest.height);
    gl.useProgram(prog.prog);
    applyBlend(gl, o.blend);
    for (const [i, t] of bound) {
      gl.activeTexture(gl.TEXTURE0 + i);
      gl.bindTexture(gl.TEXTURE_2D, t.tex);
      const name = `g_Texture${i}`;
      if (u[name]) gl.uniform1i(u[name].loc, i);
      const res = u[`${name}Resolution`];
      if (res) gl.uniform4f(res.loc, t.texWidth, t.texHeight, t.width, t.height);
    }
    // Any declared sampler nothing was given to reads as opaque white, not as a stale texture.
    for (let i = 0; i < 8; i++) {
      const name = `g_Texture${i}`;
      if (u[name] && !bound.some(([b]) => b === i)) {
        gl.activeTexture(gl.TEXTURE0 + i);
        gl.bindTexture(gl.TEXTURE_2D, this.white.tex);
        gl.uniform1i(u[name].loc, i);
      }
    }
    gl.activeTexture(gl.TEXTURE0);
    const frame = this.frameUniforms;
    for (const k in frame) if (u[k]) setUniform(gl, u[k], frame[k]);
    const l = o.layer;
    const set = (k, v) => { if (u[k]) setUniform(gl, u[k], v); };
    set("g_ModelViewProjectionMatrix", o.mvp);
    set("g_EffectModelViewProjectionMatrix", o.mvp);
    if (u.g_ModelViewProjectionMatrixInverse) set("g_ModelViewProjectionMatrixInverse", M.invert(o.mvp));
    set("g_ModelMatrix", l.ortho || this.identity);
    set("g_EffectModelMatrix", l.ortho || this.identity);
    set("g_ViewProjectionMatrix", this.identity);
    set("g_Brightness", l.brightness[0]);
    set("g_UserAlpha", l.alpha[0]);
    set("g_Alpha", l.alpha[0]);
    set("g_Color", l.color);
    set("g_CompositeColor", l.color);
    set("g_Color4", [l.color[0], l.color[1], l.color[2], l.alpha[0]]);
    this.spriteUniforms(u, t0);
    for (const c of p.constants) set(c.name, c.value);
    if (o.set) o.set(set);
    if (o.geometry) o.geometry.draw(this, p, o);
    else {
      gl.bindVertexArray(this.quadVao);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
    }
  }

  // Animated textures are sheets of frames; shaders get where the current frame sits.
  spriteUniforms(u, t) {
    const gl = this.gl;
    if (u.g_Texture0Rotation) gl.uniform4f(u.g_Texture0Rotation.loc, 1, 0, 0, 1);
    if (u.g_Texture0Translation) gl.uniform2f(u.g_Texture0Translation.loc, 0, 0);
    if (!t?.frames?.length) return;
    let total = 0;
    for (const f of t.frames) total += f.time || 0.0001;
    let at = this.time % total, frame = t.frames[0];
    for (const f of t.frames) { at -= f.time || 0.0001; if (at <= 0) { frame = f; break; } }
    const tw = t.texWidth, th = t.texHeight;
    if (t.images?.length > 1 && t.images[frame.image]) { gl.bindTexture(gl.TEXTURE_2D, t.images[frame.image]); }
    if (u.g_Texture0Rotation) gl.uniform4f(u.g_Texture0Rotation.loc, frame.w / tw, frame.wy / th, frame.hx / tw, frame.h / th);
    if (u.g_Texture0Translation) gl.uniform2f(u.g_Texture0Translation.loc, frame.x / tw, frame.y / th);
  }

  async setupBloom() {
    const g = this.general;
    if (!this.value(g.bloom)) return;
    const gl = this.gl;
    const vs = `#version 300 es
in vec3 a_Position; in vec2 a_TexCoord; out vec2 v_uv; void main() { v_uv = a_TexCoord; gl_Position = vec4(a_Position.xy, 0.0, 1.0); }`;
    const make = (fs) => {
      const p = gl.createProgram();
      for (const [ty, src] of [[gl.VERTEX_SHADER, vs], [gl.FRAGMENT_SHADER, `#version 300 es
precision highp float; in vec2 v_uv; out vec4 color; uniform sampler2D t; uniform sampler2D t2; uniform vec2 dir; uniform float threshold; uniform float strength; uniform vec3 tint;
${fs}`]]) {
        const s = gl.createShader(ty); gl.shaderSource(s, src); gl.compileShader(s); gl.attachShader(p, s); gl.deleteShader(s);
      }
      gl.bindAttribLocation(p, 0, "a_Position"); gl.bindAttribLocation(p, 1, "a_TexCoord");
      gl.linkProgram(p);
      const loc = {};
      for (const n of ["t", "t2", "dir", "threshold", "strength", "tint"]) loc[n] = gl.getUniformLocation(p, n);
      return { p, loc };
    };
    const w = Math.max(1, this.width >> 2), h = Math.max(1, this.height >> 2);
    this.bloom = {
      a: new Target(gl, w, h, this.hdr), b: new Target(gl, w, h, this.hdr), out: new Target(gl, this.width, this.height, this.hdr),
      strength: +(this.value(this.hdr ? g.bloomhdrstrength : g.bloomstrength) ?? 2),
      threshold: +(this.value(this.hdr ? g.bloomhdrthreshold : g.bloomthreshold) ?? 0.65),
      tint: WE.parseVec(this.value(g.bloomtint) ?? "1 1 1"),
      bright: make("void main() { vec3 c = texture(t, v_uv).rgb; float l = max(c.r, max(c.g, c.b)); color = vec4(c * smoothstep(threshold, threshold + 0.2, l), 1.0); }"),
      blur: make("void main() { vec4 s = texture(t, v_uv) * 0.227; const float o[4] = float[](1.385, 3.231, 5.077, 7.0); const float w[4] = float[](0.316, 0.07, 0.015, 0.003); for (int i = 0; i < 4; i++) { s += (texture(t, v_uv + dir * o[i]) + texture(t, v_uv - dir * o[i])) * w[i]; } color = s; }"),
      add: make("void main() { color = vec4(texture(t, v_uv).rgb + texture(t2, v_uv).rgb * strength * tint, 1.0); }"),
    };
  }

  applyBloom() {
    const b = this.bloom, gl = this.gl;
    gl.disable(gl.BLEND);
    gl.colorMask(true, true, true, true);
    gl.bindVertexArray(this.quadVao);
    this.quad(-1, -1, 1, 1, 1, 1);
    const pass = (dest, prog, tex, setup) => {
      gl.bindFramebuffer(gl.FRAMEBUFFER, dest.fb);
      gl.viewport(0, 0, dest.width, dest.height);
      gl.useProgram(prog.p);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.uniform1i(prog.loc.t, 0);
      setup?.(prog.loc);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
    };
    pass(b.a, b.bright, this.sceneTarget.tex, (l) => gl.uniform1f(l.threshold, b.threshold));
    for (let i = 0; i < 2; i++) {
      pass(b.b, b.blur, b.a.tex, (l) => gl.uniform2f(l.dir, 1 / b.a.width, 0));
      pass(b.a, b.blur, b.b.tex, (l) => gl.uniform2f(l.dir, 0, 1 / b.a.height));
    }
    pass(b.out, b.add, this.sceneTarget.tex, (l) => {
      gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, b.a.tex); gl.activeTexture(gl.TEXTURE0);
      gl.uniform1i(l.t2, 1); gl.uniform1f(l.strength, b.strength * 0.5); gl.uniform3fv(l.tint, b.tint);
    });
    return b.out;
  }

  updateParallax(dt) {
    if (!this.parallaxOn) return;
    const k = Math.min(1, Math.max(0, this.parallaxDelay * dt * 10));
    const tx = (this.pointer[0] - 0.5) * this.parallaxAmount * this.parallaxInfluence;
    const ty = (this.pointer[1] - 0.5) * this.parallaxAmount * this.parallaxInfluence;
    this.parallax[0] += (tx - this.parallax[0]) * k;
    this.parallax[1] += (ty - this.parallax[1]) * k;
  }

  renderAt(time) {
    const gl = this.gl;
    this.dt = Math.max(0, time - this.time);
    this.time = time;
    this.frame = (this.frame || 0) + 1;
    const now = new Date();
    this.daytime = (now.getHours() * 3600 + now.getMinutes() * 60 + now.getSeconds()) / 86400;
    this.pointerLast = this.pointer.slice();
    this.pointer = this.pointerTarget.slice();
    this.updateParallax(this.dt);
    for (const d of this.drivers) {
      if (d.kind !== "anim") continue;
      const v = WE.sampleAnimation(d.anim, time);
      for (let i = 0; i < v.length; i++) d.out[i] = v[i];
    }
    WE.tickScripts?.(this);
    for (const v of this.videos) {
      if (v.video.readyState >= 2 && !v.video.paused) {
        gl.bindTexture(gl.TEXTURE_2D, v.tex);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, v.video);
      }
    }
    this.frameUniforms = sharedUniforms(this);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.sceneTarget.fb);
    gl.viewport(0, 0, this.width, this.height);
    gl.colorMask(true, true, true, true);
    const c = this.clearEnabled ? this.clearColor : [0, 0, 0];
    gl.clearColor(c[0], c[1], c[2], 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    this.draws = 0;
    for (const l of this.order) {
      try { l.render(); } catch (e) { this.warn(`render "${l.name}": ${e.message}`); l.render = () => {}; }
    }
    const final = this.bloom ? this.applyBloom() : this.sceneTarget;
    gl.colorMask(true, true, true, true);
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, final.fb);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null);
    gl.viewport(0, 0, this.width, this.height);
    gl.blitFramebuffer(0, 0, this.width, this.height, 0, this.height, this.width, 0, gl.COLOR_BUFFER_BIT, gl.NEAREST);
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
  }

  start() {
    if (this.running) return;
    this.running = true;
    let clock = this.time, last = performance.now(), due = 0;
    const tick = (now) => {
      if (!this.running) return;
      this.raf = requestAnimationFrame(tick);
      if (this.paused || now < due) { last = now; return; }
      due = now + 1000 / this.fps - 2;
      clock += Math.min(0.25, (now - last) / 1000) * (this.speed || 1);
      last = now;
      this.renderAt(clock);
    };
    this.raf = requestAnimationFrame(tick);
  }

  // A JPEG of the current frame. The canvas only holds a frame right after drawing one.
  frameDataUrl() {
    this.renderAt(this.time);
    return this.canvas.toDataURL("image/jpeg", 0.9);
  }

  setAudio(muted, volume) {
    for (const s of this.sounds) s.setMaster(muted ? 0 : volume);
  }

  setPaused(p) {
    this.paused = p;
    for (const v of this.videos) p ? v.video.pause() : v.video.play().catch(() => {});
    for (const s of this.sounds) s.setPaused?.(p);
  }

  destroy() {
    this.running = false;
    cancelAnimationFrame(this.raf);
    for (const v of this.videos) { v.video.pause(); URL.revokeObjectURL(v.video.src); v.video.removeAttribute("src"); v.video.load(); }
    for (const s of this.sounds) s.stop?.();
    WE.stopScripts?.(this);
    this.gl?.getExtension("WEBGL_lose_context")?.loseContext();
  }
};
