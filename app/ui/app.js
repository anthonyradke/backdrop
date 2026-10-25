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
  sel: null, // selected item id
  state: null, // StateView from Rust
  thumbVer: {}, // id -> cache buster after a new thumbnail
  videoViaLoopback: false,
  // Workshop tab. view: discover | steam (what Steam already downloaded)
  ws: { view: "discover", sort: "week", genre: "", kind: "video", search: "", page: 1, items: null, more: false, loading: false, error: null, sel: null, seq: 0 },
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
  plus: '<svg viewBox="0 0 16 16"><path d="M8 3v10M3 8h10"/></svg>',
  folder: '<svg viewBox="0 0 16 16"><path d="M2 4.5A1.5 1.5 0 0 1 3.5 3h2.6l1.4 1.5h5A1.5 1.5 0 0 1 14 6v5.5a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 11.5z"/></svg>',
  cycle: '<svg viewBox="0 0 16 16"><path d="M13 5.5A5.5 5.5 0 0 0 3.2 6M3 10.5A5.5 5.5 0 0 0 12.8 10"/><path d="M13 2.5v3h-3M3 13.5v-3h3"/></svg>',
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
// Thumbnails come from a frame the webview decodes here, so there's no ffmpeg to ship.

const thumbQueue = new Set();
let thumbBusy = false;

function queueThumbs() {
  for (const it of S.state?.items ?? []) if (!it.thumb && it.kind !== "web" && !thumbQueue.has(it.id) && !thumbFailed.has(it.id)) thumbQueue.add(it.id);
  pumpThumbs();
}
const thumbFailed = new Set();

async function pumpThumbs() {
  if (thumbBusy) return;
  const id = thumbQueue.values().next().value;
  if (!id) return;
  thumbQueue.delete(id);
  const it = S.state.items.find((i) => i.id === id);
  if (!it || it.thumb) return pumpThumbs();
  thumbBusy = true;
  try {
    const src = (it.kind === "video" ? videoUrl : mediaUrl)(`${it.id}/${it.file}`);
    const { data, width, height } = await grabFrame(src, it.kind).catch((e) => {
      // One retry over loopback if media:// can't decode video here.
      if (it.kind === "video" && mediaVideoFailed()) return grabFrame(videoUrl(`${it.id}/${it.file}`), it.kind);
      throw e;
    });
    await invoke("save_thumb", { id, data, width, height });
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
    const draw = (w, h) => {
      const W = 480, H = Math.round((480 * h) / w) || 270;
      const c = document.createElement("canvas");
      c.width = W; c.height = H;
      c.getContext("2d").drawImage(el, 0, 0, W, H);
      cleanup();
      resolve({ data: c.toDataURL("image/jpeg", 0.82), width: w, height: h });
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
  wsView: (el) => { S.ws.view = el.dataset.v; S.ws.sel = null; wsLoad(); },
  wsSort: (el) => { S.ws.sort = el.dataset.v; wsLoad(); },
  wsKind: (el) => { S.ws.kind = el.dataset.v; wsLoad(); },
  wsMore: () => wsLoad(true),
  wsRetry: () => wsLoad(),
  wsSelect: (el) => { S.ws.sel = S.ws.sel === el.dataset.id ? null : el.dataset.id; render(); },
  wsSubscribe: (el) => call("workshop_subscribe", { id: el.dataset.id }, tr("Opened in Steam. Subscribe there; Backdrop adds it once Steam has downloaded it.")),
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
    if (!S.ws.items.some((i) => i.id === S.ws.sel)) S.ws.sel = null;
    render();
  },
  wsUnhide: () => call("workshop_unhide_all", {}, tr("Hidden wallpapers will show again")),
  wsShow: (el) => { S.tab = "library"; S.filter = "all"; S.query = ""; S.sel = el.dataset.item; render(); },
  filter: (el) => { S.filter = el.dataset.f; render(); },
  pick: async (el) => importResult(await call("pick_files", { folder: el.dataset.folder === "1" })),
  select: (el) => { S.sel = S.sel === el.dataset.id ? null : el.dataset.id; render(); },
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
  } else if (ev.key === "Escape" && S.sel) { S.sel = null; render(); }
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
  morph($("#tabs"), tabs.map(([k, t]) => `<button class="nav-tab ${S.tab === k ? "on" : ""}" data-act="tab" data-tab="${k}">${t}</button>`).join(""));
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

function tileHtml(e) {
  const t = thumbUrl(e);
  const live = liveOn(e.id);
  const meta = [e.width ? `${e.width}×${e.height}` : null, fmtSize(e.size)].filter(Boolean).join(" · ");
  const res = resLabel(e);
  return `<button class="tile ${S.sel === e.id ? "sel" : ""}" data-act="select" data-id="${e.id}" data-key="t-${e.id}">
    <div class="thumb">
      ${t ? `<img src="${esc(t)}" loading="lazy" draggable="false" onerror="this.remove()">` : ""}
      ${t ? "" : placeholder(e)}
      <span class="badge">${esc(kindLabel(e))}</span>
      ${res ? `<span class="res">${res}</span>` : ""}
      ${inRotation(e.id) ? `<span class="rot" title="${esc(tr("In rotation"))}">${ICON.cycle}</span>` : ""}
      ${live.length ? `<span class="livetag"><span class="dot ${live[0].status}"></span>${live.length > 1 ? esc(tr("{n} displays", { n: live.length })) : esc(live[0].name)}</span>` : ""}
    </div>
    <div class="t-name">${esc(e.name)}</div>
    <div class="t-meta"><span>${meta}</span></div>
  </button>`;
}

function detailHtml(e) {
  if (!e) {
    return `<div class="nodetail">${tr("Pick a wallpaper to see it here.")}<br>${tr("Drop files anywhere in this window to add them.")}</div>`;
  }
  const live = liveOn(e.id);
  const displays = S.state.displays;
  const t = thumbUrl(e);
  let preview;
  if (e.kind === "video") {
    preview = `<video data-key="pv-${e.id}-${S.videoViaLoopback ? "l" : "m"}" src="${esc(videoUrl(`${e.id}/${e.file}`))}" ${t ? `poster="${esc(t)}"` : ""} autoplay muted loop playsinline onerror="mediaVideoFailed()"></video>`;
  } else if (e.kind === "image") {
    preview = `<img data-key="pi-${e.id}" src="${esc(mediaUrl(`${e.id}/${e.file}`))}" draggable="false">`;
  } else if (t) {
    preview = `<img data-key="pt-${e.id}" src="${esc(t)}" draggable="false">`;
  } else {
    preview = placeholder(e, `pp-${e.id}`);
  }
  const type = e.kind === "web" ? tr("HTML page") : kindLabel(e) === "GIF" ? tr("Animated GIF") : e.kind === "video" ? tr("Video") : tr("Image");
  const video = [e.codec ? codecName(e.codec) : null, e.fps ? `${Math.round(e.fps * 100) / 100} fps` : null].filter(Boolean).join(" · ");
  const rot = inRotation(e.id);

  return `<div data-key="d-${e.id}">
    <div class="preview">${preview}</div>
    <input class="name-in" data-id="${e.id}" data-orig="${esc(e.name)}" value="${esc(e.name)}" spellcheck="false" title="${esc(tr("Rename"))}">
    <dl class="facts">
      <dt>${tr("Type")}</dt><dd>${esc(type)}</dd>
      ${e.width ? `<dt>${tr("Size")}</dt><dd>${e.width}×${e.height}${resLabel(e) ? ` · ${resLabel(e)}` : ""}</dd>` : ""}
      ${video ? `<dt>${tr("Video")}</dt><dd>${esc(video)}</dd>` : ""}
      <dt>${tr("File")}</dt><dd>${fmtSize(e.size)}</dd>
      <dt>${tr("Added")}</dt><dd>${fmtDate(e.added)}</dd>
      ${live.length ? `<dt>${tr("Showing")}</dt><dd>${live.map((d) => esc(d.name)).join(", ")}</dd>` : ""}
    </dl>
    ${cantPlayHere(e) ? `<div class="warn">${tr("Windows can't play {codec} video. Convert it to H.264 (HandBrake works) and add that instead.", { codec: codecName(e.codec) })}</div>` : ""}

    <div class="section">
      <span class="label">${tr("Wallpaper")}</span>
      <div class="stack">
        <button class="act primary" data-act="setAll" data-id="${e.id}"><span>${displays.length > 1 ? tr("Set on all displays") : tr("Set as wallpaper")}</span></button>
        ${displays.length > 1 ? `<div class="row">${displays.map((d) => `<button class="act" data-act="setOn" data-id="${e.id}" data-display="${esc(d.key)}">${esc(tr("Only {name}", { name: d.name }))}</button>`).join("")}</div>` : ""}
        <button class="act ${rot ? "on" : ""}" data-act="rotation" data-id="${e.id}">${ICON.cycle} ${rot ? tr("In rotation (click to remove)") : tr("Add to rotation")}</button>
      </div>
    </div>

    <div class="section">
      <span class="label">${tr("Remove")}</span>
      <div class="stack">
        <button class="act danger" data-act="remove" data-id="${e.id}">${tr("Remove from the library")}</button>
      </div>
    </div>
  </div>`;
}

function renderLibrary() {
  const all = entries();
  const q = S.query.trim().toLowerCase();
  const match = { all: () => true, rotation: (e) => inRotation(e.id) };
  const counts = Object.fromEntries(Object.entries(match).map(([k, f]) => [k, all.filter(f).length]));
  const shown = all.filter((e) => (match[S.filter] ?? match.all)(e) && (!q || e.name.toLowerCase().includes(q)));
  const sel = all.find((e) => e.id === S.sel) ?? null;
  const filters = [["all", tr("All")], ...(counts.rotation ? [["rotation", tr("Rotation")]] : [])];

  let body;
  if (!all.length) {
    body = `<div class="empty"><h2>${tr("Your library is empty")}</h2>
      ${tr("Drop videos (MP4, WebM, MOV), images, GIFs or HTML wallpapers anywhere in this window.")}
      <div class="acts"><button class="act primary" data-act="pick" data-folder="0">${ICON.plus}<span>${tr("Add files")}</span></button>
      <button class="act" data-act="pick" data-folder="1">${ICON.folder} ${tr("Add an HTML folder")}</button></div></div>`;
  } else if (!shown.length) {
    body = `<div class="empty">${tr("Nothing matches.")}</div>`;
  } else {
    body = `<div class="grid">${shown.map(tileHtml).join("")}</div>`;
  }

  return `<div class="page" data-key="p-library">
    <div class="lib-main">
      <div class="toolbar">
        <div class="filters">${filters.map(([k, t]) => `<button class="filter ${S.filter === k ? "on" : ""}" data-act="filter" data-f="${k}">${t}<span class="n">${counts[k]}</span></button>`).join("")}</div>
        <input id="search" class="search" placeholder="${esc(tr("Search"))}" value="${esc(S.query)}" spellcheck="false">
        <span class="spacer"></span>
        <button class="act" data-act="pick" data-folder="0">${ICON.plus} ${tr("Add files")}</button>
        <button class="act" data-act="pick" data-folder="1">${ICON.folder} ${tr("Add HTML folder")}</button>
      </div>
      <div class="grid-wrap">${body}</div>
    </div>
    <aside class="detail">${detailHtml(sel)}</aside>
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
const wsThumb = (url) => (url.includes("steamusercontent.com") ? url + "?imw=480&imh=270&ima=fit&impolicy=Letterbox&letterbox=false" : url);
const wsLib = (id) => S.state.workshop.inLibrary[id];
const wsPending = (id) => S.state.workshop.pending.includes(id);
const wsKindLabel = (i) => (i.kind === "web" ? "HTML" : tr("Video"));
// "3840 x 2160" -> resLabel's "4K"; odd tags like "Ultrawide 3440 x 1440" still parse.
function wsRes(i) {
  const m = i.resolution?.match(/(\d+)\s*x\s*(\d+)/);
  return m ? resLabel({ width: +m[1], height: +m[2] }) : null;
}

function wsTileHtml(i) {
  const lib = wsLib(i.id);
  const res = wsRes(i);
  const state = lib ? tr("In your library") : wsPending(i.id) ? tr("Waiting for Steam") : "";
  return `<button class="tile ${S.ws.sel === i.id ? "sel" : ""}" data-act="wsSelect" data-id="${i.id}" data-key="w-${i.id}">
    <div class="thumb">
      ${i.preview ? `<img src="${esc(wsThumb(i.preview))}" loading="lazy" draggable="false" onerror="this.remove()">` : `<div class="ph ${i.kind}"><span>${i.kind === "web" ? "&lt;/&gt;" : esc(wsKindLabel(i))}</span></div>`}
      <span class="badge">${esc(wsKindLabel(i))}</span>
      ${res ? `<span class="res">${res}</span>` : ""}
      ${state ? `<span class="livetag"><span class="dot ${lib ? "playing" : "paused"}"></span>${esc(state)}</span>` : ""}
    </div>
    <div class="t-name">${esc(i.title)}</div>
    <div class="t-meta"><span>${[i.genres.map(tr).join(", "), i.size ? fmtSize(i.size) : null].filter(Boolean).join(" · ")}</span></div>
  </button>`;
}

function wsDetailHtml(i) {
  if (!i) {
    return `<div class="nodetail">${tr("Pick a wallpaper to see it here.")}<br>${tr("Anime wallpapers are left out. If one slips through, hide it.")}</div>`;
  }
  const lib = wsLib(i.id);
  const pending = wsPending(i.id);
  const inSteam = S.ws.view === "steam";
  let acts;
  if (lib) {
    acts = `<button class="act primary" data-act="wsShow" data-item="${lib}"><span>${tr("Show in the library")}</span></button>`;
  } else if (inSteam) {
    acts = `<button class="act primary" data-act="wsAdd" data-id="${i.id}"><span>${tr("Add to library")}</span></button>`;
  } else {
    acts = `<button class="act primary" data-act="wsSubscribe" data-id="${i.id}"><span>${pending ? tr("Open in Steam again") : tr("Subscribe in Steam")}</span></button>
      ${pending ? `<div class="hint">${tr("Backdrop adds it to your library as soon as Steam has downloaded it.")}</div>` : ""}
      <button class="act" data-act="wsAdd" data-id="${i.id}">${tr("Already downloaded? Add it now")}</button>`;
  }
  return `<div data-key="wd-${i.id}">
    <div class="preview">${i.preview ? `<img data-key="wp-${i.id}" src="${esc(i.preview)}" draggable="false">` : ""}</div>
    <div class="ws-title">${esc(i.title)}</div>
    <dl class="facts">
      <dt>${tr("Type")}</dt><dd>${esc(i.kind === "web" ? tr("HTML page") : tr("Video"))}</dd>
      ${i.resolution ? `<dt>${tr("Size")}</dt><dd>${esc(i.resolution)}${wsRes(i) ? ` · ${wsRes(i)}` : ""}</dd>` : ""}
      ${i.size ? `<dt>${tr("File")}</dt><dd>${fmtSize(i.size)}</dd>` : ""}
      <dt>${tr("Genre")}</dt><dd>${esc(i.genres.map(tr).join(", "))}</dd>
      <dt>${tr("Subscribers")}</dt><dd>${i.subscriptions.toLocaleString()}</dd>
    </dl>
    ${i.description ? `<p class="hint ws-desc">${esc(i.description.replace(/\[[^\]]*\]/g, ""))}</p>` : ""}
    <div class="section">
      <span class="label">${tr("Wallpaper")}</span>
      <div class="stack">
        ${acts}
        <button class="act" data-act="wsOpen" data-id="${i.id}">${tr("Open the workshop page")}</button>
      </div>
    </div>
    <div class="section">
      <span class="label">${tr("Hide")}</span>
      <div class="stack">
        <button class="act danger" data-act="wsHide" data-id="${i.id}">${tr("Hide this wallpaper")}</button>
        ${i.creator ? `<button class="act danger" data-act="wsHide" data-id="${i.id}" data-creator="${esc(i.creator)}">${tr("Hide everything by this creator")}</button>` : ""}
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

  let body;
  if (w.error && !items.length) {
    body = `<div class="empty"><h2>${tr("Couldn't reach Steam")}</h2>${esc(w.error)}
      <div class="acts"><button class="act primary" data-act="wsRetry"><span>${tr("Try again")}</span></button></div></div>`;
  } else if (!w.items) {
    body = `<div class="empty">${tr("Loading…")}</div>`;
  } else if (!items.length) {
    body = `<div class="empty">${discover ? tr("Nothing matches.") : tr("Steam hasn't downloaded any video or HTML wallpapers for Wallpaper Engine.")}</div>`;
  } else {
    body = `<div class="grid">${items.map(wsTileHtml).join("")}</div>
      ${w.more || (w.loading && items.length) ? `<div class="ws-more"><button class="act" data-act="wsMore" ${w.loading ? "disabled" : ""}>${w.loading ? tr("Loading…") : tr("Load more")}</button></div>` : ""}`;
  }

  const note = S.state.workshop.steam ? "" :
    `<div class="warn ws-warn">${tr("Steam's Wallpaper Engine folder wasn't found. You can browse, but subscribing only downloads anything if Steam is installed and you own Wallpaper Engine (it has to stay installed; it doesn't have to run).")}</div>`;

  return `<div class="page" data-key="p-workshop">
    <div class="lib-main">
      <div class="toolbar">
        <div class="filters">${views.map(([k, t]) => `<button class="filter ${w.view === k ? "on" : ""}" data-act="wsView" data-v="${k}">${t}</button>`).join("")}</div>
        ${discover ? `<input id="ws-search" class="search" placeholder="${esc(tr("Search, then Enter"))}" value="${esc(w.search)}" spellcheck="false">
        <span class="spacer"></span>
        <select id="ws-genre" class="ws-select">${genres.map(([v, t]) => `<option value="${esc(v)}" ${w.genre === v ? "selected" : ""}>${esc(t)}</option>`).join("")}</select>` : `<span class="spacer"></span>`}
      </div>
      ${discover ? `<div class="toolbar ws-sub">
        ${seg("wsSort", w.sort, [["week", tr("Trending")], ["month", tr("Top this month")], ["year", tr("Top this year")], ["allTime", tr("Most subscribed")], ["newest", tr("Newest")]])}
        <span class="spacer"></span>
        ${seg("wsKind", w.kind, [["video", tr("Video")], ["web", "HTML"]])}
      </div>` : ""}
      ${note}
      <div class="grid-wrap">${body}</div>
    </div>
    <aside class="detail">${wsDetailHtml(sel)}</aside>
  </div>`;
}

function renderDisplays() {
  const ds = S.state.displays;
  const byId = new Map(entries().map((e) => [e.id, e]));
  let map = "";
  if (ds.length) {
    const minX = Math.min(...ds.map((d) => d.x)), minY = Math.min(...ds.map((d) => d.y));
    const maxX = Math.max(...ds.map((d) => d.x + d.width)), maxY = Math.max(...ds.map((d) => d.y + d.height));
    const W = 640, scale = Math.min(W / (maxX - minX), 260 / (maxY - minY));
    const H = Math.round((maxY - minY) * scale);
    map = `<div class="arrangement" style="height:${H}px;width:${Math.round((maxX - minX) * scale)}px">${ds.map((d) => {
      const e = d.item && byId.get(d.item);
      const t = e && thumbUrl(e);
      return `<div class="screen ${d.status === "playing" ? "live" : ""}" style="left:${Math.round((d.x - minX) * scale) + 2}px;top:${Math.round((d.y - minY) * scale) + 2}px;width:${Math.round(d.width * scale) - 4}px;height:${Math.round(d.height * scale) - 4}px;${t ? `background-image:url('${t}')` : ""}"><span class="cap">${esc(d.name)}${d.primary ? ` · ${tr("main")}` : ""}</span></div>`;
    }).join("")}</div>`;
  }
  const status = (d) =>
    d.status === "playing" ? tr("Playing")
    : d.status === "paused" ? tr(REASON[d.reason] ?? "Paused")
    : d.status === "image" ? tr("Still image (set as the system wallpaper)")
    : tr("Nothing set");
  const rows = ds.map((d) => {
    const e = d.item && byId.get(d.item);
    return `<div class="drow">
      <div><div class="dname">${esc(d.name)}</div><div class="sub">${d.width}×${d.height}${d.scale !== 1 ? ` · ${Math.round(d.scale * 100)}%` : ""}${d.primary ? ` · ${tr("main display")}` : ""}</div></div>
      <div class="now"><span class="dot ${d.status}"></span><span>${e ? esc(e.name) + " · " : ""}${esc(status(d))}</span></div>
      <div>${d.item ? `<button class="act" data-act="clearDisplay" data-display="${esc(d.key)}">${tr("Clear")}</button>` : ""}</div>
    </div>`;
  }).join("");
    return `<div class="page" data-key="p-displays"><div class="scroll"><div class="narrow">
    <span class="label">${tr("Displays")}</span>
    ${map}
    ${rows || `<div class="muted">${tr("No displays found.")}</div>`}
    <p class="hint">${tr("Choose wallpapers in the Library. Still images are handed to {os} as the normal wallpaper, so they cost nothing to show. Videos and HTML play behind your desktop icons and pause when they're covered.", { os: "Windows" })}</p>
  </div></div></div>`;
}

function seg(act, cur, opts) {
  return `<div class="seg">${opts.map(([v, t]) => `<button class="${String(cur) === v ? "on" : ""}" data-act="${act}" data-v="${v}">${t}</button>`).join("")}</div>`;
}
const offOn = (act, v) => seg(act, v ? "1" : "0", [["0", tr("Off")], ["1", tr("On")]]);
const row = (what, hint, control) =>
  `<div class="set-row"><div class="what">${what}${hint ? `<div class="hint">${hint}</div>` : ""}</div>${control}</div>`;

function renderSettings() {
  const c = S.state.config;
  const r = c.rotation;
  const bar = tr("taskbar");
  const poolHint = r.pool.length
    ? tr("Rotates through the {n} wallpapers marked for rotation in the Library.", { n: r.pool.length })
    : tr("Rotates through every wallpaper on this computer. Mark some with Add to rotation in the Library to narrow it down.");
  const speeds = [["0.5", "0.5×"], ["0.75", "0.75×"], ["1", "1×"], ["1.25", "1.25×"], ["1.5", "1.5×"], ["2", "2×"]];
  const langs = [["", tr("System")], ["en", "English"], ["es", "Español"], ["de", "Deutsch"], ["zh-Hans", "简体中文"]];

  return `<div class="page" data-key="p-settings"><div class="scroll"><div class="narrow">
    <div class="set-sec">
      <span class="label">${tr("Playback")}</span>
      ${row(tr("Fit"), tr("How wallpapers that don't match the screen's shape are scaled."),
        seg("fit", c.fit, [["cover", tr("Fill")], ["contain", tr("Fit")], ["height", tr("Fit height")], ["stretch", tr("Stretch")], ["center", tr("Center")]]))}
      ${row(tr("Speed"), tr("Playback speed for videos."), seg("speed", String(c.speed), speeds))}
      <div class="set-row"><div class="what">${tr("Sound")}<div class="hint">${tr("Videos and HTML wallpapers with audio.")}</div></div>
        ${c.muted ? "" : `<input id="volume" type="range" min="0" max="100" value="${Math.round(c.volume * 100)}">`}
        ${seg("muted", c.muted ? "1" : "0", [["1", tr("Muted")], ["0", tr("On")]])}</div>
      ${row(tr("Shade the {bar}", { bar }), tr("Darkens a strip of moving wallpapers under the {bar} so it stays readable.", { bar }), offOn("shadeBar", c.shadeBar))}
      ${row(tr("Match the system wallpaper"), tr("Sets a still frame of each moving wallpaper as the Windows wallpaper, so the desktop matches before Backdrop starts."), offOn("stillFrame", c.stillFrame))}
    </div>

    <div class="set-sec">
      <span class="label">${tr("Rotation")}</span>
      ${row(tr("Change wallpaper"), poolHint,
        seg("rotMinutes", r.minutes, [["0", tr("Never")], ["15", tr("15 min")], ["30", tr("30 min")], ["60", tr("1 hour")], ["180", tr("3 hours")], ["1440", tr("1 day")]]))}
      ${row(tr("Order"), "", seg("rotOrder", r.order, [["sequential", tr("In order")], ["shuffle", tr("Shuffle")]]))}
      ${S.state.displays.length > 1 ? row(tr("Displays"), "", seg("rotPerDisplay", r.perDisplay ? "1" : "0", [["0", tr("Same on all")], ["1", tr("Different on each")]])) : ""}
      ${row(tr("Random at startup"), tr("Picks a random wallpaper each time Backdrop starts."), offOn("rotOnStart", r.onStart))}
      ${row(tr("Random after waking"), tr("Picks a random wallpaper when the computer wakes from sleep, for example when you open the lid."), offOn("rotOnWake", r.onWake))}
      <div class="set-row"><div class="what">${tr("Next wallpaper")}<div class="hint">${tr("Also in the {tray} menu.", { tray: trayName() })}</div></div>
        <button class="act" data-act="next">${ICON.cycle} ${tr("Next")}</button></div>
    </div>

    <div class="set-sec">
      <span class="label">${tr("Saving power")}</span>
      ${row(tr("Pause when covered"), tr("Stops a wallpaper while a maximized or fullscreen app hides it."), offOn("pauseCovered", c.pauseCovered))}
      ${row(tr("Pause when an app is in front"), tr("Plays only while the desktop has focus on that display."), offOn("pauseFocused", c.pauseFocused))}
      ${row(tr("Pause on battery"), "", offOn("pauseBattery", c.pauseBattery))}
      ${row(tr("Pause with battery saver on"), "", offOn("pauseLowPower", c.pauseLowPower))}
      ${row(tr("Pause when locked"), "", offOn("pauseLocked", c.pauseLocked))}
    </div>

    <div class="set-sec">
      <span class="label">${tr("App")}</span>
      ${row(tr("Language"), "", seg("language", c.language, langs))}
      ${row(tr("Start at login"), tr("Starts in the {tray} without opening this window.", { tray: trayName() }), offOn("autostart", S.state.autostart))}
      <div class="set-row"><div class="what">${tr("Library folder")}<div class="hint mono">${esc(S.state.libraryDir)}</div></div>
        <button class="act" data-act="openDir">${tr("Open")}</button></div>
      ${(() => {
        const h = S.state.workshop.hidden;
        const n = h.items.length + h.creators.length;
        return n ? row(tr("Hidden in the Workshop"), tr("{n} hidden (single wallpapers and creators).", { n }),
          `<button class="act" data-act="wsUnhide">${tr("Show again")}</button>`) : "";
      })()}
      ${row(tr("Reset settings"), tr("Keeps your library."), `<button class="act danger" data-act="reset">${tr("Reset")}</button>`)}
      <p class="hint">${tr("Backdrop {version}. Closing this window keeps wallpapers running; quit from the {tray} icon.", { version: esc(S.state.version), tray: trayName() })}</p>
    </div>
  </div></div></div>`;
}

function render() {
  if (!S.state) return;
  renderTitle();
  const html = S.tab === "displays" ? renderDisplays() : S.tab === "settings" ? renderSettings() : S.tab === "workshop" ? renderWorkshop() : renderLibrary();
  morph($("#page"), html);
}

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
