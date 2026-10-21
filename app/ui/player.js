// One of these runs per display. It shows whatever the engine says (player_init on load, then
// player:update events) and crossfades when the wallpaper changes.
const { invoke, convertFileSrc } = window.__TAURI__.core;
const me = window.__TAURI__.webviewWindow.getCurrentWebviewWindow();

const BASE = convertFileSrc("", "media"); // http://media.localhost/ on Windows
const FIT = { cover: "cover", contain: "contain", stretch: "fill", center: "none" };
let cur = null;
const report = (msg) => invoke("player_log", { msg: String(msg) }).catch(() => {});
window.addEventListener("error", (e) => report(`script error: ${e.message}`));
window.addEventListener("unhandledrejection", (e) => report(`unhandled: ${e.reason}`));
let el = null;

function url(src, base = BASE) {
  return base + src.split("/").map(encodeURIComponent).join("/");
}

function swap(p) {
  const old = el;
  let next;
  if (p.kind === "video") {
    next = document.createElement("video");
    next.loop = true;
    next.muted = true;
    next.playsInline = true;
    next.preload = "auto";
    next.disablePictureInPicture = true;
    next.addEventListener("loadeddata", reveal, { once: true });
    next.addEventListener("loadedmetadata", () => { if (cur && el === next) applyFit(cur); });
    let usedFallback = false;
    next.addEventListener("error", () => {
      const why = next.error?.message || next.error?.code;
      if (!usedFallback && p.fallback) {
        // Some WebViews can't stream video from a custom protocol; the loopback server always works.
        usedFallback = true;
        report(`media:// couldn't play ${p.src} (${why}); switching to loopback`);
        next.dataset.base = p.fallback;
        next.src = url(p.src, p.fallback);
        if (cur && !cur.paused) next.play().catch(() => {});
        return;
      }
      report(`can't play ${p.src}: ${why}`);
    });
    next.src = url(p.src);
  } else if (p.kind === "web") {
    next = document.createElement("iframe");
    next.setAttribute("allow", "autoplay; fullscreen");
    next.addEventListener("load", () => { reveal(); if (cur) show(cur); }, { once: true });
    next.src = url(p.src);
  } else {
    next = document.createElement("img");
    next.src = url(p.src);
    next.decode().then(() => { if (cur && el === next) applyFit(cur); reveal(); }, reveal);
  }
  next.className = "layer";
  document.body.appendChild(next);
  el = next;

  function reveal() {
    requestAnimationFrame(() => {
      next.classList.add("on");
      if (old) setTimeout(() => dispose(old), 700);
    });
  }
}

function dispose(node) {
  if (node.tagName === "VIDEO") {
    node.pause();
    node.removeAttribute("src");
    node.load(); // releases the decoder
  }
  node.remove();
}

// "Fit height" is Fill for media wider than the screen and Fit for narrower media.
function applyFit(p) {
  if (el.tagName !== "VIDEO" && el.tagName !== "IMG") return;
  let fit = FIT[p.fit] || "cover";
  if (p.fit === "height") {
    const w = el.videoWidth || el.naturalWidth, h = el.videoHeight || el.naturalHeight;
    fit = w && h && w / h < innerWidth / innerHeight ? "contain" : "cover";
  }
  el.style.objectFit = fit;
}

// A full-size frame of the wallpaper becomes the system wallpaper underneath, so the desktop
// matches before the player starts. A separate element does the grab so the visible one is never
// switched to CORS mode.
const captured = new Set();
function capture(p) {
  const id = p.capture;
  if (!id || captured.has(id)) return;
  captured.add(id);
  // Waits a moment so the visible player has settled on media:// or the loopback fallback.
  setTimeout(() => {
    const base = el.dataset.base || BASE;
    grab(url(p.src, base), p.kind)
      .catch((e) => (p.fallback && base !== p.fallback ? grab(url(p.src, p.fallback), p.kind) : Promise.reject(e)))
      .then((data) => invoke("save_frame", { id, data }))
      .catch((e) => report(`no still frame for ${p.src}: ${e}`));
  }, 2500);
}

function grab(src, kind) {
  return new Promise((resolve, reject) => {
    let g;
    const timer = setTimeout(() => { done(); reject("timeout"); }, 20000);
    const done = () => { clearTimeout(timer); if (g?.tagName === "VIDEO") { g.removeAttribute("src"); g.load(); } };
    const draw = (w, h) => {
      // Big enough for a 4K screen, small enough to stay a few MB.
      const k = Math.min(1, 3840 / Math.max(w, h));
      const c = document.createElement("canvas");
      c.width = Math.round(w * k);
      c.height = Math.round(h * k);
      c.getContext("2d").drawImage(g, 0, 0, c.width, c.height);
      done();
      try { resolve(c.toDataURL("image/jpeg", 0.9)); } catch (e) { reject(e); }
    };
    if (kind === "video") {
      g = document.createElement("video");
      g.crossOrigin = "anonymous";
      g.muted = true;
      g.preload = "auto";
      g.onloadedmetadata = () => { g.currentTime = Math.min(1, (g.duration || 2) / 2); };
      g.onseeked = () => draw(g.videoWidth, g.videoHeight);
      g.onerror = () => { done(); reject("can't decode"); };
    } else {
      g = new Image();
      g.crossOrigin = "anonymous";
      g.onload = () => draw(g.naturalWidth, g.naturalHeight);
      g.onerror = () => { done(); reject("can't decode"); };
    }
    g.src = src;
  });
}

function show(p) {
  if (!p) return;
  if (!cur || cur.src !== p.src || cur.kind !== p.kind) swap(p);
  cur = p;
  document.getElementById("shade").className = p.shade || "";
  applyFit(p);
  capture(p);
  if (el.tagName === "VIDEO") {
    el.muted = p.muted;
    el.volume = p.volume;
    el.defaultPlaybackRate = el.playbackRate = p.speed || 1;
    if (p.paused) el.pause();
    else el.play().catch(() => { el.muted = true; el.play().catch((e) => report(`play() refused: ${e}`)); });
  } else if (el.tagName === "IFRAME") {
    // HTML wallpapers can listen for this to stop their animation loop.
    try { el.contentWindow.postMessage({ backdrop: { paused: p.paused, muted: p.muted, volume: p.volume, speed: p.speed } }, "*"); } catch {}
  }
}

me.listen("player:update", (e) => show(e.payload));
invoke("player_init").then((p) => { if (!p) report("no wallpaper assigned to this window"); show(p); }, report);
document.addEventListener("contextmenu", (e) => e.preventDefault());
