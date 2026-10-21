// Backdrop library window. Plain JS, no build step: render() builds HTML strings and morph()
// patches them into the page so nothing flashes on updates.

const { invoke, convertFileSrc } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;
const appWindow = window.__TAURI__.window.getCurrentWindow();

const MEDIA = convertFileSrc("", "media");
const $ = (s) => document.querySelector(s);

const S = {
  tab: "library",
  filter: "all", // all | local | remote
  query: "",
  sel: null, // selected item id
  state: null, // StateView from Rust
  remote: null, // items on x1, or null when not loaded / not set up
  remoteError: null,
  tx: {}, // id -> { dir, done, total, state }
  thumbVer: {}, // id -> cache buster after a new thumbnail
  serverDraft: null,
  serverStatus: null, // { ok, text }
  videoViaLoopback: false,
};

// ---------- helpers ----------

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmtSize = (b) => (b >= 1e9 ? (b / 1e9).toFixed(1) + " GB" : b >= 1e6 ? (b / 1e6).toFixed(1) + " MB" : Math.max(1, Math.round(b / 1e3)) + " KB");
const fmtDate = (s) => new Date(s * 1000).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
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
const kindLabel = (e) => (e.kind === "web" ? "HTML" : e.file?.endsWith(".gif") ? "GIF" : e.kind);

const ICON = {
  computer: '<svg viewBox="0 0 16 16"><rect x="2" y="3" width="12" height="8" rx="1.2"/><path d="M6 14h4M8 11v3"/></svg>',
  cloud: '<svg viewBox="0 0 16 16"><path d="M4.5 12.5h7a3 3 0 0 0 .4-5.97A4 4 0 0 0 4.2 7.6 2.5 2.5 0 0 0 4.5 12.5z"/></svg>',
  plus: '<svg viewBox="0 0 16 16"><path d="M8 3v10M3 8h10"/></svg>',
  folder: '<svg viewBox="0 0 16 16"><path d="M2 4.5A1.5 1.5 0 0 1 3.5 3h2.6l1.4 1.5h5A1.5 1.5 0 0 1 14 6v5.5a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 11.5z"/></svg>',
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
    if (e) e.remote = true;
    else map.set(it.id, { ...it, local: false, remote: true });
  }
  return [...map.values()].sort((a, b) => b.added - a.added || a.name.localeCompare(b.name));
}

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
    return render();
  }
  try {
    S.remote = await invoke("remote_items");
    S.remoteError = null;
  } catch (e) {
    S.remoteError = String(e);
  }
  render();
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
    toast(r.ids.length === 1 ? "Added to your library" : `Added ${r.ids.length} wallpapers`);
  }
  if (r.errors.length) toast(r.errors.join(" · "), true);
}

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
  upload: async (el) => {
    await call("upload", { id: el.dataset.id }, "Uploaded to x1");
    refreshRemote();
  },
  download: async (el) => { await call("download", { id: el.dataset.id }, "Downloaded"); },
  removeLocal: async (el) => {
    const e = entries().find((x) => x.id === el.dataset.id);
    if (!e) return;
    if (!e.remote && !confirm(`"${e.name}" isn't on x1. Remove it from this computer for good?`)) return;
    await call("delete_local", { id: e.id });
    if (!e.remote && S.sel === e.id) S.sel = null;
  },
  removeRemote: async (el) => {
    const e = entries().find((x) => x.id === el.dataset.id);
    if (!e || !confirm(`Delete "${e.name}" from the shared library on x1? Other computers will lose access to it.`)) return;
    await call("delete_remote", { id: e.id }, "Deleted from x1");
    if (!e.local && S.sel === e.id) S.sel = null;
    refreshRemote();
  },
  clearDisplay: (el) => call("clear_wallpaper", { display: el.dataset.display }),
  togglePause: () => call("set_paused", { paused: !S.state.paused }),
  fit: (el) => call("update_settings", { patch: { fit: el.dataset.v } }),
  muted: (el) => call("update_settings", { patch: { muted: el.dataset.v === "1" } }),
  pauseCovered: (el) => call("update_settings", { patch: { pauseCovered: el.dataset.v === "1" } }),
  pauseBattery: (el) => call("update_settings", { patch: { pauseBattery: el.dataset.v === "1" } }),
  autostart: (el) => call("set_autostart", { on: el.dataset.v === "1" }),
  connect: async () => {
    const url = S.serverDraft ?? S.state.config.server;
    S.serverStatus = { ok: true, text: "Checking…" };
    render();
    try {
      const saved = await invoke("test_server", { url });
      S.serverDraft = null;
      S.serverStatus = saved ? { ok: true, text: "Connected" } : { ok: true, text: "Sharing is off" };
      await refreshRemote();
      if (saved && S.remote) S.serverStatus = { ok: true, text: `Connected · ${S.remote.length} in the shared library` };
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

document.addEventListener("input", (ev) => {
  if (ev.target.id === "search") { S.query = ev.target.value; render(); }
  if (ev.target.id === "addr") S.serverDraft = ev.target.value;
  if (ev.target.id === "volume") {
    clearTimeout(S.volTimer);
    const v = Number(ev.target.value) / 100;
    S.volTimer = setTimeout(() => call("update_settings", { patch: { volume: v } }), 120);
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

function renderTitle() {
  const tabs = [["library", "Library"], ["displays", "Displays"], ["settings", "Settings"]];
  morph($("#tabs"), tabs.map(([k, t]) => `<button class="nav-tab ${S.tab === k ? "on" : ""}" data-act="tab" data-tab="${k}">${t}</button>`).join(""));
  const ds = S.state.displays;
  const anyPlaying = ds.some((d) => d.status === "playing");
  const anyPaused = ds.some((d) => d.status === "paused");
  let dot = "", text = "";
  if (S.state.paused) { dot = "paused"; text = "Paused"; }
  else if (anyPlaying) { dot = "playing"; text = anyPaused ? "Partly paused" : "Live"; }
  else if (anyPaused) { dot = "paused"; text = "Paused (covered)"; }
  else if (ds.some((d) => d.status === "image")) { dot = "image"; text = "Still image"; }
  else text = "No wallpaper";
  morph($("#live"), `<span class="dot ${dot}"></span>${text}`);
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
  return `<button class="tile ${S.sel === e.id ? "sel" : ""}" data-act="select" data-id="${e.id}" data-key="t-${e.id}">
    <div class="thumb">
      ${t ? `<img src="${esc(t)}" loading="lazy" draggable="false" onerror="this.remove()">` : ""}
      ${t ? "" : placeholder(e)}
      <span class="badge">${esc(kindLabel(e))}</span>
      ${live.length ? `<span class="livetag"><span class="dot ${live[0].status}"></span>${live.length > 1 ? `${live.length} displays` : esc(live[0].name)}</span>` : ""}
      ${pct !== null ? `<div class="bar" style="width:${pct}%"></div>` : ""}
    </div>
    <div class="t-name">${esc(e.name)}</div>
    <div class="t-meta"><span>${meta}</span>
      <span class="where"><span class="${e.local ? "on" : ""}" title="${e.local ? "On this computer" : "Not on this computer"}">${ICON.computer}</span>${S.state.config.server ? `<span class="${e.remote ? "on" : ""}" title="${e.remote ? "In the shared library on x1" : "Not on x1 yet"}">${ICON.cloud}</span>` : ""}</span>
    </div>
  </button>`;
}

function detailHtml(e) {
  if (!e) {
    return `<div class="nodetail">Pick a wallpaper to see it here.<br>Drop files anywhere in this window to add them.</div>`;
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
  const where = e.local && e.remote ? "This computer and x1" : e.local ? "This computer only" : "x1 only";
  const pct = tx && tx.total ? Math.round((100 * tx.done) / tx.total) : 0;

  return `<div data-key="d-${e.id}">
    <div class="preview">${preview}</div>
    <input class="name-in" data-id="${e.id}" data-orig="${esc(e.name)}" value="${esc(e.name)}" spellcheck="false" title="Rename">
    <dl class="facts">
      <dt>Type</dt><dd>${esc(kindLabel(e) === "HTML" ? "HTML page" : kindLabel(e) === "GIF" ? "Animated GIF" : e.kind === "video" ? "Video" : "Image")}</dd>
      ${e.width ? `<dt>Size</dt><dd>${e.width}×${e.height}</dd>` : ""}
      <dt>File</dt><dd>${fmtSize(e.size)}</dd>
      <dt>Added</dt><dd>${fmtDate(e.added)}</dd>
      <dt>Stored</dt><dd>${where}</dd>
      ${live.length ? `<dt>Showing</dt><dd>${live.map((d) => esc(d.name)).join(", ")}</dd>` : ""}
    </dl>

    <div class="section">
      <span class="label">Wallpaper</span>
      <div class="stack">
        <button class="act primary" data-act="setAll" data-id="${e.id}" ${busy ? "disabled" : ""}><span>${displays.length > 1 ? "Set on all displays" : "Set as wallpaper"}</span></button>
        ${displays.length > 1 ? `<div class="row">${displays.map((d) => `<button class="act" data-act="setOn" data-id="${e.id}" data-display="${esc(d.key)}" ${busy ? "disabled" : ""}>Only ${esc(d.name)}</button>`).join("")}</div>` : ""}
        ${!e.local ? `<div class="hint">It downloads to this computer first, then plays from disk.</div>` : ""}
      </div>
    </div>

    ${server ? `<div class="section">
      <span class="label">Shared library</span>
      <div class="stack">
        ${busy ? `<div class="progress"><div style="width:${pct}%"></div></div><div class="hint">${tx?.dir === "up" ? "Uploading" : "Downloading"}… ${pct}%</div>` : ""}
        ${!busy && e.local && !e.remote ? `<button class="act" data-act="upload" data-id="${e.id}">${ICON.cloud} Upload to x1</button>` : ""}
        ${!busy && !e.local && e.remote ? `<button class="act" data-act="download" data-id="${e.id}">${ICON.computer} Download to this computer</button>` : ""}
        ${!busy && e.local && e.remote ? `<div class="hint">Synced with x1.</div>` : ""}
      </div>
    </div>` : ""}

    <div class="section">
      <span class="label">Remove</span>
      <div class="stack">
        ${e.local ? `<button class="act danger" data-act="removeLocal" data-id="${e.id}" ${busy ? "disabled" : ""}>Remove from this computer</button>` : ""}
        ${e.remote ? `<button class="act danger" data-act="removeRemote" data-id="${e.id}" ${busy ? "disabled" : ""}>Delete from x1</button>` : ""}
      </div>
    </div>
  </div>`;
}

function renderLibrary() {
  const all = entries();
  const q = S.query.trim().toLowerCase();
  const counts = { all: all.length, local: all.filter((e) => e.local).length, remote: all.filter((e) => e.remote).length };
  const shown = all.filter((e) => (S.filter === "all" || (S.filter === "local" ? e.local : e.remote)) && (!q || e.name.toLowerCase().includes(q)));
  const sel = all.find((e) => e.id === S.sel) ?? null;
  const server = !!S.state.config.server;
  const filters = [["all", "All"], ["local", "This computer"], ...(server ? [["remote", "On x1"]] : [])];

  let body;
  if (!all.length) {
    body = `<div class="empty"><h2>Your library is empty</h2>
      Drop videos (MP4, WebM, MOV), images, GIFs or HTML wallpapers anywhere in this window.
      ${server ? "" : `<br>To share a library between your computers, add x1 in Settings.`}
      <div class="acts"><button class="act primary" data-act="pick" data-folder="0">${ICON.plus}<span>Add files</span></button>
      <button class="act" data-act="pick" data-folder="1">${ICON.folder} Add an HTML folder</button></div></div>`;
  } else if (!shown.length) {
    body = `<div class="empty">Nothing matches.</div>`;
  } else {
    body = `<div class="grid">${shown.map(tileHtml).join("")}</div>`;
  }

  return `<div class="page" data-key="p-library">
    <div class="lib-main">
      <div class="toolbar">
        <div class="filters">${filters.map(([k, t]) => `<button class="filter ${S.filter === k ? "on" : ""}" data-act="filter" data-f="${k}">${t}<span class="n">${counts[k]}</span></button>`).join("")}</div>
        <input id="search" class="search" placeholder="Search" value="${esc(S.query)}" spellcheck="false">
        <span class="spacer"></span>
        ${S.remoteError ? `<span class="err" title="${esc(S.remoteError)}">x1 offline</span>` : ""}
        <button class="act" data-act="pick" data-folder="0">${ICON.plus} Add files</button>
        <button class="act" data-act="pick" data-folder="1">${ICON.folder} Add HTML folder</button>
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
      return `<div class="screen ${d.status === "playing" ? "live" : ""}" style="left:${Math.round((d.x - minX) * scale) + 2}px;top:${Math.round((d.y - minY) * scale) + 2}px;width:${Math.round(d.width * scale) - 4}px;height:${Math.round(d.height * scale) - 4}px;${t ? `background-image:url('${t}')` : ""}"><span class="cap">${esc(d.name)}${d.primary ? " · main" : ""}</span></div>`;
    }).join("")}</div>`;
  }
  const status = { playing: "Playing", paused: "Paused", image: "Still image (set as the system wallpaper)", idle: "Nothing set" };
  const rows = ds.map((d) => {
    const e = d.item && byId.get(d.item);
    return `<div class="drow">
      <div><div class="dname">${esc(d.name)}</div><div class="sub">${d.width}×${d.height}${d.scale !== 1 ? ` · ${Math.round(d.scale * 100)}%` : ""}${d.primary ? " · main display" : ""}</div></div>
      <div class="now"><span class="dot ${d.status}"></span><span>${e ? esc(e.name) + " · " : ""}${status[d.status]}</span></div>
      <div>${d.item ? `<button class="act" data-act="clearDisplay" data-display="${esc(d.key)}">Clear</button>` : ""}</div>
    </div>`;
  }).join("");
  return `<div class="page" data-key="p-displays"><div class="scroll"><div class="narrow">
    <span class="label">Displays</span>
    ${map}
    ${rows || `<div class="muted">No displays found.</div>`}
    <p class="hint">Choose wallpapers in the Library. Still images are handed to ${S.state.platform === "macos" ? "macOS" : "Windows"} as the normal wallpaper, so they cost nothing to show. Videos and HTML play behind your desktop icons and pause when they're covered.</p>
  </div></div></div>`;
}

function seg(act, cur, opts) {
  return `<div class="seg">${opts.map(([v, t]) => `<button class="${String(cur) === v ? "on" : ""}" data-act="${act}" data-v="${v}">${t}</button>`).join("")}</div>`;
}

function renderSettings() {
  const c = S.state.config;
  const draft = S.serverDraft ?? c.server;
  const st = S.serverStatus ?? (c.server ? (S.remoteError ? { ok: false, text: S.remoteError } : S.remote ? { ok: true, text: `Connected · ${S.remote.length} in the shared library` } : null) : null);
  return `<div class="page" data-key="p-settings"><div class="scroll"><div class="narrow">
    <div class="set-sec">
      <span class="label">Shared library</span>
      <div class="set-row">
        <input id="addr" class="addr mono" placeholder="https://x1.your-tailnet.ts.net:8448" value="${esc(draft)}" spellcheck="false">
        <button class="act primary" data-act="connect"><span>${c.server && draft === c.server ? "Check" : "Connect"}</span></button>
        ${c.server ? `<button class="act" data-act="disconnect">Turn off</button>` : ""}
      </div>
      <p class="hint">${st ? `<span class="${st.ok ? "ok" : "err"}">${esc(st.text)}</span><br>` : ""}The Backdrop server on x1. Open the same address in a browser to see the library and upload from any device.</p>
    </div>

    <div class="set-sec">
      <span class="label">Playback</span>
      <div class="set-row"><div class="what">Fit<div class="hint">How wallpapers that don't match the screen's shape are scaled.</div></div>
        ${seg("fit", c.fit, [["cover", "Fill"], ["contain", "Fit"], ["stretch", "Stretch"]])}</div>
      <div class="set-row"><div class="what">Sound<div class="hint">Videos and HTML wallpapers with audio.</div></div>
        ${c.muted ? "" : `<input id="volume" type="range" min="0" max="100" value="${Math.round(c.volume * 100)}">`}
        ${seg("muted", c.muted ? "1" : "0", [["1", "Muted"], ["0", "On"]])}</div>
    </div>

    <div class="set-sec">
      <span class="label">Saving power</span>
      <div class="set-row"><div class="what">Pause when covered<div class="hint">Stops a wallpaper while a maximized or fullscreen app hides it.</div></div>
        ${seg("pauseCovered", c.pauseCovered ? "1" : "0", [["0", "Off"], ["1", "On"]])}</div>
      <div class="set-row"><div class="what">Pause on battery</div>
        ${seg("pauseBattery", c.pauseBattery ? "1" : "0", [["0", "Off"], ["1", "On"]])}</div>
    </div>

    <div class="set-sec">
      <span class="label">App</span>
      <div class="set-row"><div class="what">Start at login<div class="hint">Starts in the ${S.state.platform === "macos" ? "menu bar" : "tray"} without opening this window.</div></div>
        ${seg("autostart", S.state.autostart ? "1" : "0", [["0", "Off"], ["1", "On"]])}</div>
      <div class="set-row"><div class="what">Library folder<div class="hint mono">${esc(S.state.libraryDir)}</div></div>
        <button class="act" data-act="openDir">Open</button></div>
      <p class="hint">Backdrop ${esc(S.state.version)}. Closing this window keeps wallpapers running; quit from the ${S.state.platform === "macos" ? "menu bar" : "tray"} icon.</p>
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

listen("state", (e) => {
  const hadServer = S.state?.config.server;
  S.state = e.payload;
  if (S.state.config.server !== hadServer) refreshRemote();
  queueThumbs();
  render();
});

listen("transfer", (e) => {
  const t = e.payload;
  S.tx[t.id] = t;
  if (t.state === "error") toast(t.error || "Transfer failed", true);
  if (t.state !== "active") setTimeout(() => { if (S.tx[t.id] === t) { delete S.tx[t.id]; render(); } }, 400);
  render();
});

listen("tauri://drag-enter", () => $("#drop").classList.add("on"));
listen("tauri://drag-leave", () => $("#drop").classList.remove("on"));
listen("tauri://drag-drop", async (e) => {
  $("#drop").classList.remove("on");
  const paths = e.payload?.paths ?? [];
  if (!paths.length) return;
  toast(paths.length === 1 ? "Adding…" : `Adding ${paths.length} items…`);
  importResult(await call("import_paths", { paths }));
});

window.addEventListener("focus", () => { if (S.state?.config.server) refreshRemote(); });
setInterval(() => { if (S.state?.config.server && document.visibilityState === "visible") refreshRemote(); }, 60000);

(async () => {
  S.state = await invoke("get_state");
  document.body.classList.add("os-" + S.state.platform);
  render();
  queueThumbs();
  refreshRemote();
})();
