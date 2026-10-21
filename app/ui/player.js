// One of these runs per display. It shows whatever the engine says (player_init on load, then
// player:update events) and crossfades when the wallpaper changes.
const { invoke, convertFileSrc } = window.__TAURI__.core;
const me = window.__TAURI__.webviewWindow.getCurrentWebviewWindow();

const BASE = convertFileSrc("", "media"); // media://localhost/ (macOS) or http://media.localhost/ (Windows)
const FIT = { cover: "cover", contain: "contain", stretch: "fill" };
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
    let usedFallback = false;
    next.addEventListener("error", () => {
      const why = next.error?.message || next.error?.code;
      if (!usedFallback && p.fallback) {
        // Some WebViews can't stream video from a custom protocol; the loopback server always works.
        usedFallback = true;
        report(`media:// couldn't play ${p.src} (${why}); switching to loopback`);
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
    next.decode().then(reveal, reveal);
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

function show(p) {
  if (!p) return;
  if (!cur || cur.src !== p.src || cur.kind !== p.kind) swap(p);
  cur = p;
  if (el.tagName === "VIDEO" || el.tagName === "IMG") el.style.objectFit = FIT[p.fit] || "cover";
  if (el.tagName === "VIDEO") {
    el.muted = p.muted;
    el.volume = p.volume;
    if (p.paused) el.pause();
    else el.play().catch(() => { el.muted = true; el.play().catch((e) => report(`play() refused: ${e}`)); });
  } else if (el.tagName === "IFRAME") {
    // HTML wallpapers can listen for this to stop their animation loop.
    try { el.contentWindow.postMessage({ backdrop: { paused: p.paused, muted: p.muted, volume: p.volume } }, "*"); } catch {}
  }
}

me.listen("player:update", (e) => show(e.payload));
invoke("player_init").then((p) => { if (!p) report("no wallpaper assigned to this window"); show(p); }, report);
document.addEventListener("contextmenu", (e) => e.preventDefault());
