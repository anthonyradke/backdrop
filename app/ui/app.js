// Backdrop library window. Plain JS, no build step: render() builds HTML strings and morph()
// patches them into the page so nothing flashes on updates. Text goes through tr() (i18n.js).

const { invoke, convertFileSrc } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;
const appWindow = window.__TAURI__.window.getCurrentWindow();

const MEDIA = convertFileSrc("", "media");
const $ = (s) => document.querySelector(s);

const S = {
  tab: "library",
  filter: "all", // all | rotation
  query: "",
  sel: null, // selected item id (the library's hero falls back to what's showing)
  preview: null, // item id whose video plays in the hero
  tint: {}, // id -> [accent, ink] sampled from its thumbnail, or null for grey art
  state: null, // StateView from Rust
  thumbVer: {}, // id -> cache buster after a new thumbnail
  videoViaLoopback: false,
  // Workshop tab. view: discover | steam (what Steam already downloaded)
  ws: { view: "discover", sort: "week", genre: "", kind: "video", search: "", page: 1, items: null, more: false, loading: false, error: null, sel: null, open: false, seq: 0 },
};

// ---------- helpers ----------

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmtSize = (b) => (b >= 1e9 ? (b / 1e9).toFixed(1) + " GB" : b >= 1e6 ? (b / 1e6).toFixed(1) + " MB" : Math.max(1, Math.round(b / 1e3)) + " KB");
const fmtDate = (s) => new Date(s * 1000).toLocaleDateString(LANG === "zh-Hans" ? "zh-CN" : LANG, { year: "numeric", month: "short", day: "numeric" });
const mediaUrl = (path) => MEDIA + path.split("/").map(encodeURIComponent).join("/");
// Video goes through the loopback server once media:// has failed to play one (see loopback.rs).
const videoUrl = (path) =>
  (S.videoViaLoopback && S.state?.loopback ? S.state.loopback : MEDIA) + path.split("/").map(encodeURIComponent).join("/");
function mediaVideoFailed() {
  if (S.videoViaLoopback || !S.state?.loopback) return false;
  S.videoViaLoopback = true;
  render();
  return true;
}
const kindLabel = (e) => (e.kind === "web" ? "HTML" : e.file?.endsWith(".gif") ? "GIF" : e.kind === "video" ? tr("Video") : tr("Image"));
const trayName = () => tr("tray");
const CODEC = { h264: "H.264", hevc: "HEVC", av1: "AV1", vp9: "VP9", vp8: "VP8", prores: "ProRes", mpeg4: "MPEG-4" };
const codecName = (c) => CODEC[c] ?? String(c).toUpperCase();
const cantPlayHere = (e) => S.state?.platform === "windows" && ["hevc", "prores"].includes(e.codec);

// "4K", "1440p", "1080p", "720p" from the short side (so portrait video works too).
function resLabel(e) {
  if (!e.width || !e.height) return null;
  const long = Math.max(e.width, e.height), short = Math.min(e.width, e.height);
  if (long >= 7680) return "8K";
  if (long >= 5120) return "5K";
  if (long >= 3840 || short >= 2160) return "4K";
  if (short >= 1440) return "1440p";
  if (short >= 1080) return "1080p";
  if (short >= 720) return "720p";
  return null;
}

const ICON = {
  plus: '<svg viewBox="0 0 16 16"><path d="M8 3.2v9.6M3.2 8h9.6"/></svg>',
  folder: '<svg viewBox="0 0 16 16"><path d="M2 4.5A1.5 1.5 0 0 1 3.5 3h2.6l1.4 1.5h5A1.5 1.5 0 0 1 14 6v5.5a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 11.5z"/></svg>',
  cycle: '<svg viewBox="0 0 16 16"><path d="M13 5.5A5.5 5.5 0 0 0 3.2 6M3 10.5A5.5 5.5 0 0 0 12.8 10"/><path d="M13 2.5v3h-3M3 13.5v-3h3"/></svg>',
  search: '<svg viewBox="0 0 16 16"><circle cx="7" cy="7" r="4.4"/><path d="m10.4 10.4 3.1 3.1"/></svg>',
  play: '<svg class="fill" viewBox="0 0 16 16"><path d="M5 3.6v8.8l7-4.4z"/></svg>',
  stop: '<svg class="fill" viewBox="0 0 16 16"><rect x="4" y="4" width="8" height="8" rx="1.5"/></svg>',
  trash: '<svg viewBox="0 0 16 16"><path d="M3 4.6h10M6.4 4.6V3.2h3.2v1.4M4.4 4.6l.6 8a1.2 1.2 0 0 0 1.2 1.1h3.6a1.2 1.2 0 0 0 1.2-1.1l.6-8"/></svg>',
  download: '<svg viewBox="0 0 16 16"><path d="M8 2.5v7.5M5 7.2l3 3 3-3"/><path d="M2.8 11v1.2c0 .8.6 1.4 1.4 1.4h7.6c.8 0 1.4-.6 1.4-1.4V11"/></svg>',
  external: '<svg viewBox="0 0 16 16"><path d="M9 2.8h4.2V7M13 3 7.6 8.4"/><path d="M11.5 9.6v2.6c0 .7-.6 1.2-1.2 1.2H4c-.7 0-1.2-.5-1.2-1.2V5.9c0-.7.5-1.2 1.2-1.2h2.6"/></svg>',
  hide: '<svg viewBox="0 0 16 16"><path d="M2.5 2.5l11 11"/><path d="M6.6 4a6.8 6.8 0 0 1 7.2 4 7.4 7.4 0 0 1-1.6 2.2M10 11.6a6.8 6.8 0 0 1-7.8-3.6 7.6 7.6 0 0 1 2-2.6"/></svg>',
  hideUser: '<svg viewBox="0 0 16 16"><circle cx="6.5" cy="5.5" r="2.6"/><path d="M1.8 13.5c.5-2.4 2.4-3.8 4.7-3.8 1 0 1.9.3 2.6.8M10.5 10.5l3.5 3.5M14 10.5 10.5 14"/></svg>',
  close: '<svg viewBox="0 0 16 16"><path d="M4 4l8 8M12 4l-8 8"/></svg>',
  library: '<svg viewBox="0 0 16 16"><rect x="2.5" y="2.5" width="4.6" height="4.6" rx="1.2"/><rect x="8.9" y="2.5" width="4.6" height="4.6" rx="1.2"/><rect x="2.5" y="8.9" width="4.6" height="4.6" rx="1.2"/><rect x="8.9" y="8.9" width="4.6" height="4.6" rx="1.2"/></svg>',
};

function toast(text, bad = false) {
  const t = $("#toast");
  t.textContent = text;
  t.classList.toggle("bad", bad);
  t.classList.add("show");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.remove("show"), bad ? 4200 : 2400);
}

async function call(cmd, args, okText) {
  try {
    const r = await invoke(cmd, args);
    if (okText) toast(okText);
    return r;
  } catch (e) {
    toast(String(e), true);
    throw e;
  }
}

// ---------- DOM patching (from lightswitch) ----------

function morph(root, html) {
  const tpl = document.createElement("template");
  tpl.innerHTML = html;
  patchChildren(root, tpl.content);
}
function sameNode(a, b) {
  if (a.nodeType !== b.nodeType || a.nodeName !== b.nodeName) return false;
  return a.nodeType !== 1 || a.getAttribute("data-key") === b.getAttribute("data-key");
}
function patchChildren(parent, next) {
  const olds = [...parent.childNodes];
  const news = [...next.childNodes];
  news.forEach((n, i) => {
    const o = olds[i];
    if (!o) parent.appendChild(n);
    else if (!sameNode(o, n)) parent.replaceChild(n, o);
    else if (o.nodeType !== 1) {
      if (o.nodeValue !== n.nodeValue) o.nodeValue = n.nodeValue;
    } else {
      patchAttrs(o, n);
      // Media elements keep playing; don't rebuild their insides.
      if (o.tagName !== "VIDEO") patchChildren(o, n);
    }
  });
  for (let i = news.length; i < olds.length; i++) olds[i].remove();
}
function patchAttrs(o, n) {
  for (const { name } of [...o.attributes]) if (!n.hasAttribute(name)) o.removeAttribute(name);
  for (const { name, value } of [...n.attributes]) if (o.getAttribute(name) !== value) o.setAttribute(name, value);
  if (o.tagName === "INPUT" && o !== document.activeElement) {
    if (o.type === "checkbox") o.checked = n.hasAttribute("checked");
    else o.value = n.getAttribute("value") ?? "";
  }
}

// ---------- data ----------

function entries() {
  return [...(S.state?.items ?? [])].sort((a, b) => b.added - a.added || a.name.localeCompare(b.name));
}

const pool = () => S.state?.config.rotation.pool ?? [];
const inRotation = (id) => pool().includes(id);

function thumbUrl(e) {
  return e.thumb ? mediaUrl(`${e.id}/thumb.jpg`) + `?v=${S.thumbVer[e.id] ?? 0}` : null;
}

function liveOn(id) {
  return (S.state?.displays ?? []).filter((d) => d.item === id);
}

// ---------- thumbnails ----------
// Thumbnails come from a frame the webview decodes here, so there's no ffmpeg to ship. The same
// frame becomes poster.jpg, the 1280px still the library's hero shows instead of the full media.

const thumbQueue = new Set();
let thumbBusy = false;

function queueThumbs() {
  for (const it of S.state?.items ?? []) if (!it.poster && it.kind !== "web" && !thumbQueue.has(it.id) && !thumbFailed.has(it.id)) thumbQueue.add(it.id);
  pumpThumbs();
}
const thumbFailed = new Set();

async function pumpThumbs() {
  if (thumbBusy) return;
  const id = thumbQueue.values().next().value;
  if (!id) return;
  thumbQueue.delete(id);
  const it = S.state.items.find((i) => i.id === id);
  if (!it || it.poster) return pumpThumbs();
  thumbBusy = true;
  try {
    const src = (it.kind === "video" ? videoUrl : mediaUrl)(`${it.id}/${it.file}`);
    const { data, poster, width, height } = await grabFrame(src, it.kind).catch((e) => {
      // One retry over loopback if media:// can't decode video here.
      if (it.kind === "video" && mediaVideoFailed()) return grabFrame(videoUrl(`${it.id}/${it.file}`), it.kind);
      throw e;
    });
    await invoke("save_thumb", { id, data, poster, width, height });
    S.thumbVer[id] = Date.now();
  } catch (e) {
    console.warn("thumbnail failed", id, e);
    thumbFailed.add(id);
  }
  thumbBusy = false;
  pumpThumbs();
}

function grabFrame(src, kind) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); reject("timeout"); }, 15000);
    let el;
    const cleanup = () => { clearTimeout(timer); if (el?.tagName === "VIDEO") { el.removeAttribute("src"); el.load(); } };
    const jpeg = (w, h, W) => {
      const c = document.createElement("canvas");
      c.width = W; c.height = Math.round((W * h) / w) || Math.round((W * 9) / 16);
      c.getContext("2d").drawImage(el, 0, 0, c.width, c.height);
      return c.toDataURL("image/jpeg", 0.82);
    };
    const draw = (w, h) => {
      // A codec the webview can't decode still "seeks", just with no picture; don't save a black frame.
      if (!w || !h) { cleanup(); return reject("no picture"); }
      const data = jpeg(w, h, 480), poster = jpeg(w, h, Math.min(1280, w || 1280));
      cleanup();
      resolve({ data, poster, width: w, height: h });
    };
    if (kind === "video") {
      el = document.createElement("video");
      el.crossOrigin = "anonymous";
      el.muted = true;
      el.preload = "auto";
      el.onloadedmetadata = () => { el.currentTime = Math.min(1, (el.duration || 2) / 2); };
      el.onseeked = () => draw(el.videoWidth, el.videoHeight);
      el.onerror = () => { cleanup(); reject("can't decode this video here"); };
      el.src = src;
    } else {
      el = new Image();
      el.crossOrigin = "anonymous";
      el.onload = () => draw(el.naturalWidth, el.naturalHeight);
      el.onerror = () => { cleanup(); reject("can't decode this image here"); };
      el.src = src;
    }
  });
}

// ---------- actions ----------

async function importResult(r) {
  if (!r) return;
  if (r.ids.length) {
    S.sel = r.ids[r.ids.length - 1];
    toast(r.ids.length === 1 ? tr("Added to your library") : tr("Added {n} wallpapers", { n: r.ids.length }));
  }
  if (r.errors.length) toast(r.errors.join(" · "), true);
}

const setting = (patch) => call("update_settings", { patch });
const on = (el) => el.dataset.v === "1";

const actions = {
  tab: (el) => {
    S.tab = el.dataset.tab;
    render();
    if (S.tab === "workshop" && !S.ws.items) wsLoad();
  },
  wsView: (el) => { S.ws.view = el.dataset.v; S.ws.sel = null; S.ws.open = false; wsLoad(); },
  wsSort: (el) => { S.ws.sort = el.dataset.v; wsLoad(); },
  wsKind: (el) => { S.ws.kind = el.dataset.v; wsLoad(); },
  wsMore: () => wsLoad(true),
  wsRetry: () => wsLoad(),
  wsSelect: (el) => { S.ws.sel = el.dataset.id; S.ws.open = true; render(); },
  wsClose: () => { S.ws.open = false; render(); },
  wsSubscribe: async (el) => {
    el.disabled = true;
    try {
      const how = await call("workshop_subscribe", { id: el.dataset.id });
      toast(how === "background"
        ? tr("Downloading through Steam. Backdrop adds it to your library when it's done.")
        : tr("Opened in Steam. Subscribe there; Backdrop adds it once Steam has downloaded it."));
    } finally {
      el.disabled = false;
    }
  },
  wsOpenSteam: (el) => call("workshop_open_steam", { id: el.dataset.id }),
  wsOpen: (el) => call("workshop_open", { id: el.dataset.id }),
  wsAdd: async (el) => {
    el.disabled = true;
    toast(tr("Adding…"));
    try {
      S.sel = await call("workshop_add", { id: el.dataset.id }, tr("Added to your library"));
    } finally {
      el.disabled = false;
    }
  },
  wsHide: async (el) => {
    const creator = el.dataset.creator || null;
    await call("workshop_hide", { id: el.dataset.id, creator }, creator ? tr("Hid everything by this creator") : tr("Hidden"));
    S.ws.items = (S.ws.items ?? []).filter((i) => (creator ? i.creator !== creator : i.id !== el.dataset.id));
    if (!S.ws.items.some((i) => i.id === S.ws.sel)) { S.ws.sel = null; S.ws.open = false; }
    render();
  },
  wsUnhide: () => call("workshop_unhide_all", {}, tr("Hidden wallpapers will show again")),
  wsShow: (el) => { S.ws.open = false; S.tab = "library"; S.filter = "all"; S.query = ""; S.sel = el.dataset.item; S.preview = null; render(); },
  filter: (el) => { S.filter = el.dataset.f; render(); },
  pick: async (el) => importResult(await call("pick_files", { folder: el.dataset.folder === "1" })),
  select: (el) => { S.sel = el.dataset.id; S.preview = null; render(); },
  preview: (el) => { S.preview = S.preview === el.dataset.id ? null : el.dataset.id; render(); },
  setAll: async (el) => {
    await call("set_wallpaper", { id: el.dataset.id, display: null });
  },
  setOn: async (el) => {
    await call("set_wallpaper", { id: el.dataset.id, display: el.dataset.display });
  },
  rotation: (el) => call("set_in_rotation", { id: el.dataset.id, on: !inRotation(el.dataset.id) }),
  next: () => call("next_wallpaper"),
  remove: async (el) => {
    const e = entries().find((x) => x.id === el.dataset.id);
    if (!e || !confirm(tr('Remove "{name}" from your library? The file is deleted from the library folder.', { name: e.name }))) return;
    await call("delete_local", { id: e.id });
    if (S.sel === e.id) S.sel = null;
  },
  clearDisplay: (el) => call("clear_wallpaper", { display: el.dataset.display }),
  togglePause: () => call("set_paused", { paused: !S.state.paused }),
  fit: (el) => setting({ fit: el.dataset.v }),
  muted: (el) => setting({ muted: on(el) }),
  speed: (el) => setting({ speed: Number(el.dataset.v) }),
  shadeBar: (el) => setting({ shadeBar: on(el) }),
  stillFrame: (el) => setting({ stillFrame: on(el) }),
  pauseCovered: (el) => setting({ pauseCovered: on(el) }),
  pauseFocused: (el) => setting({ pauseFocused: on(el) }),
  pauseBattery: (el) => setting({ pauseBattery: on(el) }),
  pauseLowPower: (el) => setting({ pauseLowPower: on(el) }),
  pauseLocked: (el) => setting({ pauseLocked: on(el) }),
  rotMinutes: (el) => setting({ rotationMinutes: Number(el.dataset.v) }),
  rotOrder: (el) => setting({ rotationOrder: el.dataset.v }),
  rotPerDisplay: (el) => setting({ rotationPerDisplay: on(el) }),
  rotOnStart: (el) => setting({ rotationOnStart: on(el) }),
  rotOnWake: (el) => setting({ rotationOnWake: on(el) }),
  language: (el) => setting({ language: el.dataset.v }),
  autostart: (el) => call("set_autostart", { on: on(el) }),
  openDir: () => call("open_library_dir"),
  reset: async () => {
    if (!confirm(tr("Put every setting back to its default? Your library stays; wallpapers are cleared from the displays."))) return;
    await call("reset_settings", {}, tr("Settings reset"));
  },
};

document.addEventListener("click", (ev) => {
  const win = ev.target.closest("[data-win]");
  if (win) {
    const w = win.dataset.win;
    if (w === "min") appWindow.minimize();
    else if (w === "max") appWindow.toggleMaximize();
    else appWindow.close();
    return;
  }
  const el = ev.target.closest("[data-act]");
  if (!el || el.disabled) return;
  const fn = actions[el.dataset.act];
  if (fn) Promise.resolve(fn(el)).catch(() => {});
});

document.addEventListener("change", (ev) => {
  if (ev.target.id === "ws-genre") { S.ws.genre = ev.target.value; wsLoad(); }
});

document.addEventListener("input", (ev) => {
  if (ev.target.id === "search") { S.query = ev.target.value; render(); }
  if (ev.target.id === "volume") {
    clearTimeout(S.volTimer);
    const v = Number(ev.target.value) / 100;
    S.volTimer = setTimeout(() => setting({ volume: v }), 120);
  }
});

document.addEventListener("keydown", (ev) => {
  if (ev.target.id === "ws-search" && ev.key === "Enter") {
    S.ws.search = ev.target.value;
    wsLoad();
  } else if (ev.target.classList?.contains("name-in")) {
    if (ev.key === "Enter") ev.target.blur();
    if (ev.key === "Escape") { ev.target.value = ev.target.dataset.orig; ev.target.blur(); }
  } else if (ev.key === "Escape" && S.tab === "workshop" && S.ws.open) {
    S.ws.open = false;
    render();
  } else if (ev.key === "Escape" && S.sel) { S.sel = null; S.preview = null; render(); }
});

document.addEventListener("focusout", async (ev) => {
  const el = ev.target;
  if (!el.classList?.contains("name-in")) return;
  const name = el.value.trim();
  if (!name || name === el.dataset.orig) { el.value = el.dataset.orig; return; }
  const e = entries().find((x) => x.id === el.dataset.id);
  if (!e) return;
  try {
    await invoke("rename_item", { id: e.id, name });
  } catch (err) {
    toast(String(err), true);
  }
});

// ---------- render ----------

const REASON = {
  manual: "Paused",
  locked: "Paused (locked)",
  battery: "Paused (on battery)",
  lowPower: "Paused (low power)",
  covered: "Paused (covered)",
  focused: "Paused (app in front)",
};

// The window's fixed text (index.html) carries data-t / data-t-title with the English original.
function translateStatic() {
  for (const el of document.querySelectorAll("[data-t]")) el.textContent = tr(el.dataset.t);
  for (const el of document.querySelectorAll("[data-t-title]")) el.title = tr(el.dataset.tTitle);
  document.documentElement.lang = LANG;
}

function renderTitle() {
  const tabs = [["library", tr("Library")], ["workshop", tr("Workshop")], ["displays", tr("Displays")], ["settings", tr("Settings")]];
  morph($("#tabs"), tabs.map(([k, t]) => `<button class="nav-tab press ${S.tab === k ? "on" : ""}" data-act="tab" data-tab="${k}">${t}</button>`).join(""));
  const ds = S.state.displays;
  const anyPlaying = ds.some((d) => d.status === "playing");
  const paused = ds.filter((d) => d.status === "paused");
  let dot = "", text = "";
  if (S.state.paused) { dot = "paused"; text = tr("Paused"); }
  else if (anyPlaying) { dot = "playing"; text = paused.length ? tr("Partly paused") : tr("Live"); }
  else if (paused.length) { dot = "paused"; text = tr(REASON[paused[0].reason] ?? "Paused"); }
  else if (ds.some((d) => d.status === "image")) { dot = "image"; text = tr("Still image"); }
  else text = tr("No wallpaper");
  morph($("#live"), `<span class="dot ${dot}"></span>${esc(text)}`);
}

function placeholder(e, key = "") {
  const glyph = e.kind === "web" ? "&lt;/&gt;" : esc(kindLabel(e));
  return `<div class="ph ${e.kind}" ${key ? `data-key="${key}"` : ""}><span>${glyph}</span></div>`;
}

// ---------- tint ----------
// The accent follows the wallpaper in the hero: one pass over a 32×18 copy of its thumbnail, weighted
// toward saturated mid-tones, then pinned to a lightness that dark text reads on.

const tintBusy = new Set();
function tintOf(e) {
  if (!e) return null;
  if (e.id in S.tint) return S.tint[e.id];
  const src = thumbUrl(e);
  if (src && !tintBusy.has(e.id)) {
    tintBusy.add(e.id);
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => { S.tint[e.id] = sampleTint(img); tintBusy.delete(e.id); render(); };
    img.onerror = () => { S.tint[e.id] = null; tintBusy.delete(e.id); };
    img.src = src;
  }
  return null;
}
function sampleTint(img) {
  const c = document.createElement("canvas");
  c.width = 32; c.height = 18;
  const g = c.getContext("2d", { willReadFrequently: true });
  g.drawImage(img, 0, 0, 32, 18);
  const d = g.getImageData(0, 0, 32, 18).data;
  let x = 0, y = 0, sat = 0, sum = 0;
  for (let i = 0; i < d.length; i += 4) {
    const r = d[i] / 255, gr = d[i + 1] / 255, b = d[i + 2] / 255;
    const max = Math.max(r, gr, b), min = Math.min(r, gr, b), ch = max - min, l = (max + min) / 2;
    if (ch < 0.05) continue;
    const s = ch / (1 - Math.abs(2 * l - 1));
    const h = (max === r ? ((gr - b) / ch + 6) % 6 : max === gr ? (b - r) / ch + 2 : (r - gr) / ch + 4) * (Math.PI / 3);
    const w = s * ch * (1 - Math.abs(l - 0.55));
    x += Math.cos(h) * w; y += Math.sin(h) * w; sat += s * w; sum += w;
  }
  if (sum < 3) return null; // grey art keeps the neutral accent
  const hue = Math.round(((Math.atan2(y, x) * 180) / Math.PI + 360) % 360);
  const s = Math.round(Math.min(0.85, Math.max(0.45, sat / sum)) * 100);
  return [`hsl(${hue} ${s}% 68%)`, `hsl(${hue} 45% 11%)`];
}
function applyTint(e) {
  const t = tintOf(e), root = document.documentElement.style;
  if (t) { root.setProperty("--tint", t[0]); root.setProperty("--tint-ink", t[1]); }
  else { root.removeProperty("--tint"); root.removeProperty("--tint-ink"); }
}

// ---------- library ----------

const posterUrl = (e) => (e.poster ? mediaUrl(`${e.id}/poster.jpg`) + `?v=${S.thumbVer[e.id] ?? 0}` : thumbUrl(e));
// What the hero shows: the pick, else what the main display is showing, else the newest.
function heroItem() {
  const all = entries();
  const live = (S.state.displays.find((d) => d.primary && d.item) ?? S.state.displays.find((d) => d.item))?.item;
  return all.find((e) => e.id === S.sel) ?? all.find((e) => e.id === live) ?? all[0] ?? null;
}

const FILTERS = {
  all: [() => true, "All"],
  live: [(e) => liveOn(e.id).length > 0, "Live"],
  rotation: [(e) => inRotation(e.id), "Rotation"],
  video: [(e) => e.kind === "video", "Videos"],
  image: [(e) => e.kind === "image", "Images"],
  web: [(e) => e.kind === "web", "HTML"],
};

function tileHtml(e, sel) {
  const t = thumbUrl(e);
  const live = liveOn(e.id);
  const res = resLabel(e);
  return `<button class="tile ${sel ? "sel" : ""}" data-act="select" data-id="${e.id}" data-key="t-${e.id}">
    <div class="thumb">
      ${t ? `<img src="${esc(t)}" loading="lazy" draggable="false" onerror="this.remove()">` : placeholder(e)}
      ${live.length ? `<span class="pill tl"><span class="dot ${live[0].status}"></span>${live.length > 1 ? esc(tr("{n} displays", { n: live.length })) : esc(live[0].name)}</span>` : ""}
      ${res ? `<span class="pill br">${res}</span>` : ""}
    </div>
    <div class="t-name">${esc(e.name)}</div>
    <div class="t-meta">${inRotation(e.id) ? `<span title="${esc(tr("In rotation"))}">${ICON.cycle}</span>` : ""}<span>${esc(kindLabel(e))} · ${fmtSize(e.size)}</span></div>
  </button>`;
}

function heroHtml(e) {
  const live = liveOn(e.id);
  const displays = S.state.displays;
  const rot = inRotation(e.id);
  const src = posterUrl(e);
  const type = e.kind === "web" ? tr("HTML page") : kindLabel(e) === "GIF" ? tr("Animated GIF") : e.kind === "video" ? tr("Video") : tr("Image");
  const meta = [
    type,
    e.width ? `${e.width} × ${e.height}${resLabel(e) ? ` · ${resLabel(e)}` : ""}` : null,
    e.codec ? codecName(e.codec) : null,
    e.fps ? `${Math.round(e.fps * 100) / 100} fps` : null,
    fmtSize(e.size),
    `${tr("Added")} ${fmtDate(e.added)}`,
  ].filter(Boolean).join("  ·  ");
  const canPreview = e.kind === "video" && !cantPlayHere(e);
  const previewing = canPreview && S.preview === e.id;
  const icon = (title, act, svg, extra = "") => `<button class="btn round press ${extra}" data-act="${act}" data-id="${e.id}" title="${esc(title)}" aria-label="${esc(title)}">${svg}</button>`;

  return `<section class="hero" data-key="hero">
    ${src ? `<img class="hero-img" data-key="hi-${e.id}" src="${esc(src)}" draggable="false" onerror="this.remove()">` : placeholder(e, `hp-${e.id}`)}
    ${previewing ? `<video class="hero-video" data-key="hv-${e.id}-${S.videoViaLoopback ? "l" : "m"}" src="${esc(videoUrl(`${e.id}/${e.file}`))}" autoplay muted loop playsinline onerror="mediaVideoFailed()"></video>` : ""}
    <div class="hero-info" data-key="hn-${e.id}">
      <div class="kick">${live.length
        ? `<span class="dot ${live[0].status}"></span>${esc(tr("Showing on {names}", { names: live.map((d) => d.name).join(", ") }))}`
        : `${ICON.library}${tr("In your library")}`}</div>
      <input class="name-in" data-id="${e.id}" data-orig="${esc(e.name)}" value="${esc(e.name)}" spellcheck="false" title="${esc(tr("Rename"))}">
      <div class="hero-meta">${esc(meta)}</div>
      ${cantPlayHere(e) ? `<div class="warn">${tr("Windows can't play {codec} video. Convert it to H.264 (HandBrake works) and add that instead.", { codec: codecName(e.codec) })}</div>` : ""}
      <div class="hero-acts">
        <button class="btn pri big press" data-act="setAll" data-id="${e.id}">${ICON.play}${displays.length > 1 ? tr("Set on all displays") : tr("Set as wallpaper")}</button>
        ${displays.length > 1 ? `<div class="where">${displays.map((d) => `<button class="press ${d.item === e.id ? "on" : ""}" data-act="setOn" data-id="${e.id}" data-display="${esc(d.key)}" title="${esc(tr("Only {name}", { name: d.name }))}">${esc(d.name)}</button>`).join("")}</div>` : ""}
        ${canPreview ? icon(previewing ? tr("Stop preview") : tr("Preview"), "preview", previewing ? ICON.stop : ICON.play, previewing ? "on" : "") : ""}
        ${icon(rot ? tr("In rotation (click to remove)") : tr("Add to rotation"), "rotation", ICON.cycle, rot ? "on" : "")}
        ${icon(tr("Remove from the library"), "remove", ICON.trash)}
      </div>
    </div>
  </section>`;
}

function renderLibrary() {
  const all = entries();
  if (!all.length) {
    return `<div class="page" data-key="p-library-empty">
      <section class="hero welcome"><div class="hero-info">
        <div class="hero-title">${tr("Your library is empty")}</div>
        <p>${tr("Drop videos (MP4, WebM, MOV), images, GIFs or HTML wallpapers anywhere in this window.")}</p>
        <div class="hero-acts"><button class="btn pri big press" data-act="pick" data-folder="0">${ICON.plus}${tr("Add files")}</button>
          <button class="btn big press" data-act="pick" data-folder="1">${ICON.folder}${tr("Add an HTML folder")}</button></div>
      </div></section></div>`;
  }
  const hero = heroItem();
  const q = S.query.trim().toLowerCase();
  const match = FILTERS[S.filter] ?? FILTERS.all;
  const shown = all.filter((e) => match[0](e) && (!q || e.name.toLowerCase().includes(q)));
  const chips = Object.entries(FILTERS)
    .map(([k, [f, label]]) => [k, label, all.filter(f).length])
    .filter(([k, , n]) => k === "all" || k === S.filter || n);

  return `<div class="page" data-key="p-library">
    ${heroHtml(hero)}
    <section class="shelf">
      <div class="bar">
        ${chips.map(([k, label, n]) => `<button class="chip press ${S.filter === k ? "on" : ""}" data-act="filter" data-f="${k}">${tr(label)}<span class="n tnum">${n}</span></button>`).join("")}
        <span class="sp"></span>
        <label class="search">${ICON.search}<input id="search" placeholder="${esc(tr("Search"))}" value="${esc(S.query)}" spellcheck="false"></label>
        <button class="btn sm press" data-act="pick" data-folder="0">${ICON.plus}${tr("Add files")}</button>
        <button class="btn sm round press" data-act="pick" data-folder="1" title="${esc(tr("Add HTML folder"))}" aria-label="${esc(tr("Add HTML folder"))}">${ICON.folder}</button>
      </div>
      <div class="grid-wrap">${shown.length ? `<div class="grid">${shown.map((e) => tileHtml(e, e.id === hero.id)).join("")}</div>` : `<div class="empty">${tr("Nothing matches.")}</div>`}</div>
    </section>
  </div>`;
}

// ---------- workshop ----------
// Wallpaper Engine's Steam Workshop, minus anime (the filtering is in workshop.rs). Steam does the
// downloading; Backdrop imports what it downloads.

async function wsLoad(more = false) {
  const w = S.ws;
  const seq = ++w.seq;
  w.page = more ? w.page + 1 : 1;
  if (!more) { w.items = null; w.more = false; }
  w.loading = true;
  w.error = null;
  render();
  try {
    let items = [], hasMore = false;
    if (w.view === "steam") {
      items = await invoke("workshop_subscribed");
    } else {
      // The filters can leave a page nearly empty, so keep going until there's a screenful.
      for (let tries = 0; tries < 4; tries++) {
        const r = await invoke("workshop_browse", { query: { sort: w.sort, genre: w.genre, kind: w.kind, search: w.search, page: w.page } });
        if (seq !== w.seq) return;
        items.push(...r.items);
        hasMore = r.more;
        if (!hasMore || items.length >= 12) break;
        w.page++;
      }
    }
    if (seq !== w.seq) return;
    const seen = new Set((more ? w.items ?? [] : []).map((i) => i.id));
    w.items = [...(more ? w.items ?? [] : []), ...items.filter((i) => !seen.has(i.id))];
    w.more = hasMore;
  } catch (e) {
    if (seq !== w.seq) return;
    w.error = String(e);
    if (more) w.page--;
  }
  w.loading = false;
  render();
}

// Steam resizes previews on request, which keeps a grid of animated GIFs light.
const wsThumb = (url, w = 480) =>
  url.includes("steamusercontent.com") ? url + `?imw=${w}&imh=${Math.round((w * 9) / 16)}&ima=fit&impolicy=Letterbox&letterbox=false` : url;
const wsLib = (id) => S.state.workshop.inLibrary[id];
const wsPending = (id) => S.state.workshop.pending.includes(id);
// Whole percent of a download Backdrop is running through Steam, or null.
function wsPercent(id) {
  const p = S.state.workshop.progress?.[id];
  return p ? (p[1] ? Math.floor((p[0] * 100) / p[1]) : 0) : null;
}
const wsWaiting = (id) => (wsPercent(id) !== null ? tr("Downloading {p}%", { p: wsPercent(id) }) : tr("Waiting for Steam"));
const wsKindLabel = (i) => (i.kind === "web" ? "HTML" : tr("Video"));
// "3840 x 2160" -> resLabel's "4K"; odd tags like "Ultrawide 3440 x 1440" still parse.
function wsRes(i) {
  const m = i.resolution?.match(/(\d+)\s*x\s*(\d+)/);
  return m ? resLabel({ width: +m[1], height: +m[2] }) : null;
}

function wsTileHtml(i, sel) {
  const lib = wsLib(i.id);
  const res = wsRes(i);
  const state = lib ? tr("In your library") : wsPending(i.id) ? wsWaiting(i.id) : "";
  return `<button class="tile ${sel ? "sel" : ""}" data-act="wsSelect" data-id="${i.id}" data-key="w-${i.id}">
    <div class="thumb">
      ${i.preview ? `<img src="${esc(wsThumb(i.preview))}" loading="lazy" draggable="false" onerror="this.remove()">` : `<div class="ph ${i.kind}"><span>${i.kind === "web" ? "&lt;/&gt;" : esc(wsKindLabel(i))}</span></div>`}
      ${state ? `<span class="pill tl"><span class="dot ${lib ? "playing" : "paused"}"></span>${esc(state)}</span>` : ""}
      ${res ? `<span class="pill br">${res}</span>` : ""}
    </div>
    <div class="t-name">${esc(i.title)}</div>
    <div class="t-meta"><span>${esc([i.genres.map(tr).join(", "), i.size ? fmtSize(i.size) : null].filter(Boolean).join(" · "))}</span></div>
  </button>`;
}

// What the grid area says when there's nothing to show yet.
function wsEmptyHtml() {
  const w = S.ws;
  if (w.error) return `<div class="empty"><h2>${tr("Couldn't reach Steam")}</h2>${esc(w.error)}
    <div class="acts"><button class="btn pri press" data-act="wsRetry">${tr("Try again")}</button></div></div>`;
  return `<div class="empty">${w.items ? (w.view === "discover" ? tr("Nothing matches.") : tr("Steam hasn't downloaded any video or HTML wallpapers for Wallpaper Engine.")) : tr("Loading…")}</div>`;
}

// Clicking a tile opens this popup: the whole preview, uncropped, with the details and actions under it.
// The tile's small image sits underneath so something shows while the large one loads.
function wsModalHtml(i) {
  const w = S.ws;
  const lib = wsLib(i.id);
  const pending = wsPending(i.id);
  const icon = (title, act, svg, extra = "") => `<button class="btn round press" data-act="${act}" data-id="${i.id}" ${extra} title="${esc(title)}" aria-label="${esc(title)}">${svg}</button>`;
  let acts;
  if (lib) acts = `<button class="btn pri big press" data-act="wsShow" data-item="${lib}">${ICON.library}${tr("Show in the library")}</button>`;
  else if (w.view === "steam") acts = `<button class="btn pri big press" data-act="wsAdd" data-id="${i.id}">${ICON.plus}${tr("Add to library")}</button>`;
  else if (pending) acts = `<button class="btn pri big press" disabled>${ICON.download}${esc(wsWaiting(i.id))}</button>
      <button class="btn big press" data-act="wsOpenSteam" data-id="${i.id}">${tr("Open in Steam")}</button>`;
  else acts = `<button class="btn pri big press" data-act="wsSubscribe" data-id="${i.id}">${ICON.download}${tr("Download")}</button>`;
  if (!lib && w.view !== "steam") acts += `<button class="btn big press" data-act="wsAdd" data-id="${i.id}">${tr("Already downloaded? Add it now")}</button>`;
  const meta = [
    i.kind === "web" ? tr("HTML page") : tr("Video"),
    i.resolution ? `${i.resolution}${wsRes(i) ? ` · ${wsRes(i)}` : ""}` : null,
    i.size ? fmtSize(i.size) : null,
    tr("{n} subscribers", { n: i.subscriptions.toLocaleString() }),
  ].filter(Boolean).join("  ·  ");
  const kick = lib ? tr("In your library") : pending ? wsWaiting(i.id) : i.genres.map(tr).join(", ");
  const desc = i.description.replace(/\[[^\]]*\]/g, "").trim();
  return `<div class="modal" data-key="ws-modal">
    <div class="scrim" data-act="wsClose"></div>
    <div class="dialog" role="dialog" aria-modal="true" aria-label="${esc(i.title)}" data-key="wm-${i.id}">
      <div class="dlg-media">
        ${i.preview ? `<img class="lo" src="${esc(wsThumb(i.preview))}" draggable="false" onerror="this.remove()">
          <img class="hi" src="${esc(wsThumb(i.preview, 1920))}" draggable="false" onerror="this.remove()">`
          : `<div class="ph ${i.kind}"><span>${i.kind === "web" ? "&lt;/&gt;" : esc(wsKindLabel(i))}</span></div>`}
        <button class="btn round press dlg-x" data-act="wsClose" title="${esc(tr("Close"))}" aria-label="${esc(tr("Close"))}">${ICON.close}</button>
      </div>
      <div class="dlg-info">
        <div class="kick">${lib || pending ? `<span class="dot ${lib ? "playing" : "paused"}"></span>` : ""}${esc(kick)}</div>
        <div class="hero-title" title="${esc(i.title)}">${esc(i.title)}</div>
        <div class="hero-meta">${esc(meta)}</div>
        ${desc ? `<div class="dlg-desc">${esc(desc)}</div>` : ""}
        <div class="hero-acts">${acts}
          <span class="sp"></span>
          ${icon(tr("Open the workshop page"), "wsOpen", ICON.external)}
          ${icon(tr("Hide this wallpaper"), "wsHide", ICON.hide)}
          ${i.creator ? icon(tr("Hide everything by this creator"), "wsHide", ICON.hideUser, `data-creator="${esc(i.creator)}"`) : ""}
        </div>
      </div>
    </div>
  </div>`;
}

function renderWorkshop() {
  const w = S.ws;
  const discover = w.view === "discover";
  const items = w.items ?? [];
  const sel = items.find((i) => i.id === w.sel) ?? null;
  const views = [["discover", tr("Discover")], ["steam", tr("Downloaded in Steam")]];
  const genres = [["", tr("All genres")], ...S.state.workshop.genres.map((g) => [g, tr(g)])];
  const sorts = [["week", tr("Trending")], ["month", tr("Top this month")], ["year", tr("Top this year")], ["allTime", tr("Most subscribed")], ["newest", tr("Newest")]];

  const grid = items.length
    ? `<div class="grid">${items.map((i) => wsTileHtml(i, i.id === sel?.id)).join("")}</div>
      ${w.more || (w.loading && items.length) ? `<div class="more"><button class="btn sm press" data-act="wsMore" ${w.loading ? "disabled" : ""}>${w.loading ? tr("Loading…") : tr("Load more")}</button></div>` : ""}`
    : wsEmptyHtml();
  const note = S.state.workshop.steam ? "" :
    `<div class="warn ws-warn">${tr("Steam's Wallpaper Engine folder wasn't found. You can browse, but subscribing only downloads anything if Steam is installed and you own Wallpaper Engine (it has to stay installed; it doesn't have to run).")}</div>`;

  return `<div class="page" data-key="p-workshop">
    <header class="head"><h1>${tr("Workshop")}</h1>
      <p>${tr("Video and HTML wallpapers from the Wallpaper Engine Steam Workshop. Click one to preview it.")}</p></header>
    <section class="shelf">
      <div class="bar">
        ${views.map(([k, t]) => `<button class="chip press ${w.view === k ? "on" : ""}" data-act="wsView" data-v="${k}">${t}</button>`).join("")}
        <span class="sp"></span>
        ${discover ? `<label class="search">${ICON.search}<input id="ws-search" placeholder="${esc(tr("Search, then Enter"))}" value="${esc(w.search)}" spellcheck="false"></label>
        <select id="ws-genre" class="select">${genres.map(([v, t]) => `<option value="${esc(v)}" ${w.genre === v ? "selected" : ""}>${esc(t)}</option>`).join("")}</select>` : ""}
      </div>
      ${discover ? `<div class="bar sub">${sorts.map(([v, t]) => `<button class="chip press ${w.sort === v ? "on" : ""}" data-act="wsSort" data-v="${v}">${t}</button>`).join("")}
        <span class="sp"></span>${seg("wsKind", w.kind, [["video", tr("Video")], ["web", "HTML"]])}</div>` : ""}
      ${note}
      <div class="grid-wrap">${grid}</div>
    </section>
    ${sel && w.open ? wsModalHtml(sel) : ""}
  </div>`;
}

function renderDisplays() {
  const ds = S.state.displays;
  const byId = new Map(entries().map((e) => [e.id, e]));
  let map = "";
  if (ds.length) {
    const minX = Math.min(...ds.map((d) => d.x)), minY = Math.min(...ds.map((d) => d.y));
    const maxX = Math.max(...ds.map((d) => d.x + d.width)), maxY = Math.max(...ds.map((d) => d.y + d.height));
    // Screens are placed in percent so the map grows with the window (CSS caps its size).
    const w = maxX - minX, h = maxY - minY;
    const pct = (v, of, px) => `calc(${(v / of * 100).toFixed(3)}% ${px < 0 ? "-" : "+"} ${Math.abs(px)}px)`;
    map = `<div class="arrangement" style="--ratio:${(w / h).toFixed(4)}">${ds.map((d) => {
      const e = d.item && byId.get(d.item);
      const t = e && posterUrl(e);
      return `<div class="screen" style="left:${pct(d.x - minX, w, 3)};top:${pct(d.y - minY, h, 3)};width:${pct(d.width, w, -6)};height:${pct(d.height, h, -6)};${t ? `background-image:url('${t}')` : ""}">
        <span class="pill"><span class="dot ${d.status}"></span>${esc(d.name)}${d.primary ? ` · ${tr("main")}` : ""}</span></div>`;
    }).join("")}</div>`;
  }
  const status = (d) =>
    d.status === "playing" ? tr("Playing")
    : d.status === "paused" ? tr(REASON[d.reason] ?? "Paused")
    : d.status === "image" ? tr("Still image (set as the system wallpaper)")
    : tr("Nothing set");
  const rows = ds.map((d) => {
    const e = d.item && byId.get(d.item);
    const t = e && thumbUrl(e);
    return `<div class="drow">
      <div><h3>${esc(d.name)}</h3><div class="sub">${d.width}×${d.height}${d.scale !== 1 ? ` · ${Math.round(d.scale * 100)}%` : ""}${d.primary ? ` · ${tr("main display")}` : ""}</div></div>
      <div class="now">${e ? (t ? `<img src="${esc(t)}" draggable="false">` : placeholder(e)) : ""}<div class="what"><div>${e ? esc(e.name) : ""}</div><div class="hint">${esc(status(d))}</div></div></div>
      <div>${d.item ? `<button class="btn sm press" data-act="clearDisplay" data-display="${esc(d.key)}">${tr("Clear")}</button>` : ""}</div>
    </div>`;
  }).join("");
  return `<div class="page" data-key="p-displays">
    <header class="head"><h1>${tr("Displays")}</h1>
      <p>${tr("Choose wallpapers in the Library. Still images are handed to {os} as the normal wallpaper, so they cost nothing to show. Videos and HTML play behind your desktop icons and pause when they're covered.", { os: "Windows" })}</p></header>
    <div class="scroll">${map}${rows || `<div class="muted">${tr("No displays found.")}</div>`}</div>
  </div>`;
}

function seg(act, cur, opts) {
  return `<div class="seg">${opts.map(([v, t]) => `<button class="press ${String(cur) === v ? "on" : ""}" data-act="${act}" data-v="${v}">${t}</button>`).join("")}</div>`;
}
// A switch sends the value it flips to, so the on(el) handlers stay as they were.
const offOn = (act, v) => `<button class="sw press ${v ? "on" : ""}" data-act="${act}" data-v="${v ? "0" : "1"}" role="switch" aria-checked="${!!v}"></button>`;
const row = (what, hint, control) =>
  `<div class="set-row"><div class="what">${what}${hint ? `<div class="hint">${hint}</div>` : ""}</div>${control}</div>`;
const section = (title, sub, rows) => `<div class="sec"><div><h3>${title}</h3>${sub ? `<p>${sub}</p>` : ""}</div><div>${rows}</div></div>`;

function renderSettings() {
  const c = S.state.config;
  const r = c.rotation;
  const bar = tr("taskbar");
  const poolHint = r.pool.length
    ? tr("Rotates through the {n} wallpapers marked for rotation in the Library.", { n: r.pool.length })
    : tr("Rotates through every wallpaper on this computer. Mark some with Add to rotation in the Library to narrow it down.");
  const speeds = [["0.5", "0.5×"], ["0.75", "0.75×"], ["1", "1×"], ["1.25", "1.25×"], ["1.5", "1.5×"], ["2", "2×"]];
  const langs = [["", tr("System")], ["en", "English"], ["es", "Español"], ["de", "Deutsch"], ["zh-Hans", "简体中文"]];
  const hidden = S.state.workshop.hidden.items.length + S.state.workshop.hidden.creators.length;

  return `<div class="page" data-key="p-settings">
    <header class="head"><h1>${tr("Settings")}</h1>
      <p>${tr("Backdrop {version}. Closing this window keeps wallpapers running; quit from the {tray} icon.", { version: esc(S.state.version), tray: trayName() })}</p></header>
    <div class="scroll"><div class="secs">
    ${section(tr("Playback"), "", [
      row(tr("Fit"), tr("How wallpapers that don't match the screen's shape are scaled."),
        seg("fit", c.fit, [["cover", tr("Fill")], ["contain", tr("Fit")], ["height", tr("Fit height")], ["stretch", tr("Stretch")], ["center", tr("Center")]])),
      row(tr("Speed"), tr("Playback speed for videos."), seg("speed", String(c.speed), speeds)),
      `<div class="set-row"><div class="what">${tr("Sound")}<div class="hint">${tr("Videos and HTML wallpapers with audio.")}</div></div>
        ${c.muted ? "" : `<input id="volume" type="range" min="0" max="100" value="${Math.round(c.volume * 100)}">`}
        ${seg("muted", c.muted ? "1" : "0", [["1", tr("Muted")], ["0", tr("On")]])}</div>`,
      row(tr("Shade the {bar}", { bar }), tr("Darkens a strip of moving wallpapers under the {bar} so it stays readable.", { bar }), offOn("shadeBar", c.shadeBar)),
      row(tr("Match the system wallpaper"), tr("Sets a still frame of each moving wallpaper as the Windows wallpaper, so the desktop matches before Backdrop starts."), offOn("stillFrame", c.stillFrame)),
    ].join(""))}
    ${section(tr("Rotation"), poolHint, [
      row(tr("Change wallpaper"), "",
        seg("rotMinutes", r.minutes, [["0", tr("Never")], ["15", tr("15 min")], ["30", tr("30 min")], ["60", tr("1 hour")], ["180", tr("3 hours")], ["1440", tr("1 day")]])),
      row(tr("Order"), "", seg("rotOrder", r.order, [["sequential", tr("In order")], ["shuffle", tr("Shuffle")]])),
      S.state.displays.length > 1 ? row(tr("Displays"), "", seg("rotPerDisplay", r.perDisplay ? "1" : "0", [["0", tr("Same on all")], ["1", tr("Different on each")]])) : "",
      row(tr("Random at startup"), tr("Picks a random wallpaper each time Backdrop starts."), offOn("rotOnStart", r.onStart)),
      row(tr("Random after waking"), tr("Picks a random wallpaper when the computer wakes from sleep, for example when you open the lid."), offOn("rotOnWake", r.onWake)),
      row(tr("Next wallpaper"), tr("Also in the {tray} menu.", { tray: trayName() }), `<button class="btn sm press" data-act="next">${ICON.cycle}${tr("Next")}</button>`),
    ].join(""))}
    ${section(tr("Saving power"), "", [
      row(tr("Pause when covered"), tr("Stops a wallpaper while a maximized or fullscreen app hides it."), offOn("pauseCovered", c.pauseCovered)),
      row(tr("Pause when an app is in front"), tr("Plays only while the desktop has focus on that display."), offOn("pauseFocused", c.pauseFocused)),
      row(tr("Pause on battery"), "", offOn("pauseBattery", c.pauseBattery)),
      row(tr("Pause with battery saver on"), "", offOn("pauseLowPower", c.pauseLowPower)),
      row(tr("Pause when locked"), "", offOn("pauseLocked", c.pauseLocked)),
    ].join(""))}
    ${section(tr("App"), "", [
      row(tr("Language"), "", seg("language", c.language, langs)),
      row(tr("Start at login"), tr("Starts in the {tray} without opening this window.", { tray: trayName() }), offOn("autostart", S.state.autostart)),
      row(tr("Library folder"), `<span class="mono">${esc(S.state.libraryDir)}</span>`, `<button class="btn sm press" data-act="openDir">${tr("Open")}</button>`),
      hidden ? row(tr("Hidden in the Workshop"), tr("{n} hidden (single wallpapers and creators).", { n: hidden }), `<button class="btn sm press" data-act="wsUnhide">${tr("Show again")}</button>`) : "",
      row(tr("Reset settings"), tr("Keeps your library."), `<button class="btn sm danger press" data-act="reset">${tr("Reset")}</button>`),
    ].join(""))}
    </div></div>
  </div>`;
}

function render() {
  if (!S.state) return;
  renderTitle();
  const html = S.tab === "displays" ? renderDisplays() : S.tab === "settings" ? renderSettings() : S.tab === "workshop" ? renderWorkshop() : renderLibrary();
  // Workshop art is remote (no canvas access), so it keeps the neutral accent.
  applyTint(S.tab === "workshop" ? null : S.tab === "library" ? heroItem() : entries().find((e) => liveOn(e.id).length));
  morph($("#page"), html);
  syncScroll();
}

// Scrolling the grid shrinks the hero toward a compact bar so the grid gets the room, and near the
// bottom of the Workshop the next page loads without a click.
const HERO_MIN = 230;
function syncScroll() {
  const page = $("#page");
  const wrap = page.querySelector(".grid-wrap");
  const full = Math.min(560, Math.max(260, innerHeight * 0.52));
  const range = Math.max(0, full - HERO_MIN);
  const shrink = wrap && page.querySelector(".hero:not(.welcome)") ? Math.min(wrap.scrollTop, range) : 0;
  page.style.setProperty("--shrink", `${shrink}px`);
  page.style.setProperty("--c", range ? (shrink / range).toFixed(3) : 0);
  const w = S.ws;
  if (wrap && S.tab === "workshop" && w.items?.length && w.more && !w.loading && !w.error
      && wrap.scrollHeight - wrap.scrollTop - wrap.clientHeight < 500) wsLoad(true);
}
document.addEventListener("scroll", (e) => { if (e.target.classList?.contains("grid-wrap")) syncScroll(); }, true);
addEventListener("resize", syncScroll);

// ---------- events ----------

function setLang(lang) {
  if (lang === LANG) return;
  LANG = lang;
  translateStatic();
}

listen("state", (e) => {
  S.state = e.payload;
  setLang(S.state.lang);
  queueThumbs();
  render();
});

listen("tauri://drag-enter", () => $("#drop").classList.add("on"));
listen("tauri://drag-leave", () => $("#drop").classList.remove("on"));
listen("tauri://drag-drop", async (e) => {
  $("#drop").classList.remove("on");
  const paths = e.payload?.paths ?? [];
  if (!paths.length) return;
  toast(paths.length === 1 ? tr("Adding…") : tr("Adding {n} items…", { n: paths.length }));
  importResult(await call("import_paths", { paths }));
});

(async () => {
  S.state = await invoke("get_state");
  document.body.classList.add("os-" + S.state.platform);
  LANG = S.state.lang;
  translateStatic();
  render();
  queueThumbs();
})();
