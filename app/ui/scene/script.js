// SceneScript: the JavaScript wallpapers attach to properties. It's third-party code, so it never
// runs in the player page, which can reach the app's commands. Every script lives in a Worker
// without network access and trades values with the renderer by message, one frame behind. A
// script that hangs or throws costs the wallpaper that behaviour and nothing else.
"use strict";
var WE = window.WE || (window.WE = {});

// Runs inside the Worker, so it can't use anything from this file.
function scriptRuntime() {
  for (const k of ["fetch", "XMLHttpRequest", "WebSocket", "EventSource", "Worker", "SharedWorker", "importScripts", "indexedDB", "caches", "BroadcastChannel", "WebTransport"]) {
    try { self[k] = undefined; } catch {}
  }
  const scripts = [];
  const layers = new Map(); // id -> values
  const named = new Map();
  const writes = [];
  const shared = {};
  const audioBuffers = [];
  const store = new Map();
  const warn = (m) => postMessage({ type: "warn", message: String(m).slice(0, 300) });
  const console = { log() {}, info() {}, warn() {}, error() {}, debug() {} };
  self.console = console;

  const modules = {};
  const engine = {
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
  };
  const input = { cursorWorldPosition: null, cursorScreenPosition: null, cursorLeftDown: false };
  const timeline = () => ({
    play() {}, stop() {}, pause() {}, isPlaying: () => false, getFrame: () => 0, setFrame() {},
    getFrameCount: () => 1, duration: 1, frameCount: 1, fps: 30, name: "", rate: 1,
  });
  const vec3 = (v) => new self.Vec3(v[0] || 0, v[1] || 0, v[2] || 0);

  function layerProxy(id) {
    if (id == null || !layers.has(id)) return nullLayer;
    const l = layers.get(id);
    if (l.proxy) return l.proxy;
    const out = (k, v) => { writes.push([id, k, v]); };
    const list = (v) => (v && typeof v === "object" ? [v.x ?? v[0] ?? 0, v.y ?? v[1] ?? 0, v.z ?? v[2] ?? 0] : [+v || 0]);
    const p = {
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
      getTextureAnimation: timeline, getAnimation: timeline, getAnimationLayer: timeline,
      getEffect: () => ({ visible: true, getMaterial: () => ({}) }),
      getBoneCount: () => 0, getBoneTransform: () => null, setBoneTransform() {},
      play() {}, stop() {}, pause() {}, isPlaying: () => false,
    };
    l.proxy = p;
    return p;
  }
  const nullLayer = new Proxy({}, { get: (_, k) => (k === "origin" || k === "scale" || k === "angles" || k === "color" ? vec3([0, 0, 0]) : k === "getTextureAnimation" || k === "getAnimation" ? timeline : undefined), set: () => true });

  const scene = {
    getLayer: (name) => (named.has(name) ? layerProxy(named.get(name)) : null),
    getLayerByID: (id) => (layers.has(id) ? layerProxy(id) : null),
    enumerateLayers: () => [...layers.keys()].map(layerProxy),
    getLayerCount: () => layers.size,
    createLayer: () => null, destroyLayer() {},
    getCameraTransforms: () => ({ eye: vec3([0, 0, 0]), center: vec3([0, 0, -1]), up: vec3([0, 1, 0]) }),
    setCameraTransforms() {},
    getInitialLayerConfig: () => ({}),
    get clearColor() { return vec3([0, 0, 0]); },
    set clearColor(v) {},
  };

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
      try {
        const exports = compile(d.source, keys)(modules, engine, input, shared, store_, console, scene, layer, layer, () => propertiesBuilder(d.properties), self.MediaPlaybackEvent);
        s.update = exports.update;
        s.exports = exports;
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
    postMessage({ type: "frame", results, writes: writes.splice(0) });
  }

  onmessage = (e) => {
    if (e.data.type === "setup") setup(e.data);
    else if (e.data.type === "tick") tick(e.data);
  };
}

WE.addScript = function (scene, owner, key, v, out) {
  const list = scene.scripts || (scene.scripts = []);
  const saved = {};
  for (const [k, p] of Object.entries(v.scriptproperties || {})) saved[k] = scene.value(p);
  list.push({ id: list.length, owner, key, source: v.script, properties: saved, out });
};

// Everything scripts can see of a layer, as plain data for the Worker.
function layerData(l) {
  return {
    id: l.id, name: l.name, parent: l.data.parent ?? null, origin: l.origin.slice(), scale: l.scale.slice(), angles: l.angles.slice(), color: l.color.slice(),
    alpha: l.alpha[0], brightness: l.brightness[0], visible: !!l.visible[0], size: [l.w || l.size[0] || 0, l.h || l.size[1] || 0],
    text: l.textValue ? String(l.textValue[0]) : "", pointsize: l.pointsize ? l.pointsize[0] : 0,
  };
}

async function startScripts(scene) {
  const stock = scene.assets;
  const classes = await stock.text("scripts/jsclasses/baseclasses.js");
  if (!classes) { scene.warn("no script runtime in Wallpaper Engine's assets"); return; }
  const modules = {};
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
    layers: scene.layers.map(layerData),
    scripts: scripts.map((s) => ({
      id: s.id, owner: s.owner?.id ?? null, kind: s.key, label: `"${s.owner?.name ?? "scene"}" ${s.key ?? "value"}`, source: s.source, properties: s.properties,
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
  };
}

WE.startScripts = (scene) => (scene.scripts?.length ? startScripts(scene) : Promise.resolve());

WE.tickScripts = function (scene) {
  if (!scene.worker || scene.scriptBusy) return;
  scene.scriptBusy = true;
  scene.worker.postMessage({
    type: "tick", time: scene.time, dt: scene.dt, day: scene.daytime, pointer: scene.pointer,
    audio: [scene.audio64L, scene.audio64R, scene.audio32L, scene.audio32R, scene.audio16L, scene.audio16R],
  });
};

WE.stopScripts = function (scene) {
  scene.worker?.terminate();
  scene.worker = null;
};
