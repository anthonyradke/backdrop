// Particle systems: emitters spawn particles, initializers give them their starting values,
// operators change them every frame, and a renderer turns them into camera-facing quads for the
// stock genericparticle shader. Particles live in the system's own space, with y up.
"use strict";
var WE = window.WE || (window.WE = {});

const rnd = (a, b) => a + Math.random() * (b - a);
// Limits on child particle systems, far past what real wallpapers use.
const MAX_CHILD_DEPTH = 4, MAX_SYSTEMS = 64;
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
  colorlist(d) {
    const list = (d.colors || []).map((c) => vec(c, [1, 1, 1]));
    return (p) => { if (list.length) { p.color0 = list[Math.floor(Math.random() * list.length)].slice(); p.color = p.color0.slice(); } };
  },
  inheritcontrolpointvelocity(d, sys) {
    const cp = num(d.controlpoint, 0), a = num(d.min, 1), b = num(d.max, a);
    return (p) => { const v = sys.pointVelocity(cp), k = rnd(a, b); for (let i = 0; i < 3; i++) p.vel[i] += v[i] * k; };
  },
  // A child particle starting out with what the parent particle has.
  inheritinitialvaluefromevent() {
    return (p) => {
      const o = p.eventParent;
      if (!o) return;
      p.color0 = o.color.slice(); p.color = o.color.slice();
      p.alpha0 = o.alpha; p.alpha = o.alpha;
    };
  },
  // Scales a starting value by how far from a control point the particle begins.
  remapinitialvalue(d, sys) {
    const cp = num(d.inputcontrolpoint0, 0), lo = num(d.inputrangemin, 0), hi = num(d.inputrangemax, 1);
    const output = d.output || "size", operation = d.operation || "multiply";
    const a = d.outputrangemin === undefined ? (output === "color" ? [0, 0, 0] : [0, 0, 0]) : vec(d.outputrangemin), b = d.outputrangemax === undefined ? [1, 1, 1] : vec(d.outputrangemax);
    return (p) => {
      const c = sys.point(cp), dist = Math.hypot(p.pos[0] - c[0], p.pos[1] - c[1], p.pos[2] - c[2]);
      const t = d.input === "distancetocontrolpoint" ? window01(dist, lo, hi) : Math.random();
      const v = [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
      const apply = (old, n) => (operation === "remap" ? n : old * n);
      if (output === "color") p.color0 = p.color0.map((o, i) => apply(o, v[i]));
      else if (output === "opacity" || output === "alpha") p.alpha0 = apply(p.alpha0, v[0]);
      else if (output === "lifetime") p.lifetime = apply(p.lifetime, v[0]);
      else if (output === "velocity") p.vel = p.vel.map((o, i) => apply(o, v[i]));
      else p.size0 = apply(p.size0, v[0]);
      p.size = p.size0; p.alpha = p.alpha0; p.color = p.color0.slice();
    };
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
      p.along = t;
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
    const gr = vec(d.gravity), f = vec(d.force), g = [gr[0] + f[0], gr[1] + f[1], gr[2] + f[2]], drag = num(d.drag, 0);
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
  inheritvaluefromevent() {
    return (p) => {
      const o = p.eventParent;
      if (!o) return;
      p.alpha *= o.alpha;
      for (let i = 0; i < 3; i++) p.color[i] *= o.color[i];
    };
  },
  collisionplane(d) {
    const n = vec(d.plane, [0, 1, 0]), l = Math.hypot(...n) || 1, nx = n[0] / l, ny = n[1] / l, nz = n[2] / l, dist = num(d.distance, 0), bounce = num(d.bouncefactor, 0.5);
    return (p) => {
      const side = p.pos[0] * nx + p.pos[1] * ny + p.pos[2] * nz - dist;
      if (side >= 0) return;
      p.pos[0] -= nx * side; p.pos[1] -= ny * side; p.pos[2] -= nz * side;
      const v = p.vel[0] * nx + p.vel[1] * ny + p.vel[2] * nz;
      if (v < 0) { p.vel[0] -= (1 + bounce) * v * nx; p.vel[1] -= (1 + bounce) * v * ny; p.vel[2] -= (1 + bounce) * v * nz; }
    };
  },
  // The picture's edges.
  collisionbounds(d, sys) {
    const bounce = num(d.bouncefactor, 0.5);
    return (p) => {
      const s = sys.layer.scene, w = sys.layer.world();
      const lo = [-w.origin[0] / w.scale[0], -w.origin[1] / w.scale[1]], hi = [(s.width - w.origin[0]) / w.scale[0], (s.height - w.origin[1]) / w.scale[1]];
      for (let i = 0; i < 2; i++) {
        const a = Math.min(lo[i], hi[i]), b = Math.max(lo[i], hi[i]);
        if (p.pos[i] < a) { p.pos[i] = a; p.vel[i] = Math.abs(p.vel[i]) * bounce; } else if (p.pos[i] > b) { p.pos[i] = b; p.vel[i] = -Math.abs(p.vel[i]) * bounce; }
      }
    };
  },
  collisionsphere(d) {
    const o = vec(d.origin), radius = num(d.radius, 100), bounce = num(d.bouncefactor, d.collisionbehavior === "slide" ? 0 : 0.5);
    return (p) => {
      const dx = p.pos[0] - o[0], dy = p.pos[1] - o[1], dz = p.pos[2] - o[2], r = Math.hypot(dx, dy, dz);
      if (!r || r >= radius) return;
      const nx = dx / r, ny = dy / r, nz = dz / r;
      p.pos[0] = o[0] + nx * radius; p.pos[1] = o[1] + ny * radius; p.pos[2] = o[2] + nz * radius;
      const v = p.vel[0] * nx + p.vel[1] * ny + p.vel[2] * nz;
      if (v < 0) { p.vel[0] -= (1 + bounce) * v * nx; p.vel[1] -= (1 + bounce) * v * ny; p.vel[2] -= (1 + bounce) * v * nz; }
    };
  },
  // A rectangle in space; the particles' plane of travel treats it like its plane.
  collisionquad(d) {
    const size = vec(d.size, [100, 100, 0]), o = vec(d.origin), bounce = num(d.bouncefactor, 0.5);
    return (p) => {
      if (Math.abs(p.pos[0] - o[0]) > size[0] || p.pos[1] >= o[1] || p.vel[1] >= 0) return;
      p.pos[1] = o[1]; p.vel[1] = -p.vel[1] * bounce;
    };
  },
  // Colliding with a 3D model needs its triangles; particles pass through instead of vanishing.
  collisionmodel() { return () => {}; },
  remapvalue(d, sys) {
    const scale = num(d.transforminputscale, 1), fn = d.transformfunction || "none", operation = d.operation || "multiply", fade = fader(d);
    const lo = vec(d.outputrangemin), hi = d.outputrangemax === undefined ? [1, 1, 1] : vec(d.outputrangemax);
    const input = (p) => (d.input === "particlesystemtime" ? sys.time : d.input === "particlelifetime" || !d.input ? p.t : p.age);
    const shape = (p) => {
      const x = input(p) * scale;
      if (fn === "sine") return (Math.sin(x) + 1) / 2;
      if (fn === "simplexnoise") return clamp01((flow(x + p.frame * 40, x * 0.7, p.frame * 40, 0)[0] + 3) / 6);
      return clamp01(x);
    };
    const mix = (old, n, k) => lerp(old, operation === "remap" ? n : old * n, k);
    return (p) => {
      const t = shape(p), k = fade(p.t), v = [lerp(lo[0], hi[0], t), lerp(lo[1], hi[1], t), lerp(lo[2], hi[2], t)];
      if (d.output === "opacity" || d.output === "alpha") p.alpha = mix(p.alpha, v[0], k);
      else if (d.output === "size") p.size = mix(p.size, v[0], k);
      else if (d.output === "color") p.color = p.color.map((o, i) => mix(o, v[i], k));
      else if (d.output === "velocity") p.vel = p.vel.map((o, i) => mix(o, v[i], k));
    };
  },
  // Holds particles on the shell they started on around a control point.
  maintaindistancetocontrolpoint(d, sys) {
    const cp = num(d.controlpoint, 0), k = num(d.variablestrength, 5);
    return (p, dt) => {
      const c = sys.point(cp), dx = p.pos[0] - c[0], dy = p.pos[1] - c[1], dz = p.pos[2] - c[2], r = Math.hypot(dx, dy, dz) || 1;
      if (p.shell === undefined) p.shell = r;
      const pull = ((p.shell - r) / r) * Math.min(1, k * dt);
      p.pos[0] += dx * pull; p.pos[1] += dy * pull; p.pos[2] += dz * pull;
    };
  },
  // Keeps a chain strung evenly between its two end points.
  maintaindistancebetweencontrolpoints(d, sys) {
    const from = num(d.controlpointstart, 0), to = num(d.controlpointend, 1), k = num(d.variablestrength, 5);
    return (p, dt) => {
      if (p.along === undefined) return;
      const a = sys.point(from), b = sys.point(to), s = Math.min(1, k * dt);
      for (let i = 0; i < 3; i++) p.pos[i] += (lerp(a[i], b[i], p.along) - p.pos[i]) * s;
    };
  },
  // Flocking: steer towards neighbours, match them, and don't crowd.
  boids(d, sys) {
    const range = num(d.neighborthreshold, 150), co = num(d.cohesionfactor, 5), al = num(d.alignmentfactor, 5), se = num(d.separationfactor, 5);
    return (p, dt) => {
      const list = sys.current;
      let n = 0, cx = 0, cy = 0, vx = 0, vy = 0, sx = 0, sy = 0;
      // Plenty for the look of a flock, and it keeps this from going quadratic on big systems.
      const step = Math.max(1, Math.floor(list.length / 64));
      for (let i = 0; i < list.length; i += step) {
        const o = list[i];
        if (o === p) continue;
        const dx = o.pos[0] - p.pos[0], dy = o.pos[1] - p.pos[1], r = Math.hypot(dx, dy);
        if (r > range || !r) continue;
        n++; cx += dx; cy += dy; vx += o.vel[0]; vy += o.vel[1]; sx -= dx / r; sy -= dy / r;
      }
      if (!n) return;
      p.vel[0] += ((cx / n) * co * 0.02 + (vx / n - p.vel[0]) * al * 0.1 + sx * se) * dt;
      p.vel[1] += ((cy / n) * co * 0.02 + (vy / n - p.vel[1]) * al * 0.1 + sy * se) * dt;
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
    this.history = null;
    this.since = 0;
    this.shell = undefined;
    this.along = undefined;
    return this;
  }
  osc(key, f0, f1, ph) {
    const o = this.oscs || (this.oscs = {});
    return o[key] || (o[key] = { f: rnd(f0, f1), ph: rnd(0, ph) });
  }
}

const FLOATS = 17; // per vertex: position 3, uv+rotation+size 4, color 4, rotation 2, velocity+life 4

// One running set of particles. A top-level system has a single instance; a child system has one
// per parent particle that triggered it, placed at that particle.
class Instance {
  constructor(sys) {
    this.sys = sys;
    this.live = [];
    this.emitters = sys.emitters.map((e) => ({ ...e, acc: 0, age: 0, spent: false }));
    this.parent = null; // the particle this one follows
    this.at = [0, 0, 0];
    this.dead = false;
  }
  reuse() { this.dead = false; this.parent = null; for (const e of this.emitters) { e.acc = 0; e.age = 0; e.spent = false; } }
}

class System {
  constructor(layer, def, over, instances) {
    this.layer = layer;
    this.def = def;
    this.over = over || {};
    this.time = 0;
    this.instances = [];
    this.maxInstances = instances;
    this.pool = [];
    this.children = [];
    const o = this.over;
    this.maxEach = Math.max(1, Math.min(50000, Math.ceil(num(def.maxcount, 100) * num(o.count, 1))));
    const ropeTrail = def.renderer?.find((r) => r.name === "ropetrail");
    this.trailSegments = ropeTrail ? Math.max(2, Math.min(64, num(ropeTrail.segments, 16))) : 0;
    this.trailStep = ropeTrail ? num(ropeTrail.length, 1) / this.trailSegments : 0;
    this.trailFade = !!ropeTrail?.fadealpha;
    this.max = Math.min(60000, this.maxEach * instances * (this.trailSegments || 1));
    this.rateK = num(o.rate, 1);
    this.lifeK = num(o.lifetime, 1);
    this.sizeK = num(o.size, 1);
    this.speedK = num(o.speed, 1);
    this.alphaK = num(o.alpha, 1);
    this.tint = o.colorn !== undefined ? vec(o.colorn, [1, 1, 1]) : o.color !== undefined ? vec(o.color, [1, 1, 1]) : null;
    this.controls = (def.controlpoint || []).map((c) => ({ id: c.id ?? 0, offset: vec(c.offset), follow: !!((c.flags ?? 0) & 1) }));
    this.emitters = (def.emitter || []).map((e) => ({ d: e, rate: num(e.rate, 5), make: this.emitterShape(e), delay: num(e.delay, 0), duration: num(e.duration, 0) }));
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
    const signed = (v, i) => (sign[i] > 0 ? Math.abs(v) : sign[i] < 0 ? -Math.abs(v) : v);
    const launch = (p) => {
      const l = Math.hypot(...p.pos) || 1, sp = spd1 ? rnd(spd0, spd1) : 0;
      for (let i = 0; i < 3; i++) { p.vel[i] += (p.pos[i] / l) * sp; p.pos[i] += origin[i]; }
    };
    if (e.name === "boxrandom") {
      const lo = vec(e.distancemin), hi = vec(e.distancemax, [100, 100, 0]);
      return (p) => {
        for (let i = 0; i < 3; i++) p.pos[i] = signed(rnd(lo[i], hi[i]) * (Math.random() < 0.5 ? -1 : 1), i) * dirs[i];
        launch(p);
      };
    }
    const lo = num(e.distancemin, 0), hi = num(e.distancemax, 100);
    return (p) => {
      const r = randomDirection(), d = lerp(lo, hi, Math.cbrt(Math.random()));
      for (let i = 0; i < 3; i++) p.pos[i] = signed(r[i] * dirs[i] * d, i);
      launch(p);
    };
  }

  // How fast a control point moves, which only a cursor-following one does.
  pointVelocity(id) {
    const now = this.point(id), last = (this.lastPoints ||= {})[id] || now;
    this.lastPoints[id] = now;
    const dt = this.layer.scene.dt || 1 / 30;
    return [(now[0] - last[0]) / dt, (now[1] - last[1]) / dt, (now[2] - last[2]) / dt];
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

  newInstance(parent) {
    let inst = this.instances.find((i) => i.dead && !i.live.length);
    if (inst) inst.reuse();
    else if (this.instances.length < this.maxInstances) this.instances.push(inst = new Instance(this));
    else return null;
    inst.parent = parent;
    if (parent) inst.at = parent.pos.slice();
    return inst;
  }

  spawn(inst, em) {
    if (inst.live.length >= this.maxEach) return;
    const p = (this.pool.pop() || new Particle()).reset();
    em?.make(p);
    p.eventParent = inst.parent;
    for (const f of this.inits) f(p);
    p.lifetime *= this.lifeK;
    p.size0 *= this.sizeK; p.size = p.size0;
    p.alpha0 *= this.alphaK; p.alpha = p.alpha0;
    if (this.tint) { p.color0 = this.tint.map((v, i) => v * p.color0[i]); p.color = p.color0.slice(); }
    p.vel[0] *= this.speedK; p.vel[1] *= this.speedK; p.vel[2] *= this.speedK;
    inst.live.push(p);
    for (const c of this.children) if (c.type === "eventfollow" || c.type === "eventspawn") c.system.newInstance(this.placed(inst, p));
  }

  // The parent particle as a child sees it: position in this system's space, kept up to date.
  placed(inst, p) {
    p.inst = inst;
    return p;
  }

  emit(inst, dt) {
    for (const em of inst.emitters) {
      em.age += dt;
      if (em.age < em.delay) continue;
      if (em.duration && em.age - em.delay > em.duration) continue;
      const burst = num(em.d.instantaneous, 0);
      if (burst && !em.spent) {
        em.spent = true;
        // spawn() stops adding at maxEach, but a huge count would still loop that many times.
        const n = Math.min(burst, this.maxEach - inst.live.length);
        for (let i = 0; i < n; i++) this.spawn(inst, em);
      }
      em.acc += em.rate * this.rateK * dt;
      const n = Math.min(Math.floor(em.acc), this.maxEach);
      em.acc -= n;
      for (let i = 0; i < n; i++) this.spawn(inst, em);
    }
  }

  step(dt) {
    this.time += dt;
    if (!this.instances.length && this.type === "static") this.newInstance(null);
    for (const inst of this.instances) {
      const bound = inst.parent;
      if (bound) {
        if (bound.age >= bound.lifetime) {
          // Followers vanish with their particle; the others play out what they've emitted.
          if (this.type === "eventfollow") { this.pool.push(...inst.live); inst.live.length = 0; }
          inst.dead = true;
          inst.parent = null;
        } else {
          inst.at[0] = bound.pos[0] + bound.inst.at[0]; inst.at[1] = bound.pos[1] + bound.inst.at[1]; inst.at[2] = bound.pos[2] + bound.inst.at[2];
        }
      }
      if (!inst.dead) this.emit(inst, dt);
      if (this.type === "eventdeath") inst.dead = true;
      const live = inst.live;
      this.current = live;
      let n = 0;
      for (let i = 0; i < live.length; i++) {
        const p = live[i];
        p.age += dt;
        p.t = p.age / p.lifetime;
        if (p.t >= 1) {
          for (const c of this.children) {
            if (c.type !== "eventdeath") continue;
            const child = c.system.newInstance(null);
            if (child) child.at = [p.pos[0] + inst.at[0], p.pos[1] + inst.at[1], p.pos[2] + inst.at[2]];
          }
          this.pool.push(p);
          continue;
        }
        p.size = p.size0; p.alpha = p.alpha0;
        p.color[0] = p.color0[0]; p.color[1] = p.color0[1]; p.color[2] = p.color0[2];
        for (const op of this.ops) op(p, dt, this);
        if (this.trailSegments) {
          const h = p.history || (p.history = [p.pos.slice()]);
          p.since = (p.since || 0) + dt;
          if (p.since >= this.trailStep) {
            p.since = 0;
            h.push(p.pos.slice());
            if (h.length > this.trailSegments) h.shift();
          } else h[h.length - 1] = p.pos.slice();
        }
        live[n++] = p;
      }
      live.length = n;
    }
    for (const c of this.children) c.system.step(dt);
  }

  get count() { let n = 0; for (const i of this.instances) n += i.live.length; return n; }
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
    const gl = scene.gl, d = this.data, sys = this.sys, f = FLOATS;
    let o = 0, total = 0;
    for (const inst of sys.instances) for (let i = 0; i < inst.live.length && total < sys.max; i++, total++) {
      const p = inst.live[i], at = inst.at;
      const life = sys.randomFrame ? p.frame : (p.t * sys.seq) % 1;
      for (let c = 0; c < 4; c++) {
        d[o] = p.pos[0] + at[0]; d[o + 1] = p.pos[1] + at[1]; d[o + 2] = p.pos[2] + at[2];
        d[o + 3] = c & 1; d[o + 4] = c >> 1; d[o + 5] = p.rot[2]; d[o + 6] = p.size;
        d[o + 7] = p.color[0]; d[o + 8] = p.color[1]; d[o + 9] = p.color[2]; d[o + 10] = p.alpha;
        d[o + 11] = p.rot[0]; d[o + 12] = p.rot[1];
        d[o + 13] = p.vel[0]; d[o + 14] = p.vel[1]; d[o + 15] = p.vel[2]; d[o + 16] = life;
        o += f;
      }
    }
    this.flush(gl, o, total);
  }
  // A rope is a chain through the particles in spawn order. Each link is a sprite stretched between
  // two neighbours, which the trail path of the stock shader does given the gap as its velocity.
  drawRope(scene) {
    const gl = scene.gl, d = this.data, sys = this.sys, f = FLOATS;
    let o = 0, total = 0;
    for (const inst of sys.instances) {
      const list = inst.live, at = inst.at;
      for (let i = 0; i + 1 < list.length && total < sys.max; i++, total++) {
        const a = list[i], b = list[i + 1];
        const dx = b.pos[0] - a.pos[0], dy = b.pos[1] - a.pos[1], dz = b.pos[2] - a.pos[2];
        for (let c = 0; c < 4; c++) {
          d[o] = (a.pos[0] + b.pos[0]) / 2 + at[0]; d[o + 1] = (a.pos[1] + b.pos[1]) / 2 + at[1]; d[o + 2] = (a.pos[2] + b.pos[2]) / 2 + at[2];
          d[o + 3] = c & 1; d[o + 4] = c >> 1; d[o + 5] = 0; d[o + 6] = a.size;
          d[o + 7] = a.color[0]; d[o + 8] = a.color[1]; d[o + 9] = a.color[2]; d[o + 10] = a.alpha;
          d[o + 11] = 0; d[o + 12] = 0;
          d[o + 13] = dx; d[o + 14] = dy; d[o + 15] = dz; d[o + 16] = 0;
          o += f;
        }
      }
    }
    this.flush(gl, o, total);
  }
  // A ropetrail is the path each particle has travelled, drawn the same way as a rope.
  drawTrail(scene) {
    const gl = scene.gl, d = this.data, sys = this.sys, f = FLOATS;
    let o = 0, total = 0;
    for (const inst of sys.instances) {
      const at = inst.at;
      for (const p of inst.live) {
        const t = p.history;
        if (!t) continue;
        for (let i = 0; i + 1 < t.length && total < sys.max; i++, total++) {
          const a = t[i], b = t[i + 1], fade = sys.trailFade ? (i + 1) / t.length : 1;
          for (let c = 0; c < 4; c++) {
            d[o] = (a[0] + b[0]) / 2 + at[0]; d[o + 1] = (a[1] + b[1]) / 2 + at[1]; d[o + 2] = (a[2] + b[2]) / 2 + at[2];
            d[o + 3] = c & 1; d[o + 4] = c >> 1; d[o + 5] = 0; d[o + 6] = p.size;
            d[o + 7] = p.color[0]; d[o + 8] = p.color[1]; d[o + 9] = p.color[2]; d[o + 10] = p.alpha * fade;
            d[o + 11] = 0; d[o + 12] = 0;
            d[o + 13] = b[0] - a[0]; d[o + 14] = b[1] - a[1]; d[o + 15] = b[2] - a[2]; d[o + 16] = 0;
            o += f;
          }
        }
      }
    }
    this.flush(gl, o, total);
  }
  flush(gl, floats, count) {
    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buf);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.data, 0, floats);
    gl.drawElements(gl.TRIANGLES, count * 6, gl.UNSIGNED_INT, 0);
    gl.bindVertexArray(this.scene.quadVao);
  }
}

WE.ParticleLayer = class extends WE.LayerBase {
  async init() {
    const s = this.scene, d = this.data;
    this.draws = true;
    this.over = d.instanceoverride || {};
    const def = await s.assets.json(d.particle);
    if (!def) throw new Error(`particle ${d.particle} not found`);
    // The system file's flags: bit 2 places it in the 3D camera.
    if ((num(def.flags, 0) & 4) !== 0) this.perspective = true;
    this.parts = [];
    this.root = await this.addSystem(def, this.over, 1, "static", [d.particle]);
    // A saved start time means the scene opens as if it had been running that long.
    const warm = Math.min(5, num(def.starttime, 0));
    for (let t = 0; t < warm; t += 1 / 20) this.root.step(1 / 20);
  }
  // `chain` holds the files of the systems above this one, so a system that lists itself (or an
  // ancestor) as a child can't recurse forever, and nesting stops at MAX_CHILD_DEPTH.
  async addSystem(def, over, instances, type, chain = []) {
    const s = this.scene;
    const sys = new System(this, def, over, instances);
    sys.type = type;
    const mat = await s.assets.json(def.material);
    if (!mat) throw new Error(`material ${def.material} not found`);
    const pass = mat.passes[0], renderer = def.renderer?.[0]?.name || "sprite";
    const ropeTrail = renderer === "ropetrail";
    const rope = renderer === "rope" || ropeTrail;
    const trail = /trail/.test(renderer) || rope;
    const name = pass.textures?.[0];
    const tex = name ? await s.texture(name) : s.white;
    const combos = { ...(pass.combos || {}), GS_ENABLED: 0, THICKFORMAT: 1, TRAILRENDERER: trail ? 1 : 0 };
    if (tex.frames?.length) combos.SPRITESHEET = 1;
    const shader = pass.shader === "genericropeparticle" ? "genericparticle" : pass.shader;
    const p = await s.makePass(this, { ...pass, shader }, { combos }, null, null, tex);
    const r = def.renderer?.[0] || {};
    this.parts.push({
      sys, pass: p, tex, mesh: new Sprites(s, sys), rope, ropeTrail,
      // A rope link's "velocity" is the gap to its neighbour, so it stretches exactly that far.
      vars: rope ? [1 / Math.max(1, tex.height / tex.width), 1e9, 0, 0] : [num(r.length, 0.05), num(r.maxlength, 10), num(r.minlength, 0), 0],
      frame: tex.frames?.length ? [tex.frames[0].w / tex.texWidth, tex.frames[0].h / tex.texHeight, tex.frames.length, tex.height / tex.width] : [1, 1, 1, tex.height / tex.width],
    });
    for (const c of def.children || []) {
      if (chain.length >= MAX_CHILD_DEPTH || chain.includes(c.name) || (this.systemCount = (this.systemCount || 0) + 1) > MAX_SYSTEMS) {
        s.warnOnce(`particles "${this.name}": child system ${c.name} skipped (nested too deep, or loops)`);
        continue;
      }
      const child = await s.assets.json(c.name);
      if (!child) continue;
      const type = c.type || "static";
      // A child's maxcount is how many copies of it can run at once.
      const count = type === "static" ? 1 : Math.max(1, Math.min(2000, num(c.maxcount, 1)));
      const sub = await this.addSystem(child, over, count, type, [...chain, c.name]);
      sys.children.push({ system: sub, type });
    }
    return sys;
  }
  render() {
    if (!this.shown()) return;
    const s = this.scene, gl = s.gl, M = WE.M;
    this.root.step(Math.min(0.1, s.dt));
    const w = this.world();
    let m = M.translate(w.origin[0] - s.width / 2, s.height / 2 - w.origin[1], w.origin[2] || 0);
    if (w.angle) m = M.mul(m, M.rotateZ(-w.angle));
    if (this.perspective) m = M.mul(m, M.mul(M.rotateY(this.angles[1] || 0), M.rotateX(-(this.angles[0] || 0))));
    m = M.mul(m, M.scale(w.scale[0], -w.scale[1], w.scale[2] || 1));
    if (s.parallaxOn) {
      const dx = (this.parallaxDepth[0] + s.parallaxAmount) * s.parallax[0] * s.width, dy = (this.parallaxDepth[1] + s.parallaxAmount) * s.parallax[1] * s.width;
      m = M.mul(M.translate(dx, dy), m);
    }
    m = M.mul(this.camera(), m);
    gl.colorMask(true, true, true, false);
    for (const part of this.parts) {
      if (!part.sys.count) continue;
      s.drawPass(part.pass, s.sceneTarget, part.tex, null, {
        mvp: m, blend: part.pass.blending, layer: this,
        geometry: part.ropeTrail ? { draw: (scene) => part.mesh.drawTrail(scene) } : part.rope ? { draw: (scene) => part.mesh.drawRope(scene) } : part.mesh,
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
