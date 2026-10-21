// Backdrop library window. Plain JS, no build step: render() builds HTML strings and morph()
// patches them into the page so nothing flashes on updates. Text goes through tr() (i18n.js).

const { invoke, convertFileSrc } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;
const appWindow = window.__TAURI__.window.getCurrentWindow();

const MEDIA = convertFileSrc("", "media");
const $ = (s) => document.querySelector(s);

const S = {
  tab: "library",
  filter: "all", // all | local | remote | rotation
  query: "",
  sel: null, // selected item id
  state: null, // StateView from Rust
  remote: null, // items on the server, or null when not loaded / not set up
  remoteError: null,
  jobs: [], // conversions on the server
  conv: { h: 1080, fps: 0 }, // chosen options for a new conversion
  tx: {}, // id -> { dir, done, total, state }
  thumbVer: {}, // id -> cache buster after a new thumbnail
  serverDraft: null,
  serverStatus: null, // { ok, text }
  videoViaLoopback: false,
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
  computer: '<svg viewBox="0 0 16 16"><rect x="2" y="3" width="12" height="8" rx="1.2"/><path d="M6 14h4M8 11v3"/></svg>',
  cloud: '<svg viewBox="0 0 16 16"><path d="M4.5 12.5h7a3 3 0 0 0 .4-5.97A4 4 0 0 0 4.2 7.6 2.5 2.5 0 0 0 4.5 12.5z"/></svg>',
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
  const map = new Map();
  for (const it of S.state?.items ?? []) map.set(it.id, { ...it, local: true, remote: false });
  for (const it of S.remote ?? []) {
    const e = map.get(it.id);
    if (e) {
      e.remote = true;
      // The server probes every upload; fill in what this computer couldn't work out.
      e.codec ??= it.codec;
      e.fps ??= it.fps;
      e.width ??= it.width;
      e.height ??= it.height;
    } else map.set(it.id, { ...it, local: false, remote: true });
  }
  return [...map.values()].sort((a, b) => b.added - a.added || a.name.localeCompare(b.name));
}

const pool = () => S.state?.config.rotation.pool ?? [];
const inRotation = (id) => pool().includes(id);

function thumbUrl(e) {
  if (e.local) {
    if (e.thumb) return mediaUrl(`${e.id}/thumb.jpg`) + `?v=${S.thumbVer[e.id] ?? 0}`;
    // A local copy without a thumbnail can still borrow the server's.
    const r = S.remote?.find((x) => x.id === e.id);
    return r?.thumb ? `${S.state.config.server}/api/items/${e.id}/thumb` : null;
  }
  if (e.thumb && S.state.config.server) return `${S.state.config.server}/api/items/${e.id}/thumb`;
  return null;
}

function liveOn(id) {
  return (S.state?.displays ?? []).filter((d) => d.item === id);
}

async function refreshRemote() {
  if (!S.state?.config.server) {
    S.remote = null;
    S.remoteError = null;
    S.jobs = [];
    return render();
  }
  try {
    S.remote = await invoke("remote_items");
    S.remoteError = null;
  } catch (e) {
    S.remoteError = String(e);
  }
  render();
  refreshJobs();
}

// Conversions run on the server; poll while any is unfinished.
async function refreshJobs() {
  clearTimeout(refreshJobs.timer);
  if (!S.state?.config.server) return;
  let jobs;
  try {
    jobs = await invoke("remote_jobs");
  } catch {
    return; // an older server without conversions
  }
  const before = new Map(S.jobs.map((j) => [j.id, j.state]));
  S.jobs = jobs;
  let finished = false;
  for (const j of jobs) {
    const was = before.get(j.id);
    if (was && was !== j.state && (j.state === "done" || j.state === "error")) {
      finished = true;
      if (j.state === "done") toast(tr("Converted copy is ready: {label}", { label: j.label }));
      else toast(tr("Conversion failed: {error}", { error: j.error }), true);
    }
  }
  render();
  if (finished) refreshRemote();
  if (jobs.some((j) => j.state === "queued" || j.state === "running")) refreshJobs.timer = setTimeout(refreshJobs, 2000);
}

// ---------- thumbnails ----------
// Local items get their thumbnail from a frame the webview decodes here, so clients need no ffmpeg.

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
  tab: (el) => { S.tab = el.dataset.tab; render(); refreshRemote(); },
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
  upload: async (el) => {
    await call("upload", { id: el.dataset.id }, tr("Uploaded to the server"));
    refreshRemote();
  },
  download: async (el) => { await call("download", { id: el.dataset.id }, tr("Downloaded")); },
  convH: (el) => { S.conv.h = Number(el.dataset.v); render(); },
  convFps: (el) => { S.conv.fps = Number(el.dataset.v); render(); },
  convert: async (el) => {
    await call("convert_remote", { id: el.dataset.id, maxHeight: S.conv.h || null, maxFps: S.conv.fps || null }, tr("Converting on the server…"));
    refreshJobs();
  },
  removeLocal: async (el) => {
    const e = entries().find((x) => x.id === el.dataset.id);
    if (!e) return;
    if (!e.remote && !confirm(tr('"{name}" isn\'t on the server. Remove it from this computer for good?', { name: e.name }))) return;
    await call("delete_local", { id: e.id });
    if (!e.remote && S.sel === e.id) S.sel = null;
  },
  removeRemote: async (el) => {
    const e = entries().find((x) => x.id === el.dataset.id);
    if (!e || !confirm(tr('Delete "{name}" from the shared library? Other computers will lose access to it.', { name: e.name }))) return;
    await call("delete_remote", { id: e.id }, tr("Deleted from the server"));
    if (!e.local && S.sel === e.id) S.sel = null;
    refreshRemote();
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
  connect: async () => {
    const url = S.serverDraft ?? S.state.config.server;
    S.serverStatus = { ok: true, text: tr("Checking…") };
    render();
    try {
      const saved = await invoke("test_server", { url });
      S.serverDraft = null;
      S.serverStatus = saved ? { ok: true, text: tr("Connected") } : { ok: true, text: tr("Sharing is off") };
      await refreshRemote();
      if (saved && S.remote) S.serverStatus = { ok: true, text: connectedText() };
    } catch (e) {
      S.serverStatus = { ok: false, text: String(e) };
    }
    render();
  },
  disconnect: async () => {
    await invoke("test_server", { url: "" });
    S.serverDraft = null;
    S.serverStatus = null;
    refreshRemote();
  },
  openDir: () => call("open_library_dir"),
  freeSpace: async () => {
    if (!confirm(tr("Remove the copies on this computer of wallpapers that are also on the server and not showing right now? They download again when you pick them."))) return;
    const r = await call("free_space");
    const size = fmtSize(r.bytes);
    toast(!r.count ? tr("Nothing to free up") : r.count === 1 ? tr("Freed {size} (1 wallpaper)", { size }) : tr("Freed {size} ({n} wallpapers)", { size, n: r.count }));
  },
  reset: async () => {
    if (!confirm(tr("Put every setting back to its default? Your library and server address stay; wallpapers are cleared from the displays."))) return;
    await call("reset_settings", {}, tr("Settings reset"));
  },
};

const connectedText = () => tr("Connected · {n} in the shared library", { n: S.remote.length });

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

document.addEventListener("input", (ev) => {
  if (ev.target.id === "search") { S.query = ev.target.value; render(); }
  if (ev.target.id === "addr") S.serverDraft = ev.target.value;
  if (ev.target.id === "volume") {
    clearTimeout(S.volTimer);
    const v = Number(ev.target.value) / 100;
    S.volTimer = setTimeout(() => setting({ volume: v }), 120);
  }
});

document.addEventListener("keydown", (ev) => {
  if (ev.target.id === "addr" && ev.key === "Enter") actions.connect();
  if (ev.target.classList?.contains("name-in")) {
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
    await invoke("rename_item", { id: e.id, name, remote: e.remote });
    if (e.remote) refreshRemote();
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
  const tabs = [["library", tr("Library")], ["displays", tr("Displays")], ["settings", tr("Settings")]];
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
  const tx = S.tx[e.id];
  const pct = tx && tx.state === "active" && tx.total ? Math.round((100 * tx.done) / tx.total) : null;
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
      ${pct !== null ? `<div class="bar" style="width:${pct}%"></div>` : ""}
    </div>
    <div class="t-name">${esc(e.name)}</div>
    <div class="t-meta"><span>${meta}</span>
      <span class="where"><span class="${e.local ? "on" : ""}" title="${esc(tr(e.local ? "On this computer" : "Not on this computer"))}">${ICON.computer}</span>${S.state.config.server ? `<span class="${e.remote ? "on" : ""}" title="${esc(tr(e.remote ? "In the shared library" : "Not on the server yet"))}">${ICON.cloud}</span>` : ""}</span>
    </div>
  </button>`;
}

function convertHtml(e) {
  if (e.kind !== "video" || !S.state.config.server) return "";
  const mine = S.jobs.filter((j) => j.source === e.id);
  const active = mine.filter((j) => j.state === "queued" || j.state === "running");
  const rows = mine.slice(-3).map((j) => {
    const what = j.state === "running" ? `${Math.round(j.progress * 100)}%` : j.state === "queued" ? tr("Waiting") : j.state === "done" ? tr("Done") : tr("Failed");
    return `<div class="job"><span>${esc(j.label)}</span><span class="${j.state === "error" ? "err" : "muted"}" title="${esc(j.error ?? "")}">${esc(what)}</span></div>
      ${j.state === "running" ? `<div class="progress"><div style="width:${Math.round(j.progress * 100)}%"></div></div>` : ""}`;
  }).join("");
  const body = e.remote
    ? `<div class="opt"><span class="muted">${tr("Size")}</span>${seg("convH", S.conv.h, [["0", tr("Original")], ["2160", "4K"], ["1440", "1440p"], ["1080", "1080p"], ["720", "720p"]])}</div>
       <div class="opt"><span class="muted">${tr("Frame rate")}</span>${seg("convFps", S.conv.fps, [["0", tr("Original")], ["60", "60"], ["30", "30"], ["24", "24"]])}</div>
       <button class="act" data-act="convert" data-id="${e.id}" ${active.length ? "disabled" : ""}>${tr("Make an H.264 copy")}</button>
       ${rows}`
    : `<div class="hint">${tr("Upload it to the server first; the server does the converting.")}</div>`;
  return `<div class="section">
    <span class="label">${tr("Lighter copy")}</span>
    <div class="stack">
      <div class="hint">${tr("H.264 plays on every computer. A smaller size or lower frame rate uses less power. The copy is added to the shared library next to the original.")}</div>
      ${body}
    </div>
  </div>`;
}

function detailHtml(e) {
  if (!e) {
    return `<div class="nodetail">${tr("Pick a wallpaper to see it here.")}<br>${tr("Drop files anywhere in this window to add them.")}</div>`;
  }
  const server = !!S.state.config.server;
  const tx = S.tx[e.id];
  const busy = S.state.transfers.includes(e.id);
  const live = liveOn(e.id);
  const displays = S.state.displays;
  const t = thumbUrl(e);
  let preview;
  if (e.local && e.kind === "video") {
    preview = `<video data-key="pv-${e.id}-${S.videoViaLoopback ? "l" : "m"}" src="${esc(videoUrl(`${e.id}/${e.file}`))}" ${t ? `poster="${esc(t)}"` : ""} autoplay muted loop playsinline onerror="mediaVideoFailed()"></video>`;
  } else if (e.local && e.kind === "image") {
    preview = `<img data-key="pi-${e.id}" src="${esc(mediaUrl(`${e.id}/${e.file}`))}" draggable="false">`;
  } else if (t) {
    preview = `<img data-key="pt-${e.id}" src="${esc(t)}" draggable="false">`;
  } else {
    preview = placeholder(e, `pp-${e.id}`);
  }
  const where = e.local && e.remote ? tr("This computer and the server") : e.local ? tr("This computer only") : tr("Server only");
  const pct = tx && tx.total ? Math.round((100 * tx.done) / tx.total) : 0;
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
      <dt>${tr("Stored")}</dt><dd>${where}</dd>
      ${live.length ? `<dt>${tr("Showing")}</dt><dd>${live.map((d) => esc(d.name)).join(", ")}</dd>` : ""}
    </dl>
    ${cantPlayHere(e) ? `<div class="warn">${tr("Windows can't play {codec} video. Make an H.264 copy below and use that here.", { codec: codecName(e.codec) })}</div>` : ""}

    <div class="section">
      <span class="label">${tr("Wallpaper")}</span>
      <div class="stack">
        <button class="act primary" data-act="setAll" data-id="${e.id}" ${busy ? "disabled" : ""}><span>${displays.length > 1 ? tr("Set on all displays") : tr("Set as wallpaper")}</span></button>
        ${displays.length > 1 ? `<div class="row">${displays.map((d) => `<button class="act" data-act="setOn" data-id="${e.id}" data-display="${esc(d.key)}" ${busy ? "disabled" : ""}>${esc(tr("Only {name}", { name: d.name }))}</button>`).join("")}</div>` : ""}
        <button class="act ${rot ? "on" : ""}" data-act="rotation" data-id="${e.id}">${ICON.cycle} ${rot ? tr("In rotation (click to remove)") : tr("Add to rotation")}</button>
        ${!e.local ? `<div class="hint">${tr("It downloads to this computer first, then plays from disk.")}</div>` : ""}
      </div>
    </div>

    ${server ? `<div class="section">
      <span class="label">${tr("Shared library")}</span>
      <div class="stack">
        ${busy ? `<div class="progress"><div style="width:${pct}%"></div></div><div class="hint">${tx?.dir === "up" ? tr("Uploading…") : tr("Downloading…")} ${pct}%</div>` : ""}
        ${!busy && e.local && !e.remote ? `<button class="act" data-act="upload" data-id="${e.id}">${ICON.cloud} ${tr("Upload to the server")}</button>` : ""}
        ${!busy && !e.local && e.remote ? `<button class="act" data-act="download" data-id="${e.id}">${ICON.computer} ${tr("Download to this computer")}</button>` : ""}
        ${!busy && e.local && e.remote ? `<div class="hint">${tr("Synced with the server.")}</div>` : ""}
      </div>
    </div>` : ""}

    ${convertHtml(e)}

    <div class="section">
      <span class="label">${tr("Remove")}</span>
      <div class="stack">
        ${e.local ? `<button class="act danger" data-act="removeLocal" data-id="${e.id}" ${busy ? "disabled" : ""}>${tr("Remove from this computer")}</button>` : ""}
        ${e.remote ? `<button class="act danger" data-act="removeRemote" data-id="${e.id}" ${busy ? "disabled" : ""}>${tr("Delete from the server")}</button>` : ""}
      </div>
    </div>
  </div>`;
}

function renderLibrary() {
  const all = entries();
  const q = S.query.trim().toLowerCase();
  const match = { all: () => true, local: (e) => e.local, remote: (e) => e.remote, rotation: (e) => inRotation(e.id) };
  const counts = Object.fromEntries(Object.entries(match).map(([k, f]) => [k, all.filter(f).length]));
  const shown = all.filter((e) => (match[S.filter] ?? match.all)(e) && (!q || e.name.toLowerCase().includes(q)));
  const sel = all.find((e) => e.id === S.sel) ?? null;
  const server = !!S.state.config.server;
  const filters = [["all", tr("All")], ["local", tr("This computer")], ...(server ? [["remote", tr("On the server")]] : []), ...(counts.rotation ? [["rotation", tr("Rotation")]] : [])];

  let body;
  if (!all.length) {
    body = `<div class="empty"><h2>${tr("Your library is empty")}</h2>
      ${tr("Drop videos (MP4, WebM, MOV), images, GIFs or HTML wallpapers anywhere in this window.")}
      ${server ? "" : `<br>${tr("To share a library between your computers, add a server in Settings.")}`}
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
        ${S.remoteError ? `<span class="err" title="${esc(S.remoteError)}">${tr("Server offline")}</span>` : ""}
        <button class="act" data-act="pick" data-folder="0">${ICON.plus} ${tr("Add files")}</button>
        <button class="act" data-act="pick" data-folder="1">${ICON.folder} ${tr("Add HTML folder")}</button>
      </div>
      <div class="grid-wrap">${body}</div>
    </div>
    <aside class="detail">${detailHtml(sel)}</aside>
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
  const draft = S.serverDraft ?? c.server;
  const st = S.serverStatus ?? (c.server ? (S.remoteError ? { ok: false, text: S.remoteError } : S.remote ? { ok: true, text: connectedText() } : null) : null);
  const bar = tr("taskbar");
  const poolHint = r.pool.length
    ? tr("Rotates through the {n} wallpapers marked for rotation in the Library.", { n: r.pool.length })
    : tr("Rotates through every wallpaper on this computer. Mark some with Add to rotation in the Library to narrow it down.");
  const speeds = [["0.5", "0.5×"], ["0.75", "0.75×"], ["1", "1×"], ["1.25", "1.25×"], ["1.5", "1.5×"], ["2", "2×"]];
  const langs = [["", tr("System")], ["en", "English"], ["es", "Español"], ["de", "Deutsch"], ["zh-Hans", "简体中文"]];

  return `<div class="page" data-key="p-settings"><div class="scroll"><div class="narrow">
    <div class="set-sec">
      <span class="label">${tr("Shared library")}</span>
      <div class="set-row">
        <input id="addr" class="addr mono" placeholder="https://server.your-tailnet.ts.net:8448" value="${esc(draft)}" spellcheck="false">
        <button class="act primary" data-act="connect"><span>${c.server && draft === c.server ? tr("Check") : tr("Connect")}</span></button>
        ${c.server ? `<button class="act" data-act="disconnect">${tr("Turn off")}</button>` : ""}
      </div>
      <p class="hint">${st ? `<span class="${st.ok ? "ok" : "err"}">${esc(st.text)}</span><br>` : ""}${tr("The address of your Backdrop server. Open the same address in a browser to see the library and upload from any device.")}</p>
    </div>

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
      ${c.server ? row(tr("Free up space"), tr("Removes this computer's copies of wallpapers that are also on the server and not showing. They download again when picked."), `<button class="act" data-act="freeSpace">${tr("Free up")}</button>`) : ""}
      ${row(tr("Reset settings"), tr("Keeps your library and server address."), `<button class="act danger" data-act="reset">${tr("Reset")}</button>`)}
      <p class="hint">${tr("Backdrop {version}. Closing this window keeps wallpapers running; quit from the {tray} icon.", { version: esc(S.state.version), tray: trayName() })}</p>
    </div>
  </div></div></div>`;
}

function render() {
  if (!S.state) return;
  renderTitle();
  const html = S.tab === "displays" ? renderDisplays() : S.tab === "settings" ? renderSettings() : renderLibrary();
  morph($("#page"), html);
}

// ---------- events ----------

function setLang(lang) {
  if (lang === LANG) return;
  LANG = lang;
  translateStatic();
}

listen("state", (e) => {
  const hadServer = S.state?.config.server;
  S.state = e.payload;
  setLang(S.state.lang);
  if (S.state.config.server !== hadServer) refreshRemote();
  queueThumbs();
  render();
});

listen("transfer", (e) => {
  const t = e.payload;
  S.tx[t.id] = t;
  if (t.state === "error") toast(t.error || tr("Transfer failed"), true);
  if (t.state !== "active") setTimeout(() => { if (S.tx[t.id] === t) { delete S.tx[t.id]; render(); } }, 400);
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

window.addEventListener("focus", () => { if (S.state?.config.server) refreshRemote(); });
setInterval(() => { if (S.state?.config.server && document.visibilityState === "visible") refreshRemote(); }, 60000);

(async () => {
  S.state = await invoke("get_state");
  document.body.classList.add("os-" + S.state.platform);
  LANG = S.state.lang;
  translateStatic();
  render();
  queueThumbs();
  refreshRemote();
})();
