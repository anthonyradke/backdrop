// Injected at the top of every HTML wallpaper's pages by the loopback server (loopback.rs). The
// player posts { backdrop: {...} } to the page; this turns that into Wallpaper Engine's web API,
// which Workshop pages are written against, and applies Backdrop's mute and pause settings:
//
// - window.wallpaperPropertyListener: applyUserProperties (the wallpaper's own settings, all of them
//   once and then what changes), applyGeneralProperties ({ fps }), setPaused
// - window.wallpaperRegisterAudioListener: 128 levels (64 left, 64 right) about 30 times a second
// - window.wallpaperRegisterMedia*Listener: what the computer is playing
(function () {
  "use strict";
  if (window.__backdrop) return;
  const state = { paused: false, muted: true, volume: 0.5 };
  const media = () => document.querySelectorAll("audio, video");
  const tell = (msg) => { try { window.parent.postMessage({ backdropShim: msg }, "*"); } catch {} };

  // ---------- sound and pausing ----------

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
      call("setPaused", state.paused);
    }
  }

  // ---------- wallpaperPropertyListener ----------

  // The page may set the listener before or after the properties arrive, so they're kept and
  // handed over whenever it's (re)assigned, the way Wallpaper Engine calls it on load.
  let listener = null;
  let props = null;
  const call = (fn, arg) => { try { listener?.[fn]?.(arg); } catch (e) { console.error(e); } };
  Object.defineProperty(window, "wallpaperPropertyListener", {
    configurable: true,
    get: () => listener,
    set: (v) => {
      listener = v;
      if (props) call("applyUserProperties", props);
      call("applyGeneralProperties", { fps: 30 });
      if (state.paused) call("setPaused", true);
    },
  });
  function onProps(next) {
    if (!next || typeof next !== "object") return;
    const changed = {};
    for (const [k, v] of Object.entries(next)) {
      if (!props || JSON.stringify(props[k]) !== JSON.stringify(v)) changed[k] = v;
    }
    props = next;
    if (Object.keys(changed).length) call("applyUserProperties", changed);
  }

  // ---------- audio ----------

  const audioListeners = [];
  window.wallpaperRegisterAudioListener = (cb) => {
    if (typeof cb !== "function") return;
    audioListeners.push(cb);
    tell({ wantsAudio: true });
  };
  function onAudio(levels) {
    if (!Array.isArray(levels) || state.paused) return;
    for (const cb of audioListeners) { try { cb(levels); } catch (e) { console.error(e); } }
  }

  // ---------- media ----------

  const mediaListeners = { properties: [], thumbnail: [], playback: [], status: [], timeline: [] };
  const register = (kind) => (cb) => {
    if (typeof cb !== "function") return;
    mediaListeners[kind].push(cb);
    tell({ wantsMedia: true });
  };
  window.wallpaperRegisterMediaPropertiesListener = register("properties");
  window.wallpaperRegisterMediaThumbnailListener = register("thumbnail");
  window.wallpaperRegisterMediaPlaybackListener = register("playback");
  window.wallpaperRegisterMediaStatusListener = register("status");
  window.wallpaperRegisterMediaTimelineListener = register("timeline");
  const emit = (kind, event) => { for (const cb of mediaListeners[kind]) { try { cb(event); } catch (e) { console.error(e); } } };
  let now = null;
  function onMedia(next) {
    const was = now;
    now = next && typeof next === "object" ? next : null;
    if (!!now !== !!was) emit("status", { enabled: !!now });
    if (!now) { if (was) emit("playback", { state: 0 }); return; }
    if (now.title !== was?.title || now.artist !== was?.artist) {
      emit("properties", { title: now.title, artist: now.artist, albumTitle: now.album, albumArtist: now.artist, subTitle: "", genres: "", contentType: "music" });
    }
    if (now.playing !== was?.playing) emit("playback", { state: now.playing ? 1 : 2 });
    if (now.cover && now.cover !== was?.cover) thumbnail(now.cover);
  }
  function thumbnail(src) {
    const img = new Image();
    img.onload = () => {
      let color = [0, 0, 0];
      try {
        const c = document.createElement("canvas");
        c.width = c.height = 1;
        const g = c.getContext("2d");
        g.drawImage(img, 0, 0, 1, 1);
        color = [...g.getImageData(0, 0, 1, 1).data].slice(0, 3).map((v) => v / 255);
      } catch {}
      const light = color[0] * 0.3 + color[1] * 0.59 + color[2] * 0.11 > 0.5;
      const hex = "#" + color.map((v) => Math.round(v * 255).toString(16).padStart(2, "0")).join("");
      const text = light ? "#000000" : "#ffffff";
      emit("thumbnail", { thumbnail: src, primaryColor: hex, secondaryColor: hex, tertiaryColor: hex, textColor: text, highContrastColor: text });
    };
    img.src = src;
  }

  // ---------- messages ----------

  const handlers = { state: onState, props: onProps, audio: onAudio, media: onMedia };
  window.__backdrop = { state };
  window.addEventListener("message", (e) => {
    if (e.source !== window.parent || !e.data || typeof e.data !== "object" || !e.data.backdrop) return;
    const msg = e.data.backdrop;
    // Without a type it's the state, as Backdrop has always sent it.
    const handler = handlers[msg.type || "state"];
    if (handler) handler(msg.type ? msg.data : msg);
  });
  const ready = () => tell({ ready: true });
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", ready, { once: true });
  else ready();
})();
