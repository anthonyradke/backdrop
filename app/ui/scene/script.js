// SceneScript: the JavaScript wallpapers attach to properties. It's third-party code, so it never
// runs in the player page, which can reach the app's commands. Every script lives in a Worker and
// trades values with the renderer by message, one frame behind. The player page's CSP (in
// tauri.conf.json), which the Worker inherits, is what keeps it off the network; the runtime also
// removes the network APIs it can find. A script that hangs or throws costs the wallpaper that
// behaviour and nothing else.
"use strict";
var WE = window.WE || (window.WE = {});

// Runs inside the Worker, so it can't use anything from this file.
function scriptRuntime() {
  // Assigning undefined on self leaves the real one on a prototype, and getter-only properties
  // ignore assignment, so each is redefined wherever it lives along the chain.
  const blocked = ["fetch", "XMLHttpRequest", "WebSocket", "WebSocketStream", "EventSource", "Worker", "SharedWorker",
    "importScripts", "indexedDB", "caches", "BroadcastChannel", "WebTransport", "FontFace", "fonts"];
  for (let o = self; o; o = Object.getPrototypeOf(o)) {
    for (const k of blocked) {
      if (!Object.prototype.hasOwnProperty.call(o, k)) continue;
      try { Object.defineProperty(o, k, { value: undefined, writable: false, configurable: false }); } catch {}
    }
  }
  const scripts = [];
  const layers = new Map(); // id -> values
  const named = new Map();
  const writes = [];
  const shared = {};
  const audioBuffers = [];
  const last = { x: -1, y: -1, down: false };
  const store = new Map();
  const warn = (m) => postMessage({ type: "warn", message: String(m).slice(0, 300) });
  const console = { log() {}, info() {}, warn() {}, error() {}, debug() {} };
  self.console = console;

  const modules = {};
  // The script API keeps growing. A method this doesn't know does nothing, rather than throwing and
  // taking the rest of the script down with it.
  function tolerant(target) {
    return new Proxy(target, {
      get(t, k, r) {
        if (k in t || typeof k !== "string") return Reflect.get(t, k, r);
        return /^(get|set|is|has|sort|insert|remove|create|destroy|update|apply|enable|disable|show|hide)[A-Z]/.test(k) ? () => undefined : undefined;
      },
    });
  }
  const engine = tolerant({
    frametime: 0, runtime: 0, timeOfDay: 0, userProperties: {},
    canvasSize: null, screenResolution: null,
    isDesktopDevice: () => true, isMobileDevice: () => false, isTabletDevice: () => false,
    isWallpaper: () => true, isScreensaver: () => false,
    isPortrait: () => false, isLandscape: () => true,
    isRunningInEditor: () => false,
    getScreenResolution() { return this.screenResolution; },
    registerAudioBuffers(n) {
      const b = { left: new Float32Array(n || 16), right: new Float32Array(n || 16), average: new Float32Array(n || 16) };
      audioBuffers.push(b);
      return b;
    },
    registerAsset: (a) => a,
    setTimeout: (f, t) => setTimeout(f, t), clearTimeout: (t) => clearTimeout(t),
    setInterval: (f, t) => setInterval(f, t), clearInterval: (t) => clearInterval(t),
    openUserShortcut() {},
  });
  const input = { cursorWorldPosition: null, cursorScreenPosition: null, cursorLeftDown: false };
  const ops = [];
  let nextId = -1000;
  const timelines = new Map();
  // A keyframed property. It runs in the renderer; this mirrors enough state to answer questions.
  function timeline(info) {
    if (!info) return { play() {}, stop() {}, pause() {}, isPlaying: () => false, getFrame: () => 0, setFrame() {}, getFrameCount: () => 1, duration: 1, frameCount: 1, fps: 30, name: "", rate: 1 };
    if (timelines.has(info.id)) return timelines.get(info.id);
    const t = {
      playing: !!info.playing, at: 0, name: info.name, fps: info.fps, frameCount: info.length, duration: info.length / info.fps, rate: 1,
      play() { t.playing = true; ops.push(["play", info.id]); },
      pause() { t.playing = false; ops.push(["pause", info.id]); },
      stop() { t.playing = false; t.at = 0; ops.push(["stop", info.id]); },
      setFrame(f) { t.at = f / info.fps; ops.push(["seek", info.id, t.at]); },
      getFrame: () => t.at * info.fps,
      getFrameCount: () => info.length,
      isPlaying: () => t.playing,
    };
    timelines.set(info.id, t);
    return t;
  }
  // An animated texture's frames.
  function sheet(l) {
    if (l.sheet) return l.sheet;
    const frames = l.frames || 1;
    let at = 0, held = false;
    const hold = (f) => { at = f; held = true; ops.push(["frame", l.id, f]); };
    l.sheet = {
      frameCount: frames, rate: 1,
      setFrame: hold, getFrame: () => at, getFrameCount: () => frames,
      play() { held = false; ops.push(["frame", l.id, null]); }, stop() { hold(0); }, pause() { hold(at); },
      isPlaying: () => !held,
    };
    return l.sheet;
  }
  const vec3 = (v) => new self.Vec3(v[0] || 0, v[1] || 0, v[2] || 0);

  function layerProxy(id) {
    if (id == null || !layers.has(id)) return nullLayer;
    const l = layers.get(id);
    if (l.proxy) return l.proxy;
    const out = (k, v) => { writes.push([id, k, v]); };
    const list = (v) => (v && typeof v === "object" ? [v.x ?? v[0] ?? 0, v.y ?? v[1] ?? 0, v.z ?? v[2] ?? 0] : [+v || 0]);
    const p = tolerant({
      name: l.name, id,
      get origin() { return vec3(l.origin); },
      set origin(v) { l.origin = list(v); out("origin", l.origin); },
      get scale() { return vec3(l.scale); },
      set scale(v) { l.scale = list(v); out("scale", l.scale); },
      get angles() { return vec3(l.angles); },
      set angles(v) { l.angles = list(v); out("angles", l.angles); },
      get color() { return vec3(l.color); },
      set color(v) { l.color = list(v); out("color", l.color); },
      get alpha() { return l.alpha; },
      set alpha(v) { l.alpha = +v; out("alpha", [l.alpha]); },
      get brightness() { return l.brightness; },
      set brightness(v) { l.brightness = +v; out("brightness", [l.brightness]); },
      get visible() { return l.visible; },
      set visible(v) { l.visible = !!v; out("visible", [l.visible]); },
      get text() { return l.text; },
      set text(v) { l.text = String(v); out("text", [l.text]); },
      get pointsize() { return l.pointsize; },
      set pointsize(v) { l.pointsize = +v; out("pointsize", [l.pointsize]); },
      get size() { return new self.Vec2(l.size[0] || 0, l.size[1] || 0); },
      get parallaxDepth() { return new self.Vec2(0, 0); },
      getParent() { return layerProxy(l.parent); },
      getTextureAnimation: () => sheet(l),
      getAnimation: (name) => timeline((l.timelines || []).find((t) => !name || t.name === name)),
      getAnimationLayer: () => timeline(null),
      getEffect(name) {
        const known = (l.effects || []).find((e) => e === name) !== undefined;
        const fx = { get visible() { return !l.hiddenEffects?.has(name); }, set visible(v) { if (!known) return; (l.hiddenEffects ||= new Set())[v ? "delete" : "add"](name); ops.push(["effect", id, name, !!v]); }, getMaterial: () => ({}) };
        return fx;
      },
      getBoneCount: () => 0, getBoneTransform: () => null, setBoneTransform() {},
      play() {}, stop() {}, pause() {}, isPlaying: () => false,
    });
    l.proxy = p;
    return p;
  }
  const nullLayer = new Proxy({}, { get: (_, k) => (k === "origin" || k === "scale" || k === "angles" || k === "color" ? vec3([0, 0, 0]) : k === "getTextureAnimation" || k === "getAnimation" ? () => timeline(null) : undefined), set: () => true });

  const scene = tolerant({
    getLayer: (name) => (named.has(name) ? layerProxy(named.get(name)) : null),
    getLayerByID: (id) => (layers.has(id) ? layerProxy(id) : null),
    enumerateLayers: () => [...layers.keys()].map(layerProxy),
    getLayerCount: () => layers.size,
    // New layers are made by the renderer a moment later; until then they answer from their config.
    createLayer(config) {
      const c = typeof config === "string" ? { image: config } : { ...(config || {}) };
      const id = nextId--;
      const wire = {};
      for (const [k, v] of Object.entries(c)) wire[k] = v && typeof v === "object" && "x" in v ? ["x", "y", "z", "w"].filter((a) => a in v).map((a) => v[a]).join(" ") : v;
      const nums = (v, d) => (v == null ? d : String(v).trim().split(/\s+/).map(Number));
      layers.set(id, {
        id, name: c.name || "", parent: null, origin: nums(wire.origin, [0, 0, 0]), scale: nums(wire.scale, [1, 1, 1]), angles: nums(wire.angles, [0, 0, 0]),
        color: nums(wire.color, [1, 1, 1]), alpha: +(wire.alpha ?? 1), brightness: 1, visible: wire.visible !== false, size: nums(wire.size, [0, 0]), text: "", pointsize: 0, frames: 1, effects: [], timelines: [],
      });
      if (c.name && !named.has(c.name)) named.set(c.name, id);
      ops.push(["create", id, wire]);
      return layerProxy(id);
    },
    destroyLayer(layer) {
      const id = typeof layer === "object" ? layer?.id : layer;
      if (!layers.has(id)) return;
      layers.delete(id);
      ops.push(["destroy", id]);
    },
    getCameraTransforms: () => ({ eye: vec3([0, 0, 0]), center: vec3([0, 0, -1]), up: vec3([0, 1, 0]) }),
    setCameraTransforms() {},
    getInitialLayerConfig: () => ({}),
    get clearColor() { return vec3([0, 0, 0]); },
    set clearColor(v) {},
  });

  // Script properties in code are overridden by what the wallpaper's author saved for them.
  function propertiesBuilder(saved) {
    const values = {};
    const add = (d) => { values[d.name] = d.name in saved ? saved[d.name] : d.value; return b; };
    const b = { addSlider: add, addCheckbox: add, addText: add, addColor: add, addCombo: add, addDirectory: add, addFile: add, finish: () => values };
    return b;
  }

  // Turns an ES module into a function body that returns its exports.
  function compile(src, args) {
    const names = [];
    let body = src.replace(/^\s*import\s+\*\s+as\s+(\w+)\s+from\s+['"]([^'"]+)['"];?/gm, (_, n, m) => `const ${n} = __modules[${JSON.stringify(m.toLowerCase())}] || {};`)
      .replace(/^\s*import\s+\{([^}]*)\}\s+from\s+['"]([^'"]+)['"];?/gm, (_, list, m) => `const {${list.replace(/\bas\b/g, ":")}} = __modules[${JSON.stringify(m.toLowerCase())}] || {};`)
      .replace(/^(\s*)export\s+(?:default\s+)?(async\s+function\*?|function\*?|class)\s+(\w+)/gm, (_, s, kind, n) => { names.push(n); return `${s}${kind} ${n}`; })
      .replace(/^(\s*)export\s+(let|var|const)\s+(\w+)/gm, (_, s, kind, n) => { names.push(n); return `${s}${kind} ${n}`; });
    body += `\nreturn { ${names.join(", ")} };`;
    return new Function("__modules", ...args, body);
  }

  const keys = ["engine", "input", "shared", "localStorage", "console", "thisScene", "thisLayer", "thisObject", "createScriptProperties", "MediaPlaybackEvent"];
  const toWire = (v) => {
    if (v === undefined) return undefined;
    if (v && typeof v === "object") {
      if (!("x" in v)) return undefined;
      const list = "w" in v ? [v.x, v.y, v.z, v.w] : "z" in v ? [v.x, v.y, v.z] : [v.x, v.y];
      return list.every(Number.isFinite) ? list : undefined;
    }
    return typeof v === "number" && !Number.isFinite(v) ? undefined : v;
  };
  const fromWire = (v, kind) => {
    if (kind === "text" || !Array.isArray(v)) return Array.isArray(v) ? v[0] : v;
    if (v.length >= 3) return new self.Vec3(v[0], v[1], v[2]);
    if (v.length === 2) return new self.Vec2(v[0], v[1]);
    return v[0];
  };
  const store_ = {
    get: (k) => store.get(k), set: (k, v) => { store.set(k, v); }, delete: (k) => store.delete(k), clear: () => store.clear(),
    LOCATION_GLOBAL: 0, LOCATION_SCREEN: 1,
  };
  const guard = (s, f) => {
    try { return f(); } catch (e) {
      if (++s.errors > 5) s.off = true;
      if (s.errors === 1) warn(`script on ${s.label}: ${e.message}`);
    }
  };

  function setup(m) {
    new Function(`${m.classes}\nself.Vec2 = Vec2; self.Vec3 = Vec3; self.Vec4 = Vec4; if (typeof MediaPlaybackEvent !== "undefined") self.MediaPlaybackEvent = MediaPlaybackEvent; if (typeof Mat3 !== "undefined") self.Mat3 = Mat3; if (typeof Mat4 !== "undefined") self.Mat4 = Mat4;`)();
    self.MediaPlaybackEvent = self.MediaPlaybackEvent || { PLAYBACK_STOPPED: 0, PLAYBACK_PLAYING: 1, PLAYBACK_PAUSED: 2 };
    for (const [name, src] of Object.entries(m.modules)) {
      try { modules[name] = compile(src, [])(modules); } catch (e) { warn(`module ${name}: ${e.message}`); }
    }
    engine.canvasSize = new self.Vec2(m.width, m.height);
    engine.screenResolution = new self.Vec2(m.width, m.height);
    engine.userProperties = m.userProperties;
    input.cursorWorldPosition = vec3([0, 0, 0]);
    input.cursorScreenPosition = new self.Vec2(0, 0);
    for (const l of m.layers) {
      layers.set(l.id, l);
      if (l.name && !named.has(l.name)) named.set(l.name, l.id);
    }
    for (const d of m.scripts) {
      const s = { ...d, errors: 0, off: false, value: fromWire(d.value, d.kind) };
      const layer = layerProxy(d.owner);
      // Inside a property's script, thisObject.getAnimation() means that property's keyframes.
      const object = Object.create(layer, { getAnimation: { value: (name) => (name ? layer.getAnimation?.(name) : timeline(d.timeline)) } });
      try {
        const exports = compile(d.source, keys)(modules, engine, input, shared, store_, console, scene, layer, object, () => propertiesBuilder(d.properties), self.MediaPlaybackEvent);
        s.update = exports.update;
        s.exports = exports;
        exports.cursor = ["cursorEnter", "cursorLeave", "cursorMove", "cursorDown", "cursorUp", "cursorClick"].some((n) => exports[n]);
        scripts.push(s);
        if (exports.init) guard(s, () => { const r = exports.init(s.value); if (r !== undefined) s.value = r; });
        // Scripts set themselves up from the user's choices here, not only when one changes.
        if (exports.applyUserProperties) guard(s, () => exports.applyUserProperties({ ...m.userProperties }));
      } catch (e) {
        warn(`script on ${d.label}: ${e.message}`);
      }
    }
  }

  function tick(m) {
    engine.frametime = m.dt; engine.runtime = m.time; engine.timeOfDay = m.day;
    input.cursorWorldPosition.x = m.pointer[0] * engine.canvasSize.x;
    input.cursorWorldPosition.y = (1 - m.pointer[1]) * engine.canvasSize.y;
    input.cursorScreenPosition.x = m.pointer[0] * engine.canvasSize.x;
    input.cursorScreenPosition.y = m.pointer[1] * engine.canvasSize.y;
    const moved = m.pointer[0] !== last.x || m.pointer[1] !== last.y;
    const pressed = m.down && !last.down, released = !m.down && last.down;
    input.cursorLeftDown = m.down;
    last.x = m.pointer[0]; last.y = m.pointer[1]; last.down = m.down;
    const hits = new Set(m.hits);
    const event = () => ({ worldPosition: input.cursorWorldPosition, localPosition: input.cursorWorldPosition, position: input.cursorWorldPosition });
    for (const s of scripts) {
      if (s.off || !s.exports.cursor) continue;
      const e = s.exports, hit = s.owner == null || hits.has(s.owner);
      const fire = (name) => { if (e[name]) guard(s, () => e[name](event())); };
      if (hit && !s.over) fire("cursorEnter");
      if (!hit && s.over) fire("cursorLeave");
      s.over = hit;
      if (moved && (hit || s.held)) fire("cursorMove");
      if (pressed && hit) { s.held = true; fire("cursorDown"); }
      if (released && s.held) {
        s.held = false;
        fire("cursorUp");
        if (hit) fire("cursorClick");
      }
    }
    for (const b of audioBuffers) {
      const n = b.left.length, source = n >= 64 ? [m.audio[0], m.audio[1]] : n >= 32 ? [m.audio[2], m.audio[3]] : [m.audio[4], m.audio[5]];
      for (let i = 0; i < n; i++) {
        b.left[i] = source[0][i] ?? 0; b.right[i] = source[1][i] ?? 0;
        b.average[i] = (b.left[i] + b.right[i]) / 2;
      }
    }
    const results = [];
    for (const s of scripts) {
      if (s.off || !s.update) continue;
      guard(s, () => {
        const before = s.value;
        const r = s.update(s.value);
        if (r === undefined) return;
        s.value = r;
        const w = toWire(r);
        const changed = typeof w === "object" ? JSON.stringify(w) !== s.sent : w !== before || s.sent === undefined;
        if (w !== undefined && changed) { results.push([s.id, w]); s.sent = typeof w === "object" ? JSON.stringify(w) : w; }
      });
    }
    for (const [id, l] of timelines) if (l.playing) l.at += m.dt * l.rate;
    postMessage({ type: "frame", results, writes: writes.splice(0), ops: ops.splice(0) });
  }

  function media(m) {
    const event = { ...m.event };
    for (const k of ["primaryColor", "secondaryColor", "tertiaryColor", "textColor", "highContrastColor"]) if (event[k]) event[k] = vec3(event[k]);
    for (const s of scripts) if (!s.off && s.exports[m.kind]) guard(s, () => s.exports[m.kind](event));
  }

  onmessage = (e) => {
    if (e.data.type === "setup") setup(e.data);
    else if (e.data.type === "tick") tick(e.data);
    else if (e.data.type === "media") media(e.data);
  };
}

const CURSOR = /\bexport\s+function\s+cursor(Enter|Leave|Move|Down|Up|Click)\b/;

WE.addScript = function (scene, owner, key, v, out, timeline) {
  const list = scene.scripts || (scene.scripts = []);
  const saved = {};
  for (const [k, p] of Object.entries(v.scriptproperties || {})) saved[k] = scene.value(p);
  list.push({ id: list.length, owner, key, source: v.script, properties: saved, out, timeline });
  if (owner && CURSOR.test(v.script)) (scene.cursorLayers ||= new Set()).add(owner);
};

const timelineInfo = (t) => t && { id: t.id, name: t.name, fps: t.fps, length: t.length, playing: t.playing };

// Whether the cursor is over a layer, in the flipped, centered space layers are laid out in.
function underCursor(scene, l) {
  if (!l.rect || !l.shown()) return false;
  const w = l.world(), r = l.rect(w);
  let x = scene.pointer[0] * scene.width - scene.width / 2, y = scene.pointer[1] * scene.height - scene.height / 2;
  if (w.angle) {
    const cx = (r.x0 + r.x1) / 2, cy = (r.y0 + r.y1) / 2, c = Math.cos(w.angle), s = Math.sin(w.angle), dx = x - cx, dy = y - cy;
    x = cx + dx * c - dy * s; y = cy + dx * s + dy * c;
  }
  return x >= Math.min(r.x0, r.x1) && x <= Math.max(r.x0, r.x1) && y >= Math.min(r.y0, r.y1) && y <= Math.max(r.y0, r.y1);
}

// Everything scripts can see of a layer, as plain data for the Worker.
function layerData(l, scene) {
  return {
    id: l.id, name: l.name, parent: l.data.parent ?? null, origin: l.origin.slice(), scale: l.scale.slice(), angles: l.angles.slice(), color: l.color.slice(),
    alpha: l.alpha[0], brightness: l.brightness[0], visible: !!l.visible[0], size: [l.w || l.size[0] || 0, l.h || l.size[1] || 0],
    text: l.textValue ? String(l.textValue[0]) : "", pointsize: l.pointsize ? l.pointsize[0] : 0,
    frames: l.texture?.frames?.length || 1, effects: (l.effects || []).map((e) => e.name),
    timelines: scene.timelines.filter((t) => t.owner === l).map(timelineInfo),
  };
}

async function startScripts(scene) {
  const layerInfo = (l) => layerData(l, scene);
  const stock = scene.assets;
  const classes = await stock.text("scripts/jsclasses/baseclasses.js");
  if (!classes) { scene.warn("no script runtime in Wallpaper Engine's assets"); return; }
  const modules = {};
  // The script API keeps growing. A method this doesn't know does nothing, rather than throwing and
  // taking the rest of the script down with it.
  function tolerant(target) {
    return new Proxy(target, {
      get(t, k, r) {
        if (k in t || typeof k !== "string") return Reflect.get(t, k, r);
        return /^(get|set|is|has|sort|insert|remove|create|destroy|update|apply|enable|disable|show|hide)[A-Z]/.test(k) ? () => undefined : undefined;
      },
    });
  }
  for (const m of ["wemath", "wevector", "wecolor"]) {
    const t = await stock.text(`scripts/jsmodules/${m}.js`);
    if (t) modules[m] = t;
  }
  const url = URL.createObjectURL(new Blob([`(${scriptRuntime})();`], { type: "text/javascript" }));
  const worker = new Worker(url);
  URL.revokeObjectURL(url);
  const scripts = scene.scripts;
  scene.worker = worker;
  worker.onerror = (e) => scene.warn(`scripts: ${e.message}`);
  const props = {};
  for (const [k, p] of Object.entries(scene.userProps)) props[k] = p.value;
  worker.postMessage({
    type: "setup", classes, modules, width: scene.width, height: scene.height, userProperties: props,
    layers: scene.layers.map(layerInfo),
    scripts: scripts.map((s) => ({
      id: s.id, owner: s.owner?.id ?? null, kind: s.key, timeline: timelineInfo(s.timeline), label: `"${s.owner?.name ?? "scene"}" ${s.key ?? "value"}`, source: s.source, properties: s.properties,
      value: s.key === "text" ? String(s.out[0]) : s.out.length === 1 ? (typeof s.out[0] === "boolean" ? s.out[0] : s.out[0]) : s.out.slice(),
    })),
  });
  worker.onmessage = (e) => {
    const m = e.data;
    if (m.type === "warn") { scene.warnOnce(m.message); return; }
    if (m.type !== "frame") return;
    scene.scriptBusy = false;
    for (const [id, v] of m.results) {
      const out = scripts[id].out;
      if (Array.isArray(v)) for (let i = 0; i < v.length; i++) out[i] = v[i];
      else out[0] = v;
    }
    for (const [id, key, v] of m.writes) {
      const l = scene.byId.get(id);
      if (!l) continue;
      const field = key === "text" ? l.textValue : l[key];
      if (!Array.isArray(field)) continue;
      for (let i = 0; i < v.length; i++) if (typeof v[i] !== "number" || Number.isFinite(v[i])) field[i] = v[i];
    }
    for (const [op, id, a, b] of m.ops) {
      if (op === "frame") { const l = scene.byId.get(id); if (l) l.heldFrame = a; continue; }
      if (op === "create") { scene.addLayer({ ...a, id }); continue; }
      if (op === "destroy") { scene.removeLayer(id); continue; }
      if (op === "effect") {
        const fx = scene.byId.get(id)?.effects?.find((e) => e.name === a);
        if (fx) fx.visible[0] = b;
        continue;
      }
      const t = scene.timelines[id];
      if (!t) continue;
      if (op === "play") t.playing = true;
      else if (op === "pause") t.playing = false;
      else if (op === "stop") { t.playing = false; t.clock = 0; t.dirty = true; }
      else if (op === "seek") { t.clock = a; t.dirty = true; }
    }
  };
}

WE.startScripts = (scene) => (scene.scripts?.length ? startScripts(scene) : Promise.resolve());

WE.tickScripts = function (scene) {
  if (!scene.worker || scene.scriptBusy) return;
  scene.scriptBusy = true;
  scene.worker.postMessage({
    type: "tick", time: scene.time, dt: scene.dt, day: scene.daytime, pointer: scene.pointer, down: !!scene.pointerDown,
    hits: [...(scene.cursorLayers || [])].filter((l) => underCursor(scene, l)).map((l) => l.id),
    audio: [scene.audio64L, scene.audio64R, scene.audio32L, scene.audio32R, scene.audio16L, scene.audio16R],
  });
};

WE.stopScripts = function (scene) {
  scene.worker?.terminate();
  scene.worker = null;
};
