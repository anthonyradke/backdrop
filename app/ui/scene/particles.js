// Particle systems: emitters spawn particles, initializers give them their starting values,
// operators change them every frame, and a renderer turns them into camera-facing quads for the
// stock genericparticle shader. Particles live in the system's own space, with y up.
"use strict";
var WE = window.WE || (window.WE = {});

const rnd = (a, b) => a + Math.random() * (b - a);
const vec = (v, d = [0, 0, 0]) => {
  if (v === undefined || v === null) return d.slice();
  const p = WE.parseVec(v);
  if (p.length === 1) return [p[0], p[0], p[0]];
  while (p.length < 3) p.push(0);
  return p;
};
const num = (v, d) => { if (v === undefined || v === null) return d; const n = +(WE.parseVec(v)[0]); return Number.isFinite(n) ? n : d; };
const lerp = (a, b, t) => a + (b - a) * t;
const clamp01 = (x) => Math.min(1, Math.max(0, x));
// Random between min and max, with `exponent` pushing the result towards min.
const shaped = (a, b, e = 1) => a + (b - a) * Math.pow(Math.random(), e);

function randomDirection() {
  const z = rnd(-1, 1), t = rnd(0, Math.PI * 2), r = Math.sqrt(1 - z * z);
  return [r * Math.cos(t), r * Math.sin(t), z];
}

function hsv(h, s, v) {
  const i = Math.floor(h * 6), f = h * 6 - i, p = v * (1 - s), q = v * (1 - f * s), t = v * (1 - (1 - f) * s);
  return [[v, t, p], [q, v, p], [p, v, t], [p, q, v], [t, p, v], [v, p, q]][i % 6];
}

// Smooth pseudo-random flow, for turbulence.
function flow(x, y, z, t) {
  return [
    Math.sin(y * 1.3 + t) + Math.sin(z * 0.7 + t * 1.3) + Math.cos(y * 2.1 - t * 0.7),
    Math.sin(z * 1.1 + t * 0.9) + Math.sin(x * 1.7 - t) + Math.cos(z * 1.9 + t * 1.1),
    Math.sin(x * 0.9 - t * 1.2) + Math.sin(y * 1.5 + t * 0.8) + Math.cos(x * 2.3 + t),
  ];
}

const initializers = {
  lifetimerandom(d) { const a = num(d.min, 1), b = num(d.max, a), e = num(d.exponent, 1); return (p) => { p.lifetime = shaped(a, b, e); }; },
  sizerandom(d) { const a = num(d.min, 0), b = num(d.max, 20), e = num(d.exponent, 1); return (p) => { p.size = p.size0 = shaped(a, b, e); }; },
  alpharandom(d) { const a = num(d.min, 1), b = num(d.max, 1), e = num(d.exponent, 1); return (p) => { p.alpha = p.alpha0 = shaped(a, b, e); }; },
  colorrandom(d) {
    const a = vec(d.min, [255, 255, 255]), b = vec(d.max, a), e = num(d.exponent, 1);
    return (p) => { const t = Math.pow(Math.random(), e); p.color0 = [lerp(a[0], b[0], t) / 255, lerp(a[1], b[1], t) / 255, lerp(a[2], b[2], t) / 255]; p.color = p.color0.slice(); };
  },
  hsvcolorrandom(d) {
    const h0 = num(d.huemin, 0), h1 = num(d.huemax, 360), s0 = num(d.saturationmin, 1), s1 = num(d.saturationmax, 1), v0 = num(d.valuemin, 1), v1 = num(d.valuemax, 1);
    return (p) => { p.color0 = hsv(((rnd(h0, h1) / 360) % 1 + 1) % 1, rnd(s0, s1), rnd(v0, v1)); p.color = p.color0.slice(); };
  },
  velocityrandom(d) {
    const a = vec(d.min), b = vec(d.max);
    return (p) => { p.vel[0] += rnd(a[0], b[0]); p.vel[1] += rnd(a[1], b[1]); p.vel[2] += rnd(a[2], b[2]); };
  },
  rotationrandom(d) {
    const a = vec(d.min), b = vec(d.max, [0, 0, Math.PI * 2]);
    return (p) => { p.rot = [rnd(a[0], b[0]), rnd(a[1], b[1]), rnd(a[2], b[2])]; };
  },
  angularvelocityrandom(d) {
    const a = vec(d.min), b = vec(d.max);
    return (p) => { p.spin = [rnd(a[0], b[0]), rnd(a[1], b[1]), rnd(a[2], b[2])]; };
  },
  turbulentvelocityrandom(d) {
    const s0 = num(d.speedmin, 100), s1 = num(d.speedmax, 250), scale = num(d.scale, 1), forward = vec(d.forward, [0, 1, 0]);
    return (p) => {
      const r = randomDirection(), speed = rnd(s0, s1), k = Math.min(1, scale);
      const v = [lerp(forward[0], r[0], k), lerp(forward[1], r[1], k), lerp(forward[2], r[2], k)];
      const l = Math.hypot(...v) || 1;
      p.vel[0] += (v[0] / l) * speed; p.vel[1] += (v[1] / l) * speed; p.vel[2] += (v[2] / l) * speed;
    };
  },
  positionoffsetrandom(d) {
    const dist = num(d.distance, 0);
    return (p) => { const r = randomDirection(); p.pos[0] += r[0] * dist; p.pos[1] += r[1] * dist; };
  },
  mapsequencearoundcontrolpoint(d, sys) {
    const count = Math.max(1, num(d.count, 10)), s0 = vec(d.speedmin), s1 = vec(d.speedmax, s0);
    let n = 0;
    return (p) => {
      const t = ((n++ % count) / count) * Math.PI * 2, r = rnd(s0[0], s1[0]);
      p.vel[0] += Math.cos(t) * r; p.vel[1] += Math.sin(t) * r;
    };
  },
  mapsequencebetweencontrolpoints(d, sys) {
    const count = Math.max(2, num(d.count, 10));
    let n = 0;
    return (p) => {
      const a = sys.point(num(d.controlpointstart, 0)), b = sys.point(num(d.controlpointend, 1)), t = (n++ % count) / (count - 1);
      p.pos = [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
    };
  },
};

const window01 = (t, a, b) => (b > a ? clamp01((t - a) / (b - a)) : t >= a ? 1 : 0);
// Most operators fade in and out over a stretch of the particle's life.
function fader(d) {
  const a = num(d.blendinstart, 0), b = num(d.blendinend, 0), c = num(d.blendoutstart, 1), e = num(d.blendoutend, 1);
  if (b <= a && e <= c) return () => 1;
  return (t) => (b > a ? window01(t, a, b) : 1) * (e > c ? 1 - window01(t, c, e) : 1);
}

const operators = {
  movement(d) {
    const g = vec(d.gravity), drag = num(d.drag, 0);
    return (p, dt) => {
      p.vel[0] += g[0] * dt; p.vel[1] += g[1] * dt; p.vel[2] += g[2] * dt;
      if (drag) { const k = Math.max(0, 1 - drag * dt); p.vel[0] *= k; p.vel[1] *= k; p.vel[2] *= k; }
      p.pos[0] += p.vel[0] * dt; p.pos[1] += p.vel[1] * dt; p.pos[2] += p.vel[2] * dt;
    };
  },
  angularmovement(d) {
    const f = vec(d.force), drag = num(d.drag, 0);
    return (p, dt) => {
      for (let i = 0; i < 3; i++) {
        p.spin[i] += f[i] * dt;
        if (drag) p.spin[i] *= Math.max(0, 1 - drag * dt);
        p.rot[i] += p.spin[i] * dt;
      }
    };
  },
  alphafade(d) {
    const a = num(d.fadeintime, 0.5), b = num(d.fadeouttime, 0.5);
    return (p) => {
      const t = p.t;
      p.alpha *= t < a ? (a > 0 ? t / a : 1) : t > b ? (b < 1 ? clamp01((1 - t) / (1 - b)) : 0) : 1;
    };
  },
  alphachange(d) { const s = num(d.starttime, 0), e = num(d.endtime, 1), a = num(d.startvalue, 1), b = num(d.endvalue, 0); return (p) => { p.alpha *= lerp(a, b, window01(p.t, s, e)); }; },
  sizechange(d) { const s = num(d.starttime, 0), e = num(d.endtime, 1), a = num(d.startvalue, 1), b = num(d.endvalue, 0); return (p) => { p.size *= lerp(a, b, window01(p.t, s, e)); }; },
  colorchange(d) {
    const s = num(d.starttime, 0), e = num(d.endtime, 1), a = vec(d.startvalue, [1, 1, 1]), b = vec(d.endvalue, [1, 1, 1]);
    return (p) => { const t = window01(p.t, s, e); for (let i = 0; i < 3; i++) p.color[i] *= lerp(a[i], b[i], t); };
  },
  oscillatealpha(d) {
    const f0 = num(d.frequencymin, 0), f1 = num(d.frequencymax, f0 || 10), s0 = num(d.scalemin, 0), s1 = num(d.scalemax, 1), ph = num(d.phasemax, Math.PI * 2), fade = fader(d);
    return (p) => {
      const o = p.osc("alpha", f0, f1, ph), k = lerp(s0, s1, (Math.sin(o.ph + p.age * o.f) + 1) / 2);
      p.alpha *= lerp(1, k, fade(p.t));
    };
  },
  oscillatesize(d) {
    const f0 = num(d.frequencymin, 0), f1 = num(d.frequencymax, f0 || 10), s0 = num(d.scalemin, 0.8), s1 = num(d.scalemax, 1.2), ph = num(d.phasemax, Math.PI * 2), fade = fader(d);
    return (p) => {
      const o = p.osc("size", f0, f1, ph), k = lerp(s0, s1, (Math.sin(o.ph + p.age * o.f) + 1) / 2);
      p.size *= lerp(1, k, fade(p.t));
    };
  },
  oscillateposition(d) {
    const f0 = num(d.frequencymin, 0), f1 = num(d.frequencymax, f0 || 5), s0 = num(d.scalemin, 0), s1 = num(d.scalemax, 1), mask = vec(d.mask, [1, 1, 0]), fade = fader(d);
    return (p, dt) => {
      const o = p.osc("pos", f0, f1, Math.PI * 2), a = o.amp ?? (o.amp = rnd(s0, s1)), k = Math.cos(o.ph + p.age * o.f) * a * o.f * dt * fade(p.t);
      p.pos[0] += k * mask[0] * (o.dx ?? (o.dx = rnd(-1, 1)));
      p.pos[1] += k * mask[1] * (o.dy ?? (o.dy = rnd(-1, 1)));
      p.pos[2] += k * mask[2];
    };
  },
  turbulence(d) {
    const scale = num(d.scale, 0.005), s0 = num(d.speedmin, 100), s1 = num(d.speedmax, 200), ts = num(d.timescale, 1), mask = vec(d.mask, [1, 1, 0]), fade = fader(d);
    return (p, dt, sys) => {
      const n = flow(p.pos[0] * scale, p.pos[1] * scale, p.pos[2] * scale, sys.time * ts), s = rnd(s0, s1) * dt * fade(p.t);
      p.vel[0] += n[0] * s * mask[0]; p.vel[1] += n[1] * s * mask[1]; p.vel[2] += n[2] * s * mask[2];
    };
  },
  vortex(d, sys) {
    const cp = num(d.controlpoint, 0), inner = num(d.distanceinner, 500), outer = num(d.distanceouter, 650), si = num(d.speedinner, 2500), so = num(d.speedouter, 0), a = vec(d.axis, [0, 0, 1]);
    return (p, dt) => {
      const c = sys.point(cp), dx = p.pos[0] - c[0], dy = p.pos[1] - c[1], r = Math.hypot(dx, dy) || 1;
      const speed = lerp(si, so, window01(r, inner, outer)) * dt * (a[2] < 0 ? -1 : 1);
      p.vel[0] += (-dy / r) * speed; p.vel[1] += (dx / r) * speed;
    };
  },
  controlpointattract(d, sys) {
    const cp = num(d.controlpoint, 0), scale = num(d.scale, 100), threshold = num(d.threshold, 512), fade = fader(d);
    return (p, dt) => {
      const c = sys.point(cp), dx = c[0] - p.pos[0], dy = c[1] - p.pos[1], dz = c[2] - p.pos[2], r = Math.hypot(dx, dy, dz);
      if (!r || r > threshold) return;
      const k = (scale * dt * fade(p.t)) / r;
      p.vel[0] += dx * k; p.vel[1] += dy * k; p.vel[2] += dz * k;
    };
  },
  capvelocity(d) {
    const max = num(d.maxspeed, 100);
    return (p) => { const s = Math.hypot(...p.vel); if (s > max) { const k = max / s; p.vel[0] *= k; p.vel[1] *= k; p.vel[2] *= k; } };
  },
  reducemovementnearcontrolpoint(d, sys) {
    const cp = num(d.controlpoint, 0), inner = num(d.distanceinner, 100), outer = num(d.distanceouter, 500), r0 = num(d.reductioninner, 1), r1 = num(d.reductionouter, 0);
    return (p, dt) => {
      const c = sys.point(cp), r = Math.hypot(p.pos[0] - c[0], p.pos[1] - c[1], p.pos[2] - c[2]);
      const k = Math.max(0, 1 - lerp(r0, r1, window01(r, inner, outer)) * dt * 10);
      p.vel[0] *= k; p.vel[1] *= k; p.vel[2] *= k;
    };
  },
};
operators.vortex_v2 = operators.vortex;

class Particle {
  constructor() { this.oscs = null; }
  reset() {
    this.pos = [0, 0, 0]; this.vel = [0, 0, 0]; this.rot = [0, 0, 0]; this.spin = [0, 0, 0];
    this.size = this.size0 = 20; this.alpha = this.alpha0 = 1;
    this.color0 = [1, 1, 1]; this.color = [1, 1, 1];
    this.age = 0; this.lifetime = 1; this.t = 0; this.frame = Math.random();
    this.oscs = null;
    return this;
  }
  osc(key, f0, f1, ph) {
    const o = this.oscs || (this.oscs = {});
    return o[key] || (o[key] = { f: rnd(f0, f1), ph: rnd(0, ph) });
  }
}

const FLOATS = 17; // per vertex: position 3, uv+rotation+size 4, color 4, rotation 2, velocity+life 4

class System {
  constructor(layer, def, over, mult) {
    this.layer = layer;
    this.def = def;
    this.over = over || {};
    this.time = 0;
    this.live = [];
    this.pool = [];
    this.children = [];
    const o = this.over;
    this.max = Math.min(50000, Math.ceil(num(def.maxcount, 100) * num(o.count, 1) * (mult ?? 1)));
    this.rateK = num(o.rate, 1);
    this.lifeK = num(o.lifetime, 1);
    this.sizeK = num(o.size, 1);
    this.speedK = num(o.speed, 1);
    this.alphaK = num(o.alpha, 1);
    this.tint = o.colorn !== undefined ? vec(o.colorn, [1, 1, 1]) : o.color !== undefined ? vec(o.color, [1, 1, 1]) : null;
    this.controls = (def.controlpoint || []).map((c) => ({ id: c.id ?? 0, offset: vec(c.offset), follow: !!((c.flags ?? 0) & 1) }));
    this.emitters = (def.emitter || []).map((e) => ({ d: e, acc: 0, age: 0, spent: false, rate: num(e.rate, 5), make: this.emitterShape(e), delay: num(e.delay, 0), duration: num(e.duration, 0) }));
    const build = (table, list, kind) => (list || []).flatMap((d) => {
      const f = table[d.name];
      if (!f) { layer.scene.warnOnce(`particle ${kind} ${d.name} isn't supported`); return []; }
      return [f(d, this)];
    });
    this.inits = build(initializers, def.initializer, "initializer");
    this.ops = build(operators, def.operator, "operator");
    this.seq = num(def.sequencemultiplier, 1);
    this.randomFrame = def.animationmode === "randomframe";
  }

  emitterShape(e) {
    const origin = vec(e.origin), dirs = vec(e.directions, [1, 1, 1]);
    const spd0 = num(e.speedmin, 0), spd1 = num(e.speedmax, spd0);
    const sign = vec(e.sign);
    const clampSign = (v, i) => (sign[i] > 0 ? Math.abs(v) : sign[i] < 0 ? -Math.abs(v) : v);
    if (e.name === "boxrandom") {
      const lo = vec(e.distancemin), hi = vec(e.distancemax, [100, 100, 0]);
      return (p) => {
        for (let i = 0; i < 3; i++) {
          const m = rnd(lo[i], hi[i]) * (Math.random() < 0.5 ? -1 : 1);
          p.pos[i] = origin[i] + clampSign(m, i) * dirs[i];
        }
      };
    }
    const lo = num(e.distancemin, 0), hi = num(e.distancemax, 100);
    return (p) => {
      const r = randomDirection(), d = rnd(lo, hi);
      for (let i = 0; i < 3; i++) {
        const v = r[i] * dirs[i];
        p.pos[i] = origin[i] + clampSign(v, i) * d;
        if (spd1) p.vel[i] += clampSign(v, i) * rnd(spd0, spd1);
      }
    };
  }

  // Control points: 0 is the system itself, and a flagged one follows the cursor.
  point(id) {
    const c = this.controls.find((x) => x.id === id);
    const s = this.layer.scene;
    if (c?.follow) {
      const w = this.layer.world();
      return [s.pointer[0] * s.width - w.origin[0], (1 - s.pointer[1]) * s.height - w.origin[1], 0];
    }
    return c ? c.offset : [0, 0, 0];
  }

  spawn(em, at) {
    if (this.live.length >= this.max) return null;
    const p = (this.pool.pop() || new Particle()).reset();
    em?.make(p);
    if (at) { p.pos[0] += at[0]; p.pos[1] += at[1]; p.pos[2] += at[2]; }
    for (const f of this.inits) f(p);
    p.lifetime *= this.lifeK;
    p.size0 *= this.sizeK; p.size = p.size0;
    p.alpha0 *= this.alphaK; p.alpha = p.alpha0;
    if (this.tint) { p.color0 = this.tint.map((v, i) => v * p.color0[i]); p.color = p.color0.slice(); }
    p.vel[0] *= this.speedK; p.vel[1] *= this.speedK; p.vel[2] *= this.speedK;
    this.live.push(p);
    for (const c of this.children) if (c.type === "eventspawn") c.system.burst(c.count, p.pos);
    return p;
  }

  burst(n, at) {
    for (let i = 0; i < n; i++) this.spawn(this.emitters[0], at);
  }

  emit(dt) {
    for (const em of this.emitters) {
      em.age += dt;
      if (em.age < em.delay) continue;
      if (em.duration && em.age - em.delay > em.duration) continue;
      if (em.d.instantaneous) {
        if (!em.spent) { em.spent = true; this.burst(Math.round(num(em.d.instantaneous, 1)), this.source()); }
        if (!em.rate) continue;
      }
      em.acc += em.rate * this.rateK * dt;
      const n = Math.min(Math.floor(em.acc), this.max);
      em.acc -= n;
      for (let i = 0; i < n; i++) this.spawn(em, this.source());
    }
  }

  // A system following another's particles emits from one of them.
  source() {
    const list = this.follows?.live;
    return list ? (list.length ? list[Math.floor(Math.random() * list.length)].pos : undefined) : undefined;
  }

  step(dt) {
    this.time += dt;
    if (!this.follows || this.follows.live.length) this.emit(dt);
    const live = this.live;
    let n = 0;
    for (let i = 0; i < live.length; i++) {
      const p = live[i];
      p.age += dt;
      p.t = p.age / p.lifetime;
      if (p.t >= 1) {
        this.pool.push(p);
        for (const c of this.children) if (c.type === "eventdeath") c.system.burst(c.count, p.pos);
        continue;
      }
      p.size = p.size0; p.alpha = p.alpha0;
      p.color[0] = p.color0[0]; p.color[1] = p.color0[1]; p.color[2] = p.color0[2];
      for (const op of this.ops) op(p, dt, this);
      live[n++] = p;
    }
    live.length = n;
    for (const c of this.children) c.system.step(dt);
  }
}

class Sprites {
  constructor(scene, sys) {
    this.scene = scene;
    this.sys = sys;
    const gl = scene.gl;
    this.data = new Float32Array(sys.max * 4 * FLOATS);
    this.vao = gl.createVertexArray();
    gl.bindVertexArray(this.vao);
    this.buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buf);
    gl.bufferData(gl.ARRAY_BUFFER, this.data.byteLength, gl.DYNAMIC_DRAW);
    const s = FLOATS * 4, A = WE.ATTRIB;
    const attr = (slot, size, off) => { gl.enableVertexAttribArray(slot); gl.vertexAttribPointer(slot, size, gl.FLOAT, false, s, off * 4); };
    attr(0, 3, 0); attr(A.a_TexCoordVec4, 4, 3); attr(A.a_Color, 4, 7); attr(A.a_TexCoordC2, 2, 11); attr(A.a_TexCoordVec4C1, 4, 13);
    const idx = new Uint32Array(sys.max * 6);
    for (let i = 0; i < sys.max; i++) {
      const v = i * 4;
      idx.set([v, v + 1, v + 2, v + 2, v + 1, v + 3], i * 6);
    }
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, idx, gl.STATIC_DRAW);
    gl.bindVertexArray(null);
  }
  draw(scene) {
    const gl = scene.gl, d = this.data, sys = this.sys, list = sys.live, f = FLOATS;
    let o = 0;
    for (let i = 0; i < list.length; i++) {
      const p = list[i];
      const life = sys.randomFrame ? p.frame : (p.t * sys.seq) % 1;
      for (let c = 0; c < 4; c++) {
        d[o] = p.pos[0]; d[o + 1] = p.pos[1]; d[o + 2] = p.pos[2];
        d[o + 3] = c & 1; d[o + 4] = c >> 1; d[o + 5] = p.rot[2]; d[o + 6] = p.size;
        d[o + 7] = p.color[0]; d[o + 8] = p.color[1]; d[o + 9] = p.color[2]; d[o + 10] = p.alpha;
        d[o + 11] = p.rot[0]; d[o + 12] = p.rot[1];
        d[o + 13] = p.vel[0]; d[o + 14] = p.vel[1]; d[o + 15] = p.vel[2]; d[o + 16] = life;
        o += f;
      }
    }
    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buf);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, d, 0, o);
    gl.drawElements(gl.TRIANGLES, list.length * 6, gl.UNSIGNED_INT, 0);
    gl.bindVertexArray(scene.quadVao);
  }
}

WE.ParticleLayer = class extends WE.LayerBase {
  async init() {
    const s = this.scene, d = this.data;
    this.draws = true;
    this.over = d.instanceoverride || {};
    const def = await s.assets.json(d.particle);
    if (!def) throw new Error(`particle ${d.particle} not found`);
    this.parts = [];
    this.root = await this.addSystem(def, this.over, 1);
    // A saved start time means the scene opens as if it had been running that long.
    const warm = Math.min(5, num(def.starttime, 0));
    for (let t = 0; t < warm; t += 1 / 20) this.root.step(1 / 20);
  }
  async addSystem(def, over, mult) {
    const s = this.scene;
    const sys = new System(this, def, over, mult);
    const mat = await s.assets.json(def.material);
    if (!mat) throw new Error(`material ${def.material} not found`);
    const pass = mat.passes[0], renderer = def.renderer?.[0]?.name || "sprite";
    const trail = /trail/.test(renderer);
    const name = pass.textures?.[0];
    const tex = name ? await s.texture(name) : s.white;
    const combos = { ...(pass.combos || {}), GS_ENABLED: 0, THICKFORMAT: 1, TRAILRENDERER: trail ? 1 : 0 };
    if (tex.frames?.length) combos.SPRITESHEET = 1;
    if (/^rope/.test(renderer)) s.warnOnce("rope particles draw as sprites");
    const shader = pass.shader === "genericropeparticle" ? "genericparticle" : pass.shader;
    const p = await s.makePass(this, { ...pass, shader }, { combos }, null, null, tex);
    const r = def.renderer?.[0] || {};
    this.parts.push({
      sys, pass: p, tex, mesh: new Sprites(s, sys),
      vars: [num(r.length, 0.05), num(r.maxlength, 10), num(r.minlength, 0), 0],
      frame: tex.frames?.length ? [tex.frames[0].w / tex.texWidth, tex.frames[0].h / tex.texHeight, tex.frames.length, tex.height / tex.width] : [1, 1, 1, tex.height / tex.width],
    });
    for (const c of def.children || []) {
      const child = await s.assets.json(c.name);
      if (!child) continue;
      const count = num(c.maxcount, 1);
      const sub = await this.addSystem(child, over, c.type === "eventfollow" ? 1 : Math.max(1, count));
      const type = c.type || "static";
      if (type === "eventfollow") sub.follows = sys;
      sys.children.push({ system: sub, type, count });
    }
    return sys;
  }
  render() {
    if (!this.shown()) return;
    const s = this.scene, gl = s.gl, M = WE.M;
    this.root.step(Math.min(0.1, s.dt));
    const w = this.world();
    let m = M.mul(s.projection, M.translate(w.origin[0] - s.width / 2, s.height / 2 - w.origin[1], 0));
    if (w.angle) m = M.mul(m, M.rotateZ(-w.angle));
    m = M.mul(m, [w.scale[0], 0, 0, 0, 0, -w.scale[1], 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
    if (s.parallaxOn) {
      const dx = (this.parallaxDepth[0] + s.parallaxAmount) * s.parallax[0] * s.width, dy = (this.parallaxDepth[1] + s.parallaxAmount) * s.parallax[1] * s.width;
      m = M.mul(M.mul(s.projection, M.translate(dx, dy)), M.mul(M.invert(s.projection), m));
    }
    gl.colorMask(true, true, true, false);
    for (const part of this.parts) {
      if (!part.sys.live.length) continue;
      s.drawPass(part.pass, s.sceneTarget, part.tex, null, {
        mvp: m, blend: part.pass.blending, layer: this, geometry: part.mesh,
        set: (set) => {
          set("g_RenderVar0", part.vars);
          set("g_RenderVar1", part.frame);
          set("g_ModelMatrixInverse", s.identity);
          set("g_EyePosition", [0, 0, 100000]);
        },
      });
    }
    gl.colorMask(true, true, true, true);
  }
};
