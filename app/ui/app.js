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
  sel: null, // selected item id (the library's sidebar falls back to what's showing)
  preview: null, // item id whose video plays in the sidebar
  picking: false, // library select mode, for acting on many wallpapers at once
  picked: new Set(), // ids ticked in select mode
  anchor: null, // last tile clicked, where a shift-click range starts
  state: null, // StateView from Rust
  upd: null, // update::Status from Rust
  thumbVer: {}, // id -> cache buster after a new thumbnail
  videoViaLoopback: false,
  props: {}, // item id -> its properties from project.json (item_properties), or "none"
  // Workshop tab. view: discover | steam (what Steam already downloaded)
  ws: { view: "discover", sort: "week", genre: "", kind: "all", search: "", page: 1, items: null, more: false, loading: false, error: null, sel: null, open: false, seq: 0 },
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
const kindLabel = (e) => (e.kind === "web" ? "HTML" : e.kind === "scene" ? tr("Scene") : e.file?.endsWith(".gif") ? "GIF" : e.kind === "video" ? tr("Video") : tr("Image"));
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
  update: '<svg viewBox="0 0 16 16"><path d="M13.2 8A5.2 5.2 0 1 1 11.6 4.3"/><path d="M12.2 1.9v2.8H9.4"/></svg>',
  check: '<svg viewBox="0 0 16 16"><path d="m3.5 8.4 3 3 6-6.4"/></svg>',
  workshop: '<svg viewBox="0 0 16 16"><path d="M2.6 6.2 3.6 3h8.8l1 3.2"/><path d="M2.6 6.2a1.8 1.8 0 0 0 3.6 0 1.8 1.8 0 0 0 3.6 0 1.8 1.8 0 0 0 3.6 0"/><path d="M3.4 7.9V13h9.2V7.9M6.6 13v-2.8h2.8V13"/></svg>',
  monitor: '<svg viewBox="0 0 16 16"><rect x="1.9" y="2.6" width="12.2" height="8.4" rx="1.4"/><path d="M5.6 13.6h4.8M8 11v2.6"/></svg>',
  settings: '<svg viewBox="0 0 16 16"><path d="M6.8 1.9h2.4l.4 1.7 1.3.7 1.6-.6 1.2 2-1.3 1.2v1.6l1.3 1.2-1.2 2-1.6-.6-1.3.7-.4 1.7H6.8l-.4-1.7-1.3-.7-1.6.6-1.2-2 1.3-1.2V7.1L2.3 5.9l1.2-2 1.6.6 1.3-.7z"/><circle cx="8" cy="8" r="2"/></svg>',
  pause: '<svg viewBox="0 0 16 16"><path d="M5.5 3.5v9M10.5 3.5v9"/></svg>',
  resume: '<svg viewBox="0 0 16 16"><path d="M5 3.4v9.2l7.2-4.6z"/></svg>',
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
const displayPool = (key) => S.state?.config.rotation.displayPools?.[key] ?? [];
// Each display's own rotation list only matters with a different wallpaper on each display.
const perDisplayLists = () => S.state.displays.length > 1 && S.state.config.rotation.perDisplay && !spanned();
const inRotation = (id) => pool().includes(id);
const spanned = () => S.state?.config.span ?? null;

function thumbUrl(e) {
  return e.thumb ? mediaUrl(`${e.id}/thumb.jpg`) + `?v=${S.thumbVer[e.id] ?? 0}` : null;
}

function liveOn(id) {
  return (S.state?.displays ?? []).filter((d) => d.item === id);
}

// ---------- thumbnails ----------
// Thumbnails come from a frame the webview decodes here, so there's no ffmpeg to ship. The same
// frame becomes poster.jpg, the 1280px still the library's sidebar shows instead of the full media.

const thumbQueue = new Set();
let thumbBusy = false;

function queueThumbs() {
  for (const it of S.state?.items ?? []) if (!it.poster && (it.kind !== "web") && (it.kind !== "scene" || it.preview) && !thumbQueue.has(it.id) && !thumbFailed.has(it.id)) thumbQueue.add(it.id);
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
    const src = (it.kind === "video" ? videoUrl : mediaUrl)(`${it.id}/${it.kind === "scene" ? it.preview : it.file}`);
    const { data, poster, width, height } = await grabFrame(src, it.kind === "scene" ? "image" : it.kind).catch((e) => {
      // One retry over loopback if media:// can't decode video here.
      if (it.kind === "video" && mediaVideoFailed()) return grabFrame(videoUrl(`${it.id}/${it.file}`), it.kind);
      throw e;
    });
    // A scene's picture is only a preview of it, so its size says nothing about the wallpaper.
    const known = it.kind === "scene" ? {} : { width, height };
    await invoke("save_thumb", { id, data, poster, ...known });
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
  // The title bar's update button: installs a waiting update, otherwise checks GitHub now.
  update: async () => {
    const u = S.upd;
    if (!u || u.progress != null || u.checking) return;
    if (u.available) {
      try {
        await invoke("install_update");
      } catch (e) {
        toast(tr("Update failed: {e}", { e: String(e) }), true);
      }
      return;
    }
    S.upd = { ...u, checking: true };
    render();
    S.upd = await invoke("check_update");
    render();
    if (S.upd.available) toast(tr("Backdrop {v} is available", { v: S.upd.available }));
    else if (S.upd.error) toast(tr("Couldn't check for updates: {e}", { e: S.upd.error }), true);
    else toast(tr("Backdrop is up to date"));
  },
  tab: (el) => {
    S.tab = el.dataset.tab;
    render();
    if (S.tab === "workshop" && !S.ws.items) wsLoad();
  },
  wsView: (el) => { S.ws.view = el.dataset.v; S.ws.sel = null; S.ws.open = false; wsLoad(); },
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
  wsShow: (el) => { S.ws.open = false; S.tab = "library"; S.filter = "all"; S.query = ""; S.sel = el.dataset.item; S.preview = null; leavePicking(); render(); },
  filter: (el) => { S.filter = el.dataset.v; prunePicks(); render(); },
  showItem: (el) => {
    S.tab = el.dataset.item ? "library" : "displays";
    if (el.dataset.item) { S.sel = el.dataset.item; S.filter = "all"; S.query = ""; S.preview = null; leavePicking(); }
    render();
  },
  pick: async (el) => importResult(await call("pick_files", { folder: el.dataset.folder === "1" })),
  select: (el, ev) => {
    const id = el.dataset.id;
    if (ev?.shiftKey && S.anchor) pickRange(S.anchor, id);
    else if (S.picking || ev?.ctrlKey || ev?.metaKey) { S.picking = true; togglePick(id); S.anchor = id; }
    else { S.sel = id; S.preview = null; S.anchor = id; }
    render();
  },
  pickMode: () => { if (S.picking) leavePicking(); else S.picking = true; render(); },
  pickAll: () => { for (const e of shownEntries()) S.picked.add(e.id); S.picking = true; render(); },
  pickNone: () => { S.picked.clear(); render(); },
  pickRotation: (el) => call("set_in_rotation", { ids: pickedIds(), on: el.dataset.on === "1" },
    el.dataset.on === "1" ? tr("Added to rotation") : tr("Taken out of rotation")),
  pickDelete: async () => {
    const ids = pickedIds();
    if (!ids.length || !confirm(tr("Delete {n} wallpapers from your library? Their files are deleted from the library folder.", { n: ids.length }))) return;
    await call("delete_items", { ids }, tr("Deleted {n} wallpapers", { n: ids.length }));
    leavePicking();
    if (ids.includes(S.sel)) S.sel = null;
    render();
  },
  propBool: (el) => {
    const it = S.state.items.find((i) => i.id === el.dataset.id);
    const d = S.props[el.dataset.id];
    const v = it?.properties?.[el.dataset.k] ?? d?.properties?.[el.dataset.k]?.value;
    return setProp(el.dataset.id, el.dataset.k, !(v === true || v === "true" || v === 1));
  },
  propReset: (el) => call("set_item_properties", { id: el.dataset.id, values: {}, reset: true }),
  preview: (el) => { S.preview = S.preview === el.dataset.id ? null : el.dataset.id; render(); },
  setAll: async (el) => {
    await call("set_wallpaper", { id: el.dataset.id, display: null });
  },
  setOn: async (el) => {
    await call("set_wallpaper", { id: el.dataset.id, display: el.dataset.display });
  },
  setSpan: (el) => call("span_wallpaper", { id: el.dataset.id }),
  rotation: (el) => call("set_in_rotation", { ids: [el.dataset.id], on: !inRotation(el.dataset.id) }),
  displayRotation: (el) => call("set_in_display_rotation", { ids: [el.dataset.id], display: el.dataset.display, on: !displayPool(el.dataset.display).includes(el.dataset.id) }),
  schedAdd: () => {
    const sel = heroItem()?.id ?? S.state.items[0]?.id;
    if (!sel) return;
    const now = new Date();
    return saveSchedule([...schedule(), { at: (now.getHours() + 1) % 24 * 60, item: sel, display: null }]);
  },
  convert: (el) => call("convert_video", { id: el.dataset.id }),
  appRuleAdd: () => {
    const name = $("#app-new")?.value.trim().toLowerCase();
    if (!name) return;
    const exe = name.endsWith(".exe") ? name : `${name}.exe`;
    return saveRules([...appRules().filter((r) => r.exe !== exe), { exe, action: "pause" }]);
  },
  appRuleAction: (el) => saveRules(appRules().map((r, i) => (i === Number(el.dataset.i) ? { ...r, action: el.dataset.v } : r))),
  appRuleRemove: (el) => saveRules(appRules().filter((_, i) => i !== Number(el.dataset.i))),
  schedRemove: (el) => saveSchedule(schedule().filter((_, i) => i !== Number(el.dataset.i))),
  next: () => call("next_wallpaper"),
  remove: async (el) => {
    const e = entries().find((x) => x.id === el.dataset.id);
    if (!e || !confirm(tr('Remove "{name}" from your library? The file is deleted from the library folder.', { name: e.name }))) return;
    await call("delete_items", { ids: [e.id] });
    if (S.sel === e.id) S.sel = null;
  },
  clearDisplay: (el) => call("clear_wallpaper", { display: el.dataset.display ?? null }),
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
  workshopUpdates: (el) => setting({ workshopUpdates: on(el) }),
  autostart: (el) => call("set_autostart", { on: on(el) }),
  openDir: () => call("open_library_dir"),
  tour: () => startTour(),
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
  if (fn) Promise.resolve(fn(el, ev)).catch(() => {});
});

document.addEventListener("change", (ev) => {
  const sch = ev.target.closest?.(".sched-in");
  if (sch) {
    const slots = schedule().map((s) => ({ ...s }));
    const slot = slots[Number(sch.dataset.i)];
    if (!slot) return;
    if (sch.dataset.f === "at") {
      const [h, m] = sch.value.split(":").map(Number);
      if (!Number.isFinite(h) || !Number.isFinite(m)) return;
      slot.at = h * 60 + m;
    } else if (sch.dataset.f === "item") slot.item = sch.value;
    else slot.display = sch.value || null;
    saveSchedule(slots).catch(() => {});
    return;
  }
  const p = ev.target.closest?.(".prop-in");
  if (p) {
    const def = S.props[p.dataset.id]?.properties?.[p.dataset.k];
    let v = p.value;
    if (p.dataset.type === "color") v = propRgb(v);
    else if (p.type === "range") v = Number(v);
    // A list keeps the type its options have (numbers stay numbers).
    else if (p.tagName === "SELECT") v = (def?.options ?? []).find((o) => String(o.value) === v)?.value ?? v;
    setProp(p.dataset.id, p.dataset.k, v).catch(() => {});
    return;
  }
  if (ev.target.id === "ws-genre") { S.ws.genre = ev.target.value; wsLoad(); }
  if (ev.target.id === "ws-sort") { S.ws.sort = ev.target.value; wsLoad(); }
});

document.addEventListener("input", (ev) => {
  // A slider's number follows it while it's dragged; the value is saved when it's let go.
  if (ev.target.classList?.contains("prop-in") && ev.target.type === "range") {
    const out = ev.target.nextElementSibling;
    if (out) out.textContent = Number(ev.target.value).toFixed((ev.target.step.split(".")[1] || "").length);
  }
  if (ev.target.id === "search") { S.query = ev.target.value; prunePicks(); render(); }
  // Kept as typed until Enter, so a re-render (a download's progress, say) doesn't wipe it.
  if (ev.target.id === "ws-search") S.ws.draft = ev.target.value;
  if (ev.target.id === "volume") {
    clearTimeout(S.volTimer);
    const v = Number(ev.target.value) / 100;
    S.volTimer = setTimeout(() => setting({ volume: v }), 120);
  }
});

document.addEventListener("keydown", (ev) => {
  if (S.tab === "workshop" && S.ws.open && ev.key === "Tab") {
    trapTab(ev, $("#page .dialog"));
  } else if (ev.target.id === "app-new" && ev.key === "Enter") {
    Promise.resolve(actions.appRuleAdd()).catch(() => {});
  } else if (ev.target.id === "ws-search" && ev.key === "Enter") {
    S.ws.search = ev.target.value;
    S.ws.draft = null;
    wsLoad();
  } else if (ev.target.classList?.contains("name-in")) {
    if (ev.key === "Enter") ev.target.blur();
    if (ev.key === "Escape") { ev.target.value = ev.target.dataset.orig; ev.target.blur(); }
  } else if (ev.key === "Escape" && S.tab === "workshop" && S.ws.open) {
    S.ws.open = false;
    render();
  } else if (ev.target.id === "search" && ev.key === "Escape" && S.picking) {
    leavePicking();
    render();
  } else if (S.tab === "library" && !ev.target.closest?.("input")) {
    if (ev.key === "Escape" && S.picking) { leavePicking(); render(); }
    else if (ev.key === "Escape" && S.sel) { S.sel = null; S.preview = null; render(); }
    else if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === "a") { ev.preventDefault(); actions.pickAll(); }
    else if (ev.key === "Delete" && !ev.repeat) actions[S.picking ? "pickDelete" : "remove"]({ dataset: { id: heroItem()?.id } }).catch(() => {});
  }
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
  app: "Paused (app running)",
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

// The left nav: the pages, then each display with what it's showing, then pause and updates.
function renderNav() {
  const counts = { library: S.state.items.length, workshop: S.state.workshop.pending.length || "" };
  const tabs = [["library", tr("Library"), ICON.library], ["workshop", tr("Workshop"), ICON.workshop], ["displays", tr("Displays"), ICON.monitor], ["settings", tr("Settings"), ICON.settings]];
  morph($("#tabs"), tabs.map(([k, t, icon]) => `<button class="nav-tab press ${S.tab === k ? "on" : ""}" data-act="tab" data-tab="${k}" aria-label="${esc(t)}">${icon}<span>${t}</span>${counts[k] ? `<span class="n tnum">${counts[k]}</span>` : ""}</button>`).join(""));

  const ds = S.state.displays;
  const byId = new Map(S.state.items.map((e) => [e.id, e]));
  $("#screens-label").textContent = ds.length ? (spanned() ? tr("Spanning all displays") : ds.length > 1 ? tr("Displays") : tr("Now showing")) : "";
  morph($("#screens"), ds.map((d) => {
    const e = d.item && byId.get(d.item);
    const t = e && thumbUrl(e);
    return `<button class="nav-screen press" data-act="showItem" data-item="${esc(d.item ?? "")}" data-key="ns-${esc(d.key)}" aria-label="${esc(`${d.name}: ${e ? e.name : tr("Nothing set")}`)}">
      <span class="art">${t ? `<img src="${esc(t)}" draggable="false">` : ""}<span class="dot ${d.status}"></span></span>
      <span class="what"><div>${esc(e ? e.name : tr("Nothing set"))}</div><div>${esc(ds.length > 1 ? d.name : e ? statusText(d) : "")}</div></span>
    </button>`;
  }).join(""));

  const anyPlaying = ds.some((d) => d.status === "playing");
  const paused = ds.filter((d) => d.status === "paused");
  let dot = "", text = "";
  if (S.state.paused) { dot = "paused"; text = tr("Paused"); }
  else if (anyPlaying) { dot = "playing"; text = paused.length ? tr("Partly paused") : tr("Live"); }
  else if (paused.length) { dot = "paused"; text = tr(REASON[paused[0].reason] ?? "Paused"); }
  else if (ds.some((d) => d.status === "image")) { dot = "image"; text = tr("Still image"); }
  else text = tr("No wallpaper");
  morph($("#live"), `${S.state.paused ? ICON.resume : ICON.pause}<span>${esc(text)}</span><span class="dot ${dot}"></span>`);
  renderUpdate();
}

const statusText = (d) =>
  d.status === "playing" ? tr("Playing")
  : d.status === "paused" ? tr(REASON[d.reason] ?? "Paused")
  : d.status === "image" ? tr("Still image (set as the system wallpaper)")
  : tr("Nothing set");

// At the bottom of the nav: the version, which checks for updates when clicked, turns into a filled
// Update button when a new version is waiting, and shows the download while it installs.
function renderUpdate() {
  const el = $("#upd"), u = S.upd;
  if (!u) { el.hidden = true; return; }
  el.hidden = false;
  let cls = "", title, html = ICON.update;
  if (u.progress != null) {
    cls = "busy";
    title = tr("Backdrop restarts on its own when it's done.");
    html = `${ICON.update}<span class="tnum">${esc(tr("Updating {p}%", { p: u.progress }))}</span>`;
  } else if (u.available) {
    cls = "ready";
    title = tr("Update to Backdrop {v} and restart. Your library and settings stay.", { v: u.available }) + (u.notes ? `

${u.notes}` : "");
    html = `${ICON.download}<span>${esc(tr("Update to {v}", { v: u.available }))}</span>`;
  } else if (u.checking) {
    cls = "spin";
    title = tr("Checking for updates…");
    html = `${ICON.update}<span>${esc(tr("Checking…"))}</span>`;
  } else {
    title = tr("Check for updates");
    html = `${ICON.update}<span>Backdrop ${esc(u.current)}</span>`;
  }
  el.className = `nav-upd press ${cls}`;
  el.disabled = u.progress != null;
  el.title = title;
  el.setAttribute("aria-label", title);
  morph(el, html);
}

function placeholder(e, key = "") {
  const glyph = e.kind === "web" ? "&lt;/&gt;" : esc(kindLabel(e));
  return `<div class="ph ${e.kind}" ${key ? `data-key="${key}"` : ""}><span>${glyph}</span></div>`;
}

// ---------- library ----------

const posterUrl = (e) => (e.poster ? mediaUrl(`${e.id}/poster.jpg`) + `?v=${S.thumbVer[e.id] ?? 0}` : thumbUrl(e));
// What the sidebar shows: the pick, else what the main display is showing, else the newest.
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
  scene: [(e) => e.kind === "scene", "Scenes"],
  image: [(e) => e.kind === "image", "Images"],
  web: [(e) => e.kind === "web", "HTML"],
};

// What the grid shows with the current filter and search, in grid order.
function shownEntries() {
  const q = S.query.trim().toLowerCase();
  const match = FILTERS[S.filter] ?? FILTERS.all;
  return entries().filter((e) => match[0](e) && (!q || e.name.toLowerCase().includes(q)));
}

// ---------- selecting many ----------

const pickedIds = () => entries().map((e) => e.id).filter((id) => S.picked.has(id));
function leavePicking() {
  S.picking = false;
  S.picked.clear();
}
// Ticks stay on what's shown: a filter or search that hides a ticked wallpaper unticks it, so
// Delete never takes wallpapers the grid isn't showing.
function prunePicks() {
  if (!S.picked.size) return;
  const shown = new Set(shownEntries().map((e) => e.id));
  for (const id of S.picked) if (!shown.has(id)) S.picked.delete(id);
}
function togglePick(id) {
  if (S.picked.has(id)) S.picked.delete(id);
  else S.picked.add(id);
}
// Shift-click: everything between the last tile clicked and this one, as the grid shows them.
function pickRange(from, to) {
  const ids = shownEntries().map((e) => e.id);
  const a = ids.indexOf(from), b = ids.indexOf(to);
  S.picking = true;
  if (a < 0 || b < 0) { S.anchor = to; return togglePick(to); }
  for (const id of ids.slice(Math.min(a, b), Math.max(a, b) + 1)) S.picked.add(id);
}

// How heavy a wallpaper is to show, from what a player last measured.
const COST = { light: "Light", medium: "Medium", heavy: "Heavy" };
function costText(e) {
  const c = e.cost;
  const how = e.kind === "scene" ? tr("{ms} ms a frame at {fps} fps", { ms: c.ms, fps: Math.round(c.fps) })
    : e.kind === "web" ? tr("{fps} fps, busy {ms} ms a second", { ms: Math.round(c.ms), fps: Math.round(c.fps) })
    : tr("{p}% of frames dropped", { p: Math.round(c.dropped * 1000) / 10 });
  return `${tr(COST[c.level] ?? c.level)} · ${how}`;
}

function tileHtml(e, sel) {
  const t = thumbUrl(e);
  const live = liveOn(e.id);
  const res = resLabel(e);
  const picked = S.picking && S.picked.has(e.id);
  return `<button class="tile ${sel && !S.picking ? "sel" : ""} ${picked ? "picked" : ""}" data-act="select" data-id="${e.id}" data-key="t-${e.id}" ${S.picking ? `aria-pressed="${picked}"` : ""}>
    <div class="thumb">
      ${t ? `<img src="${esc(t)}" loading="lazy" draggable="false" onerror="this.remove()">` : placeholder(e)}
      ${live.length ? `<span class="pill tl"><span class="dot ${live[0].status}"></span>${live.length > 1 ? esc(tr("{n} displays", { n: live.length })) : esc(live[0].name)}</span>` : ""}
      ${res ? `<span class="pill br">${res}</span>` : ""}
      ${e.cost?.level === "heavy" ? `<span class="pill bl heavy" title="${esc(costText(e))}">${tr("Heavy")}</span>` : ""}
      ${S.picking ? `<span class="check">${ICON.check}</span>` : ""}
    </div>
    <div class="t-name">${esc(e.name)}</div>
    <div class="t-meta">${inRotation(e.id) ? `<span title="${esc(tr("In rotation"))}">${ICON.cycle}</span>` : ""}<span>${esc(kindLabel(e))} · ${fmtSize(e.size)}</span></div>
  </button>`;
}

// A video WebView2 can't play: convert it here when FFmpeg is installed (transcode.rs), otherwise
// say how.
function convertHtml(e) {
  const codec = codecName(e.codec);
  const pct = S.state.converting?.[e.id];
  if (pct != null) return `<div class="warn">${esc(tr("Converting to H.264: {p}%", { p: pct }))}<div class="bar"><i style="width:${pct}%"></i></div></div>`;
  if (S.state.ffmpeg) return `<div class="warn">${esc(tr("Windows can't play {codec} video.", { codec }))}
    <div><button class="btn sm press" data-act="convert" data-id="${e.id}">${tr("Convert to H.264")}</button></div></div>`;
  return `<div class="warn">${tr("Windows can't play {codec} video. Convert it to H.264 (HandBrake works) and add that instead.", { codec })}
    ${esc(tr("With FFmpeg installed (winget install ffmpeg), Backdrop converts it here."))}</div>`;
}

// The inspector on the right: the picked wallpaper large, what can be done with it, then its details.
function sideHtml(e) {
  const live = liveOn(e.id);
  const displays = S.state.displays;
  const rot = inRotation(e.id);
  const src = posterUrl(e);
  const type = e.kind === "web" ? tr("HTML page") : e.kind === "scene" ? tr("Scene") : kindLabel(e) === "GIF" ? tr("Animated GIF") : e.kind === "video" ? tr("Video") : tr("Image");
  const facts = [
    [tr("Type"), type],
    e.width ? [tr("Resolution"), `${e.width} × ${e.height}${resLabel(e) ? ` · ${resLabel(e)}` : ""}`] : null,
    e.codec ? [tr("Codec"), codecName(e.codec)] : null,
    e.fps ? [tr("Frame rate"), `${Math.round(e.fps * 100) / 100} fps`] : null,
    [tr("Size"), fmtSize(e.size)],
    [tr("Added"), fmtDate(e.added)],
    e.workshop ? [tr("Source"), tr("Steam Workshop")] : null,
    e.cost ? [tr("Cost"), costText(e)] : null,
  ].filter(Boolean);
  const canPreview = e.kind === "video" && !cantPlayHere(e);
  const previewing = canPreview && S.preview === e.id;
  const multi = displays.length > 1;
  const playTitle = previewing ? tr("Stop preview") : tr("Preview");

  return `<aside class="side" data-key="side">
    <div class="side-scroll">
      <div class="side-media" data-key="sm-${e.id}">
        ${src ? `<img src="${esc(src)}" draggable="false" onerror="this.remove()">` : placeholder(e)}
        ${previewing ? `<video data-key="sv-${e.id}-${S.videoViaLoopback ? "l" : "m"}" src="${esc(videoUrl(`${e.id}/${e.file}`))}" autoplay muted loop playsinline onerror="mediaVideoFailed()"></video>` : ""}
        ${canPreview ? `<button class="btn sm icon press side-play" data-act="preview" data-id="${e.id}" title="${esc(playTitle)}" aria-label="${esc(playTitle)}">${previewing ? ICON.stop : ICON.play}</button>` : ""}
      </div>
      <div class="side-status">${live.length
        ? `<span class="dot ${live[0].status}"></span>${esc(spanned() === e.id ? tr("Spanning all displays") : tr("Showing on {names}", { names: live.map((d) => d.name).join(", ") }))}`
        : `<span class="dot"></span>${tr("Not on a display")}`}</div>
      <input class="name-in" data-id="${e.id}" data-orig="${esc(e.name)}" value="${esc(e.name)}" spellcheck="false" title="${esc(tr("Rename"))}">
      ${cantPlayHere(e) ? convertHtml(e) : ""}
      <div class="side-acts">
        <button class="btn pri lg block press" data-act="setAll" data-id="${e.id}">${ICON.play}${multi ? tr("Set on all displays") : tr("Set as wallpaper")}</button>
        ${multi ? `<div class="where">${displays.map((d) => `<button class="btn sm press ${d.item === e.id && !spanned() ? "on" : ""}" data-act="setOn" data-id="${e.id}" data-display="${esc(d.key)}" title="${esc(tr("Only {name}", { name: d.name }))}">${esc(d.name)}</button>`).join("")}
          <button class="btn sm press ${spanned() === e.id ? "on" : ""}" data-act="setSpan" data-id="${e.id}" title="${esc(tr("One wallpaper stretched across all your displays"))}">${tr("Span all displays")}</button></div>` : ""}
      </div>
      <div class="group">
        <div class="card"><div class="row"><div class="what">${tr("In rotation")}<div class="hint">${tr("Rotation picks from these. Set the timer in Settings.")}</div></div>
          <button class="sw press ${rot ? "on" : ""}" data-act="rotation" data-id="${e.id}" role="switch" aria-checked="${rot}" aria-label="${esc(tr("In rotation"))}"></button></div>
        ${perDisplayLists() ? `<div class="row"><div class="what">${tr("Only on")}<div class="hint">${tr("A display with its own list rotates through that instead.")}</div>
          <div class="where">${displays.map((d) => { const own = displayPool(d.key).includes(e.id); return `<button class="btn sm press ${own ? "on" : ""}" data-act="displayRotation" data-id="${e.id}" data-display="${esc(d.key)}" aria-pressed="${own}">${esc(d.name)}</button>`; }).join("")}</div></div></div>` : ""}</div>
      </div>
      ${propsHtml(e)}
      <div class="group">
        <div class="group-label">${tr("Details")}</div>
        <div class="card"><dl class="facts">${facts.map(([k, v]) => `<dt>${esc(k)}</dt><dd title="${esc(v)}">${esc(v)}</dd>`).join("")}</dl></div>
      </div>
      <div class="side-foot">
        <button class="btn sm ghost danger press" data-act="remove" data-id="${e.id}">${ICON.trash}${tr("Remove from the library")}</button>
      </div>
    </div>
  </aside>`;
}

// ---------- wallpaper properties ----------
// Scenes and HTML wallpapers from Wallpaper Engine carry their own settings (general.properties in
// project.json): colours, sliders, switches, lists. Their labels and conditions come from the
// download, so labels are shown as plain text and conditions go through a small evaluator.

const PROP_LANG = { en: "en-us", es: "es-es", de: "de-de", "zh-Hans": "zh-chs" };
// Labels Wallpaper Engine itself translates, for wallpapers that use them without a localization.
const PROP_LABELS = { ui_browse_properties_scheme_color: "Scheme color" };

function loadProps(id) {
  if (S.props[id]) return;
  S.props[id] = "loading";
  invoke("item_properties", { id }).then((d) => { S.props[id] = d || "none"; render(); }, () => { S.props[id] = "none"; });
}

function propLabel(text, loc) {
  const raw = String(text ?? "");
  const local = loc?.[PROP_LANG[LANG] ?? "en-us"]?.[raw] ?? loc?.["en-us"]?.[raw] ?? PROP_LABELS[raw];
  const plain = String(local ?? raw).replace(/<br\s*\/?>/gi, " ").replace(/<[^>]*>/g, "").replace(/&nbsp;/g, " ").trim();
  if (local == null && /^ui_[a-z0-9_]+$/i.test(plain)) {
    const words = plain.replace(/^ui_(browse_properties_|editor_properties_)?/i, "").replace(/_/g, " ");
    return words.charAt(0).toUpperCase() + words.slice(1);
  }
  return plain;
}

// "r g b" with 0-1 channels (or 0-255 in some older wallpapers) to #rrggbb and back.
function propHex(v) {
  const c = String(v ?? "").trim().split(/[\s,]+/).map(Number);
  if (c.length < 3 || c.some((x) => !Number.isFinite(x))) return "#ffffff";
  const k = c.slice(0, 3).some((x) => x > 1) ? 1 : 255;
  return "#" + c.slice(0, 3).map((x) => Math.round(Math.min(255, Math.max(0, x * k))).toString(16).padStart(2, "0")).join("");
}
const propRgb = (hex) => [1, 3, 5].map((i) => (parseInt(hex.slice(i, i + 2), 16) / 255).toFixed(5).replace(/0+$/, "").replace(/\.$/, "")).join(" ");

// Wallpaper Engine conditions, e.g. `showclock.value == true && style.value != 2`: names, `.value`,
// literals, comparisons, ! && ||, parentheses. Anything else shows the property.
function propCondition(cond, valueOf) {
  if (typeof cond !== "string" || !cond.trim()) return true;
  const toks = cond.match(/"[^"]*"|'[^']*'|[A-Za-z_][\w]*(?:\.value)?|\d+(?:\.\d+)?|===|!==|==|!=|>=|<=|&&|\|\||[!<>()]|\S/g) || [];
  let i = 0;
  const lit = (t) => {
    if (t === "true") return true;
    if (t === "false") return false;
    if (/^["']/.test(t)) return t.slice(1, -1);
    if (/^\d/.test(t)) return Number(t);
    if (/^[A-Za-z_]/.test(t)) return valueOf(t.replace(/\.value$/, ""));
    throw new Error(t);
  };
  const unary = () => {
    const t = toks[i++];
    if (t === "!") return !unary();
    if (t === "(") { const v = or(); if (toks[i++] !== ")") throw new Error(")"); return v; }
    if (t === undefined) throw new Error("end");
    return lit(t);
  };
  const cmp = () => {
    let a = unary();
    while (["==", "!=", "===", "!==", ">", "<", ">=", "<="].includes(toks[i])) {
      const op = toks[i++], b = unary();
      // Wallpaper Engine compares loosely: "1" == 1, true == "true".
      const [x, y] = [String(a), String(b)];
      a = op === "==" || op === "===" ? x === y : op === "!=" || op === "!==" ? x !== y : op === ">" ? +a > +b : op === "<" ? +a < +b : op === ">=" ? +a >= +b : +a <= +b;
    }
    return a;
  };
  const and = () => { let a = cmp(); while (toks[i] === "&&") { i++; const b = cmp(); a = a && b; } return a; };
  const or = () => { let a = and(); while (toks[i] === "||") { i++; const b = and(); a = a || b; } return a; };
  try { const v = or(); return i === toks.length ? !!v : true; } catch { return true; }
}

function propsHtml(e) {
  if (e.kind !== "scene" && e.kind !== "web") return "";
  loadProps(e.id);
  const d = S.props[e.id];
  if (!d || typeof d !== "object") return "";
  const values = e.properties ?? {};
  const valueOf = (k) => (k in values ? values[k] : d.properties[k]?.value);
  const list = Object.entries(d.properties)
    .filter(([, p]) => p && typeof p === "object" && ["bool", "slider", "color", "combo", "textinput", "text"].includes(p.type))
    .sort((a, b) => (+a[1].order || 0) - (+b[1].order || 0))
    .filter(([, p]) => propCondition(p.condition, valueOf));
  if (!list.length) return "";
  const attrs = (k) => `class="prop-in" data-id="${e.id}" data-k="${esc(k)}"`;
  const rows = list.map(([k, p]) => {
    const label = esc(propLabel(p.text || k, d.localization));
    const v = valueOf(k);
    if (p.type === "text") return label ? `<div class="prop-note">${label}</div>` : "";
    let control;
    if (p.type === "bool") {
      const on = v === true || v === "true" || v === 1;
      control = `<button class="sw press ${on ? "on" : ""}" data-act="propBool" data-id="${e.id}" data-k="${esc(k)}" role="switch" aria-checked="${on}" aria-label="${label}"></button>`;
    } else if (p.type === "slider") {
      const min = +p.min || 0, max = Number.isFinite(+p.max) && p.max !== undefined ? +p.max : 100;
      const step = +p.step || (p.fraction === false ? 1 : Math.max((max - min) / 100, 0.001));
      const shown = Number.isFinite(+v) ? +v : min;
      const digits = Number.isInteger(step) ? 0 : Math.min(3, Math.max(1, +p.precision || 2));
      control = `<span class="prop-slide"><input type="range" ${attrs(k)} min="${min}" max="${max}" step="${step}" value="${shown}" aria-label="${label}"><output class="tnum">${shown.toFixed(digits)}</output></span>`;
    } else if (p.type === "color") {
      control = `<input type="color" ${attrs(k)} data-type="color" value="${propHex(v)}" aria-label="${label}">`;
    } else if (p.type === "combo") {
      const opts = Array.isArray(p.options) ? p.options : [];
      control = `<select class="select prop-in" data-id="${e.id}" data-k="${esc(k)}" aria-label="${label}">${opts.map((o) => `<option value="${esc(o.value)}" ${String(o.value) === String(v) ? "selected" : ""}>${esc(propLabel(o.label ?? o.value, d.localization))}</option>`).join("")}</select>`;
    } else {
      control = `<input type="text" ${attrs(k)} value="${esc(v ?? "")}" spellcheck="false" aria-label="${label}">`;
    }
    return `<div class="row prop-row" data-key="pr-${esc(k)}"><div class="what">${label}</div>${control}</div>`;
  }).join("");
  const changed = Object.keys(values).length > 0;
  return `<div class="group">
        <div class="group-label">${tr("Properties")}${changed ? `<button class="link press" data-act="propReset" data-id="${e.id}">${tr("Reset")}</button>` : ""}</div>
        <div class="card props">${rows}</div>
      </div>`;
}

function setProp(id, key, value) {
  return call("set_item_properties", { id, values: { [key]: value } });
}

// The inspector in select mode: what's ticked, and what can be done to all of it at once.
function pickSideHtml() {
  const byId = new Map(entries().map((e) => [e.id, e]));
  const ids = pickedIds();
  const items = ids.map((id) => byId.get(id));
  const size = items.reduce((n, e) => n + e.size, 0);
  const inRot = items.filter((e) => inRotation(e.id)).length;
  const none = !ids.length;
  const stack = items.slice(0, 3);
  return `<aside class="side" data-key="side-pick">
    <div class="side-scroll">
      <div class="side-media stack" data-key="sp-stack">${stack.length
        ? stack.map((e, k) => { const t = thumbUrl(e); return `<div class="stack-card s${k}" data-key="sc-${e.id}">${t ? `<img src="${esc(t)}" draggable="false" onerror="this.remove()">` : placeholder(e)}</div>`; }).reverse().join("")
        : `<div class="stack-empty">${ICON.check}</div>`}</div>
      <div class="side-title">${none ? tr("Select wallpapers") : esc(tr("{n} selected", { n: ids.length }))}</div>
      <div class="hint">${none ? tr("Click wallpapers to tick them.") : esc(`${fmtSize(size)}${inRot ? ` · ${tr("{n} in rotation", { n: inRot })}` : ""}`)}</div>
      <div class="side-btns">
        <button class="btn sm press" data-act="pickAll">${tr("Select all")}</button>
        <button class="btn sm press" data-act="pickNone" ${none ? "disabled" : ""}>${tr("Select none")}</button>
      </div>
      <div class="side-acts">
        <button class="btn block press" data-act="pickRotation" data-on="1" ${none || inRot === ids.length ? "disabled" : ""}>${ICON.cycle}${tr("Add to rotation")}</button>
        <button class="btn block press" data-act="pickRotation" data-on="0" ${!inRot ? "disabled" : ""}>${tr("Take out of rotation")}</button>
        <button class="btn block danger press" data-act="pickDelete" ${none ? "disabled" : ""}>${ICON.trash}${none ? tr("Delete") : tr("Delete {n}", { n: ids.length })}</button>
      </div>
      <div class="group">
        <div class="group-label">${tr("Shortcuts")}</div>
        <div class="card keys">
          <div><span>${tr("Pick a range")}</span><kbd>Shift</kbd><kbd>${tr("Click")}</kbd></div>
          <div><span>${tr("Pick everything shown")}</span><kbd>Ctrl</kbd><kbd>A</kbd></div>
          <div><span>${tr("Delete")}</span><kbd>Del</kbd></div>
          <div><span>${tr("Done")}</span><kbd>Esc</kbd></div>
        </div>
      </div>
    </div>
  </aside>`;
}

const MARK = document.querySelector(".brand .mark")?.outerHTML ?? "";

function renderLibrary() {
  const all = entries();
  const head = (extra = "") => `<header class="top" data-tauri-drag-region><h1 data-tauri-drag-region>${tr("Library")}${all.length ? `<span class="count tnum">${all.length}</span>` : ""}</h1>
      <span class="sp" data-tauri-drag-region></span>${extra}
      <button class="btn sm icon press" data-act="pick" data-folder="1" title="${esc(tr("Add HTML folder"))}" aria-label="${esc(tr("Add HTML folder"))}">${ICON.folder}</button>
      <button class="btn sm pri press" data-act="pick" data-folder="0">${ICON.plus}${tr("Add files")}</button></header>`;
  if (!all.length) {
    return `<div class="page" data-key="p-library-empty">${head()}
      <div class="welcome"><div class="drop-zone">${MARK}
        <h2>${tr("Your library is empty")}</h2>
        <p>${tr("Drop videos (MP4, WebM, MOV), images, GIFs or HTML wallpapers anywhere in this window.")}</p>
        <div class="acts"><button class="btn pri press" data-act="pick" data-folder="0">${ICON.plus}${tr("Add files")}</button>
          <button class="btn press" data-act="tab" data-tab="workshop">${ICON.workshop}${tr("Browse the Workshop")}</button></div>
      </div></div></div>`;
  }
  // Deleted wallpapers drop out of the selection.
  for (const id of S.picked) if (!all.some((e) => e.id === id)) S.picked.delete(id);
  const hero = heroItem();
  const shown = shownEntries();
  const chips = Object.entries(FILTERS)
    .map(([k, [f, label]]) => [k, label, all.filter(f).length])
    .filter(([k, , n]) => k === "all" || k === S.filter || n);

  return `<div class="page" data-key="p-library">
    ${head(`<label class="search">${ICON.search}<input id="search" placeholder="${esc(tr("Search"))}" aria-label="${esc(tr("Search"))}" value="${esc(S.query)}" spellcheck="false"></label>
      <button class="btn sm press ${S.picking ? "on" : ""}" data-act="pickMode" title="${esc(tr("Select several wallpapers to delete them or change their rotation together"))}">${ICON.check}${S.picking ? tr("Done") : tr("Select")}</button>`)}
    <div class="body">
      <section class="page">
        <div class="sub-bar"><div class="seg">${chips.map(([k, label, n]) => `<button class="press ${S.filter === k ? "on" : ""}" data-act="filter" data-v="${k}">${tr(label)} <span class="muted tnum">${n}</span></button>`).join("")}</div></div>
        <div class="grid-wrap ${S.picking ? "picking" : ""}">${shown.length ? `<div class="grid">${shown.map((e) => tileHtml(e, e.id === hero.id)).join("")}</div>`
          : `<div class="empty"><div class="em-ico">${ICON.search}</div><h2>${tr("Nothing matches.")}</h2></div>`}</div>
      </section>
      ${S.picking ? pickSideHtml() : sideHtml(hero)}
    </div>
  </div>`;
}

// ---------- workshop ----------
// Wallpaper Engine's Steam Workshop, minus anime (the filtering is in workshop.rs). Steam does the
// downloading; Backdrop imports what it downloads.

async function wsLoad(more = false) {
  const w = S.ws;
  const seq = ++w.seq;
  const startPage = w.page;
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
        const r = await invoke("workshop_browse", { query: { sort: w.sort, genre: w.genre, kind: w.kind === "all" ? null : w.kind, search: w.search, page: w.page } });
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
    // The loop above may have moved several pages on; the next try starts where this one did.
    if (more) w.page = startPage;
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
const wsKindLabel = (i) => (i.kind === "web" ? "HTML" : i.kind === "scene" ? tr("Scene") : tr("Video"));
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
    <div class="t-meta"><span>${esc([wsKindLabel(i), i.genres.map(tr).join(", "), i.size ? fmtSize(i.size) : null].filter(Boolean).join(" · "))}</span></div>
  </button>`;
}

// What the grid area says when there's nothing to show yet.
function wsEmptyHtml() {
  const w = S.ws;
  if (w.error) return `<div class="empty"><div class="em-ico">${ICON.workshop}</div><h2>${tr("Couldn't reach Steam")}</h2><p>${esc(w.error)}</p>
    <div class="acts"><button class="btn pri press" data-act="wsRetry">${tr("Try again")}</button></div></div>`;
  if (!w.items) return `<div class="empty"><p>${tr("Loading…")}</p></div>`;
  return `<div class="empty"><div class="em-ico">${w.view === "discover" ? ICON.search : ICON.download}</div>
    <h2>${w.view === "discover" ? tr("Nothing matches.") : tr("Steam hasn't downloaded any wallpapers for Wallpaper Engine.")}</h2></div>`;
}

// Clicking a tile opens this dialog: the whole preview, uncropped, with the details and actions under it.
// The tile's small image sits underneath so something shows while the large one loads.
function wsModalHtml(i) {
  const w = S.ws;
  const lib = wsLib(i.id);
  const pending = wsPending(i.id);
  const icon = (title, act, svg, extra = "") => `<button class="btn icon ghost press" data-act="${act}" data-id="${i.id}" ${extra} title="${esc(title)}" aria-label="${esc(title)}">${svg}</button>`;
  let acts;
  if (lib) acts = `<button class="btn pri press" data-act="wsShow" data-item="${lib}">${ICON.library}${tr("Show in the library")}</button>`;
  else if (w.view === "steam") acts = `<button class="btn pri press" data-act="wsAdd" data-id="${i.id}">${ICON.plus}${tr("Add to library")}</button>`;
  else if (pending) acts = `<button class="btn pri press" disabled>${ICON.download}${esc(wsWaiting(i.id))}</button>
      <button class="btn press" data-act="wsOpenSteam" data-id="${i.id}">${tr("Open in Steam")}</button>`;
  else acts = `<button class="btn pri press" data-act="wsSubscribe" data-id="${i.id}">${ICON.download}${tr("Download")}</button>`;
  if (!lib && w.view !== "steam") acts += `<button class="btn press" data-act="wsAdd" data-id="${i.id}">${tr("Already downloaded? Add it now")}</button>`;
  const meta = [
    i.resolution ? `${i.resolution}${wsRes(i) ? ` · ${wsRes(i)}` : ""}` : null,
    i.size ? fmtSize(i.size) : null,
    tr("{n} subscribers", { n: i.subscriptions.toLocaleString() }),
  ].filter(Boolean).join("  ·  ");
  const badges = [i.kind === "web" ? tr("HTML page") : wsKindLabel(i), ...i.genres.map(tr)];
  const desc = i.description.replace(/\[[^\]]*\]/g, "").trim();
  return `<div class="modal" data-key="ws-modal">
    <div class="scrim" data-act="wsClose"></div>
    <div class="dialog" role="dialog" aria-modal="true" aria-label="${esc(i.title)}" data-key="wm-${i.id}">
      <div class="dlg-media">
        ${i.preview ? `<img class="lo" src="${esc(wsThumb(i.preview))}" draggable="false" onerror="this.remove()">
          <img class="hi" src="${esc(wsThumb(i.preview, 1920))}" draggable="false" onerror="this.remove()">`
          : `<div class="ph ${i.kind}"><span>${i.kind === "web" ? "&lt;/&gt;" : esc(wsKindLabel(i))}</span></div>`}
        <button class="btn sm icon press dlg-x" data-act="wsClose" title="${esc(tr("Close"))}" aria-label="${esc(tr("Close"))}">${ICON.close}</button>
      </div>
      <div class="dlg-info">
        <div class="badges">${lib || pending ? `<span class="badge"><span class="dot ${lib ? "playing" : "paused"}"></span>${esc(lib ? tr("In your library") : wsWaiting(i.id))}</span>` : ""}${badges.map((b) => `<span class="badge">${esc(b)}</span>`).join("")}</div>
        <div class="dlg-title" title="${esc(i.title)}">${esc(i.title)}</div>
        <div class="dlg-meta">${esc(meta)}</div>
        ${desc ? `<div class="dlg-desc">${esc(desc)}</div>` : ""}
      </div>
      <div class="dlg-foot">${acts}
        <span class="sp"></span>
        ${icon(tr("Open the workshop page"), "wsOpen", ICON.external)}
        ${icon(tr("Hide this wallpaper"), "wsHide", ICON.hide)}
        ${i.creator ? icon(tr("Hide everything by this creator"), "wsHide", ICON.hideUser, `data-creator="${esc(i.creator)}"`) : ""}
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
  const select = (id, cur, opts) => `<select id="${id}" class="select">${opts.map(([v, t]) => `<option value="${esc(v)}" ${cur === v ? "selected" : ""}>${esc(t)}</option>`).join("")}</select>`;

  const grid = items.length
    ? `<div class="grid">${items.map((i) => wsTileHtml(i, i.id === sel?.id)).join("")}</div>
      ${w.error ? `<div class="more"><span class="muted">${esc(tr("Couldn't load more: {e}", { e: w.error }))}</span><button class="btn sm press" data-act="wsMore">${tr("Try again")}</button></div>`
        : w.more || (w.loading && items.length) ? `<div class="more"><button class="btn sm press" data-act="wsMore" ${w.loading ? "disabled" : ""}>${w.loading ? tr("Loading…") : tr("Load more")}</button></div>` : ""}`
    : wsEmptyHtml();
  const note = S.state.workshop.steam ? "" :
    `<div class="warn ws-warn">${tr("Steam's Wallpaper Engine folder wasn't found. You can browse, but subscribing only downloads anything if Steam is installed and you own Wallpaper Engine (it has to stay installed; it doesn't have to run).")}</div>`;

  return `<div class="page" data-key="p-workshop">
    <header class="top" data-tauri-drag-region><h1 data-tauri-drag-region>${tr("Workshop")}</h1>
      <span class="sp" data-tauri-drag-region></span>
      ${discover ? `<label class="search">${ICON.search}<input id="ws-search" placeholder="${esc(tr("Search, then Enter"))}" aria-label="${esc(tr("Search the Workshop"))}" value="${esc(w.draft ?? w.search)}" spellcheck="false"></label>` : ""}
    </header>
    <div class="sub-bar">
      ${seg("wsView", w.view, views)}
      <span class="sp"></span>
      ${discover ? `${seg("wsKind", w.kind, [["all", tr("All")], ["scene", tr("Scene")], ["video", tr("Video")], ["web", "HTML"]])}
        ${select("ws-sort", w.sort, sorts)}${select("ws-genre", w.genre, genres)}` : ""}
    </div>
    ${note}
    <div class="grid-wrap">${grid}</div>
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
      const art = t && spanned() ? `<img class="span-art" src="${esc(t)}" draggable="false" style="left:${(-(d.x - minX) / d.width * 100).toFixed(3)}%;top:${(-(d.y - minY) / d.height * 100).toFixed(3)}%;width:${(w / d.width * 100).toFixed(3)}%;height:${(h / d.height * 100).toFixed(3)}%">` : "";
      return `<div class="screen" style="left:${pct(d.x - minX, w, 3)};top:${pct(d.y - minY, h, 3)};width:${pct(d.width, w, -6)};height:${pct(d.height, h, -6)};${t && !spanned() ? `background-image:url('${t}')` : ""}">
        ${art}<span class="pill"><span class="dot ${d.status}"></span>${esc(d.name)}${d.primary ? ` · ${tr("main")}` : ""}</span></div>`;
    }).join("")}</div>`;
  }
  const drow = (d, title, sub, clearAttr) => {
    const e = d.item && byId.get(d.item);
    const t = e && thumbUrl(e);
    return `<div class="set-row">
      <div class="what" style="flex:0 0 190px">${esc(title)}<div class="hint">${sub}</div></div>
      <div class="now"><span class="art">${t ? `<img src="${esc(t)}" draggable="false">` : e ? placeholder(e) : ""}</span>
        <div class="what"><div>${e ? esc(e.name) : `<span class="muted">${tr("Nothing set")}</span>`}</div><div class="hint">${e ? esc(statusText(d)) : ""}</div></div></div>
      ${d.item ? `<button class="btn sm press" data-act="clearDisplay" ${clearAttr}>${tr("Clear")}</button>` : ""}
    </div>`;
  };
  // A spanned wallpaper is one thing on every display, so it gets one row and Clear takes it off all of them.
  const rows = spanned() && ds.length
    ? drow(ds[0], tr("All displays"), esc(tr("{n} displays", { n: ds.length })), "")
    : ds.map((d) => drow(d, d.name, `${d.width}×${d.height}${d.scale !== 1 ? ` · ${Math.round(d.scale * 100)}%` : ""}${d.primary ? ` · ${tr("main display")}` : ""}`, `data-display="${esc(d.key)}"`)).join("");
  return `<div class="page" data-key="p-displays">
    <header class="top" data-tauri-drag-region><h1 data-tauri-drag-region>${tr("Displays")}</h1><span class="sp" data-tauri-drag-region></span>
      ${S.state.items.length ? `<button class="btn sm press" data-act="next">${ICON.cycle}${tr("Next wallpaper")}</button>` : ""}</header>
    <div class="scroll"><div class="col">
      <p class="lede">${tr("Choose wallpapers in the Library. Still images are handed to {os} as the normal wallpaper, so they cost nothing to show. Videos and HTML play behind your desktop icons and pause when they're covered.", { os: "Windows" })}</p>
      ${map}
      ${rows ? `<div class="card">${rows}</div>` : `<div class="empty"><div class="em-ico">${ICON.monitor}</div><h2>${tr("No displays found.")}</h2></div>`}
    </div></div>
  </div>`;
}

function seg(act, cur, opts) {
  return `<div class="seg">${opts.map(([v, t]) => `<button class="press ${String(cur) === v ? "on" : ""}" data-act="${act}" data-v="${v}">${t}</button>`).join("")}</div>`;
}
// A switch sends the value it flips to, so the on(el) handlers stay as they were.
// `{name}` in a switch's markup becomes the row's title, its accessible name.
const offOn = (act, v) => `<button class="sw press ${v ? "on" : ""}" data-act="${act}" data-v="${v ? "0" : "1"}" role="switch" aria-checked="${!!v}" aria-label="{name}"></button>`;
const row = (what, hint, control) =>
  `<div class="set-row"><div class="what">${what}${hint ? `<div class="hint">${hint}</div>` : ""}</div>${control.replace('aria-label="{name}"', `aria-label="${esc(what.replace(/<[^>]*>/g, ""))}"`)}</div>`;
const section = (title, sub, rows) => `<div class="sec"><h3>${title}</h3>${sub ? `<p>${sub}</p>` : ""}<div class="card">${rows}</div></div>`;

// ---------- app rules ----------
// Programs that pause or mute the wallpapers while they run (a game, OBS, a video call).

const appRules = () => S.state.config.appRules ?? [];
const saveRules = (rules) => call("set_app_rules", { rules });

// The running programs fill the add field's suggestions; they're listed when it's focused.
document.addEventListener("focusin", async (ev) => {
  if (ev.target.id !== "app-new") return;
  S.running = await invoke("running_apps").catch(() => []);
  const list = $("#app-list");
  if (list) list.replaceChildren(...S.running.map((exe) => Object.assign(document.createElement("option"), { value: exe })));
});

function appRuleRows() {
  const rows = appRules().map((r, i) => `<div class="set-row" data-key="ar-${esc(r.exe)}">
      <div class="what mono">${esc(r.exe)}</div>
      ${seg("appRuleAction", r.action, [["pause", tr("Pause")], ["mute", tr("Mute")]]).replace(/data-act="appRuleAction"/g, `data-act="appRuleAction" data-i="${i}"`)}
      <button class="btn sm icon ghost press" data-act="appRuleRemove" data-i="${i}" title="${esc(tr("Remove"))}" aria-label="${esc(tr("Remove"))}">${ICON.close}</button>
    </div>`);
  rows.push(`<div class="set-row" data-key="ar-new"><div class="what">${tr("While these apps run")}<div class="hint">${tr("Pause or mute the wallpapers while a program is open, for example a game or a screen recorder.")}</div></div>
      <input id="app-new" class="app-new" list="app-list" placeholder="obs64.exe" spellcheck="false" aria-label="${esc(tr("Program"))}"><datalist id="app-list"></datalist>
      <button class="btn sm press" data-act="appRuleAdd">${ICON.plus}${tr("Add")}</button></div>`);
  return rows.join("");
}

// ---------- schedule ----------

const schedule = () => S.state.config.schedule ?? [];
const saveSchedule = (slots) => call("set_schedule", { slots: [...slots].sort((a, b) => a.at - b.at) });
const hhmm = (m) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;

function scheduleRows() {
  const items = entries();
  const ds = S.state.displays;
  const rows = schedule().map((slot, i) => {
    const known = items.some((e) => e.id === slot.item);
    return `<div class="set-row sched" data-key="sch-${i}">
      <input type="time" class="sched-in" data-i="${i}" data-f="at" value="${hhmm(slot.at)}" aria-label="${esc(tr("Time"))}">
      <select class="select sched-in" data-i="${i}" data-f="item" aria-label="${esc(tr("Wallpaper"))}">${known ? "" : `<option value="${esc(slot.item)}" selected>${esc(tr("Deleted wallpaper"))}</option>`}${items.map((e) => `<option value="${e.id}" ${e.id === slot.item ? "selected" : ""}>${esc(e.name)}</option>`).join("")}</select>
      ${ds.length > 1 && !spanned() ? `<select class="select sched-in" data-i="${i}" data-f="display" aria-label="${esc(tr("Display"))}"><option value="">${esc(tr("All displays"))}</option>${ds.map((d) => `<option value="${esc(d.key)}" ${slot.display === d.key ? "selected" : ""}>${esc(d.name)}</option>`).join("")}</select>` : ""}
      <span class="sp"></span>
      <button class="btn sm icon ghost press" data-act="schedRemove" data-i="${i}" title="${esc(tr("Remove"))}" aria-label="${esc(tr("Remove"))}">${ICON.close}</button>
    </div>`;
  });
  rows.push(row(schedule().length ? "" : tr("No times set"), "", `<button class="btn sm press" data-act="schedAdd" ${S.state.items.length ? "" : "disabled"}>${ICON.plus}${tr("Add a time")}</button>`));
  return rows.join("");
}

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
  const u = S.upd;
  const updHint = u?.available ? tr("Backdrop {v} is available. Your library and settings stay.", { v: esc(u.available) })
    : u?.checked && !u.error ? tr("Up to date. Backdrop checks GitHub when it starts and every few hours.")
    : tr("Backdrop checks GitHub when it starts and every few hours.");
  const updBtn = u?.progress != null ? `<button class="btn sm press" disabled>${tr("Updating {p}%", { p: u.progress })}</button>`
    : u?.available ? `<button class="btn sm pri press" data-act="update">${tr("Update and restart")}</button>`
    : `<button class="btn sm press" data-act="update" ${u?.checking ? "disabled" : ""}>${u?.checking ? tr("Checking…") : tr("Check now")}</button>`;

  return `<div class="page" data-key="p-settings">
    <header class="top" data-tauri-drag-region><h1 data-tauri-drag-region>${tr("Settings")}</h1><span class="sp" data-tauri-drag-region></span></header>
    <div class="scroll"><div class="col">
    <p class="lede">${tr("Backdrop {version}. Closing this window keeps wallpapers running; quit from the {tray} icon.", { version: esc(S.state.version), tray: trayName() })}</p>
    ${section(tr("Playback"), "", [
      row(tr("Fit"), tr("How wallpapers that don't match the screen's shape are scaled."),
        seg("fit", c.fit, [["cover", tr("Fill")], ["contain", tr("Fit")], ["height", tr("Fit height")], ["stretch", tr("Stretch")], ["center", tr("Center")]])),
      row(tr("Speed"), tr("Playback speed for videos."), seg("speed", String(c.speed), speeds)),
      `<div class="set-row"><div class="what">${tr("Sound")}<div class="hint">${tr("Videos and HTML wallpapers with audio.")}</div></div>
        ${c.muted ? "" : `<input id="volume" type="range" min="0" max="100" value="${Math.round(c.volume * 100)}" aria-label="${esc(tr("Volume"))}">`}
        ${seg("muted", c.muted ? "1" : "0", [["1", tr("Muted")], ["0", tr("On")]])}</div>`,
      row(tr("Shade the {bar}", { bar }), tr("Darkens a strip of moving wallpapers under the {bar} so it stays readable.", { bar }), offOn("shadeBar", c.shadeBar)),
      row(tr("Match the system wallpaper"), tr("Sets a still frame of each moving wallpaper as the Windows wallpaper, so the desktop matches before Backdrop starts."), offOn("stillFrame", c.stillFrame)),
    ].join(""))}
    ${section(tr("Rotation"), poolHint, [
      row(tr("Change wallpaper"), "",
        seg("rotMinutes", r.minutes, [["0", tr("Never")], ["15", tr("15 min")], ["30", tr("30 min")], ["60", tr("1 hour")], ["180", tr("3 hours")], ["1440", tr("1 day")]])),
      row(tr("Order"), "", seg("rotOrder", r.order, [["sequential", tr("In order")], ["shuffle", tr("Shuffle")]])),
      S.state.displays.length > 1 && !c.span ? row(tr("Displays"), "", seg("rotPerDisplay", r.perDisplay ? "1" : "0", [["0", tr("Same on all")], ["1", tr("Different on each")]])) : "",
      row(tr("Random at startup"), tr("Picks a random wallpaper each time Backdrop starts."), offOn("rotOnStart", r.onStart)),
      row(tr("Random after waking"), tr("Picks a random wallpaper when the computer wakes from sleep, for example when you open the lid."), offOn("rotOnWake", r.onWake)),
      row(tr("Next wallpaper"), tr("Also in the {tray} menu.", { tray: trayName() }), `<button class="btn sm press" data-act="next">${ICON.cycle}${tr("Next")}</button>`),
    ].join(""))}
    ${section(tr("Schedule"), tr("At each time the wallpaper changes to the one picked, for example a light one for the day and a dark one for the evening. Rotation, if it's on, carries on from there."), scheduleRows())}
    ${section(tr("Saving power"), "", [
      row(tr("Pause when covered"), tr("Stops a wallpaper while a maximized or fullscreen app hides it."), offOn("pauseCovered", c.pauseCovered)),
      row(tr("Pause when an app is in front"), tr("Plays only while the desktop has focus on that display."), offOn("pauseFocused", c.pauseFocused)),
      row(tr("Pause on battery"), "", offOn("pauseBattery", c.pauseBattery)),
      row(tr("Pause with battery saver on"), "", offOn("pauseLowPower", c.pauseLowPower)),
      row(tr("Pause when locked"), "", offOn("pauseLocked", c.pauseLocked)),
      appRuleRows(),
    ].join(""))}
    ${section(tr("App"), "", [
      u ? row(tr("Updates"), updHint, updBtn) : "",
      row(tr("Language"), "", seg("language", c.language, langs)),
      row(tr("Start at login"), tr("Starts in the {tray} without opening this window.", { tray: trayName() }), offOn("autostart", S.state.autostart)),
      row(tr("Library folder"), `<span class="mono">${esc(S.state.libraryDir)}</span>`, `<button class="btn sm press" data-act="openDir">${tr("Open")}</button>`),
      row(tr("Quick tour"), tr("A 20-second look around the app."), `<button class="btn sm press" data-act="tour">${tr("Show")}</button>`),
      row(tr("Update Workshop wallpapers"), tr("When Steam downloads a new version of a Workshop wallpaper, it replaces the one in your library. Its name, settings and place stay."), offOn("workshopUpdates", c.workshopUpdates)),
      hidden ? row(tr("Hidden in the Workshop"), tr("{n} hidden (single wallpapers and creators).", { n: hidden }), `<button class="btn sm press" data-act="wsUnhide">${tr("Show again")}</button>`) : "",
      row(tr("Reset settings"), tr("Keeps your library."), `<button class="btn sm danger press" data-act="reset">${tr("Reset")}</button>`),
    ].join(""))}
    </div></div>
  </div>`;
}

function render() {
  if (!S.state) return;
  renderNav();
  const html = S.tab === "displays" ? renderDisplays() : S.tab === "settings" ? renderSettings() : S.tab === "workshop" ? renderWorkshop() : renderLibrary();
  morph($("#page"), html);
  // An open dialog takes the focus, and gives it back to its tile when it closes.
  const dlg = $("#page .dialog");
  if (dlg && !dlg.contains(document.activeElement)) dlg.querySelector(".dlg-foot button:not([disabled])")?.focus({ preventScroll: true });
  else if (!dlg && S.ws.focusBack) $(`#page .tile[data-id="${S.ws.focusBack}"]`)?.focus({ preventScroll: true });
  S.ws.focusBack = dlg ? S.ws.sel : null;
  syncScroll();
}

// Tab and Shift+Tab cycle through the buttons and fields in `box` instead of leaving it.
function trapTab(ev, box) {
  if (!box) return;
  const f = [...box.querySelectorAll("button:not([disabled]), input, select, [tabindex]:not([tabindex='-1'])")];
  if (!f.length) return;
  const i = f.indexOf(document.activeElement);
  const next = ev.shiftKey ? (i <= 0 ? f.length - 1 : i - 1) : (i < 0 || i === f.length - 1 ? 0 : i + 1);
  ev.preventDefault();
  f[next].focus();
}

// Near the bottom of the Workshop the next page loads without a click.
function syncScroll() {
  const wrap = $("#page").querySelector(".grid-wrap");
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

listen("update", (e) => {
  S.upd = e.payload;
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
  const [state, upd] = await Promise.all([invoke("get_state"), invoke("update_state")]);
  // An event that arrived meanwhile is newer than these.
  S.state ??= state;
  S.upd ??= upd;
  document.body.classList.add("os-" + S.state.platform);
  LANG = S.state.lang;
  translateStatic();
  render();
  queueThumbs();
  maybeTour();
})();
