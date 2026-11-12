// Injected at the top of every HTML wallpaper's pages by the loopback server (loopback.rs). The
// player posts { backdrop: {...} } to the page; this turns that into what the page can act on.
(function () {
  "use strict";
  if (window.__backdrop) return;
  const state = { paused: false, muted: true, volume: 0.5 };
  const media = () => document.querySelectorAll("audio, video");

  // Sound follows Backdrop's setting whether or not the page listens for it.
  function applySound() {
    for (const m of media()) {
      m.muted = state.muted;
      if (!state.muted) m.volume = state.volume;
    }
  }
  const play = HTMLMediaElement.prototype.play;
  HTMLMediaElement.prototype.play = function () {
    this.muted = state.muted;
    return play.call(this);
  };
  const contexts = new Set();
  const AC = window.AudioContext;
  if (AC) {
    window.AudioContext = function (...args) {
      const ctx = new AC(...args);
      contexts.add(ctx);
      if (state.muted || state.paused) ctx.suspend().catch(() => {});
      return ctx;
    };
    window.AudioContext.prototype = AC.prototype;
  }

  function onState(s) {
    const was = { ...state };
    Object.assign(state, s);
    applySound();
    for (const ctx of contexts) {
      if (state.muted || state.paused) ctx.suspend().catch(() => {});
      else ctx.resume().catch(() => {});
    }
    if (state.paused !== was.paused) {
      for (const m of media()) {
        if (state.paused) {
          if (!m.paused) { m.dataset.backdropPaused = "1"; m.pause(); }
        } else if (m.dataset.backdropPaused) {
          delete m.dataset.backdropPaused;
          m.play().catch(() => {});
        }
      }
    }
  }

  window.__backdrop = { state, handlers: { state: onState } };
  window.addEventListener("message", (e) => {
    if (e.source !== window.parent || !e.data || typeof e.data !== "object" || !e.data.backdrop) return;
    const msg = e.data.backdrop;
    const handler = window.__backdrop.handlers[msg.type || "state"];
    if (handler) handler(msg.type ? msg.data : msg);
  });
  const ready = () => window.parent.postMessage({ backdropShim: { ready: true } }, "*");
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", ready, { once: true });
  else ready();
})();
