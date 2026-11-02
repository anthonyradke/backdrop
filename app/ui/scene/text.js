// Text objects: drawn with the 2D canvas into a texture, then treated as an image layer so effects
// work on them.
"use strict";
var WE = window.WE || (window.WE = {});

const SYSTEM_FONTS = { systemfont_arial: "Arial, sans-serif", systemfont_consolas: "Consolas, monospace", systemfont_timesnewroman: "'Times New Roman', serif", systemfont_verdana: "Verdana, sans-serif", systemfont_segoeui: "'Segoe UI', sans-serif", systemfont_impact: "Impact, sans-serif", systemfont_couriernew: "'Courier New', monospace", systemfont_comicsansms: "'Comic Sans MS', cursive" };
let fontCount = 0;

WE.TextLayer = class extends WE.ImageLayerBase {
  async material() {
    return { passes: [{ shader: "genericimage2", blending: "translucent", textures: [] }] };
  }
  async baseTexture() {
    const s = this.scene, d = this.data;
    this.textValue = [String(s.value(d.text) ?? "")];
    if (d.text && typeof d.text === "object") s.drive(this, "text", d.text, this.textValue);
    this.pointsize = s.prop(this, "pointsize", d.pointsize, [32]);
    this.padding = +(s.value(d.padding) ?? 0);
    this.canvas2d = document.createElement("canvas");
    this.ctx = this.canvas2d.getContext("2d", { willReadFrequently: false });
    this.family = await this.font(s.value(d.font) || "systemfont_arial");
    const gl = s.gl;
    this.tex = { tex: gl.createTexture(), width: 1, height: 1, texWidth: 1, texHeight: 1, format: 0, flags: 0 };
    this.size = WE.parseVec(s.value(d.size) ?? [0, 0]);
    this.paint();
    return this.tex;
  }
  async font(name) {
    if (SYSTEM_FONTS[name]) return SYSTEM_FONTS[name];
    if (/^systemfont_/.test(name)) return name.slice(11);
    const bytes = await this.scene.assets.find(name);
    if (!bytes) return "sans-serif";
    try {
      const family = `wefont${++fontCount}`;
      const face = new FontFace(family, bytes);
      await face.load();
      document.fonts.add(face);
      return `'${family}'`;
    } catch { return "sans-serif"; }
  }
  // Wraps to the box, keeping to the row limit when there is one.
  lines(text, width) {
    const d = this.data, ctx = this.ctx, out = [];
    const limitW = this.scene.value(d.limitwidth) ? +(this.scene.value(d.maxwidth) || 0) : 0;
    const max = limitW || width;
    for (const para of text.split("\n")) {
      if (!max || ctx.measureText(para).width <= max) { out.push(para); continue; }
      let line = "";
      for (const word of para.split(/(\s+)/)) {
        if (line && ctx.measureText(line + word).width > max) { out.push(line.trimEnd()); line = word.trimStart(); } else line += word;
      }
      if (line) out.push(line);
    }
    if (this.scene.value(d.limitrows)) out.length = Math.min(out.length, Math.max(1, +(this.scene.value(d.maxrows) || 1)));
    return out;
  }
  paint() {
    const s = this.scene, d = this.data, ctx = this.ctx, c = this.canvas2d, gl = s.gl;
    const text = String(this.textValue[0] ?? "");
    const px = this.pointsize[0];
    const key = `${text}|${px}`;
    if (key === this.painted) return;
    this.painted = key;
    const font = `${px * 1.3333}px ${this.family}`;
    ctx.font = font;
    const pad = this.padding;
    let [bw, bh] = this.size;
    const lines = this.lines(text, bw ? Math.max(0, bw - pad * 2) : 0);
    const lh = px * 1.3333 * 1.25;
    if (!bw) bw = Math.ceil(Math.max(1, ...lines.map((l) => ctx.measureText(l).width))) + pad * 2 + 2;
    if (!bh) bh = Math.ceil(lines.length * lh) + pad * 2 + 2;
    if (c.width !== bw || c.height !== bh) { c.width = bw; c.height = bh; }
    ctx.clearRect(0, 0, bw, bh);
    if (s.value(d.opaquebackground)) {
      const b = WE.parseVec(s.value(d.backgroundcolor) ?? "0 0 0"), k = 255 * +(s.value(d.backgroundbrightness) ?? 1);
      ctx.fillStyle = `rgb(${b[0] * k},${b[1] * k},${b[2] * k})`;
      ctx.fillRect(0, 0, bw, bh);
    }
    ctx.font = font;
    ctx.fillStyle = "#fff";
    ctx.textBaseline = "top";
    const ha = s.value(d.horizontalalign) || "center", va = s.value(d.verticalalign) || "center";
    ctx.textAlign = ha;
    const x = ha === "left" ? pad : ha === "right" ? bw - pad : bw / 2;
    const block = lines.length * lh;
    let y = va === "top" ? pad : va === "bottom" ? bh - pad - block : (bh - block) / 2;
    for (const l of lines) { ctx.fillText(l, x, y + (lh - px * 1.3333) / 2); y += lh; }
    gl.bindTexture(gl.TEXTURE_2D, this.tex.tex);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, c);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    this.tex.width = this.tex.texWidth = bw;
    this.tex.height = this.tex.texHeight = bh;
    if (this.w && (bw !== this.w || bh !== this.h)) this.resize(bw, bh);
  }
  beforeRender() { this.paint(); }
};

// Sound objects play their files through <audio>; the wallpaper's mute and volume settings apply.
WE.SoundLayer = class extends WE.LayerBase {
  async init() {
    const s = this.scene, d = this.data;
    this.files = Array.isArray(d.sound) ? d.sound : [d.sound];
    this.volume = +(s.value(d.volume) ?? 1);
    this.loop = (d.playbackmode ?? "loop") === "loop";
    this.random = d.playbackmode === "random";
    this.silent = !!s.value(d.startsilent) || !s.value(d.visible ?? true);
    this.audio = new Audio();
    this.blobs = [];
    this.at = 0;
    this.master = 0;
    this.audio.loop = this.loop && this.files.length === 1;
    this.audio.addEventListener("ended", () => this.next());
    s.sounds.push(this);
    if (!this.silent) await this.load(this.files[0]);
  }
  async load(file) {
    const bytes = await this.scene.assets.find(file);
    if (!bytes) return;
    URL.revokeObjectURL(this.audio.src);
    this.audio.src = URL.createObjectURL(new Blob([bytes]));
    this.apply();
  }
  next() {
    this.at = (this.at + 1) % this.files.length;
    if (this.loop || this.random) this.load(this.files[this.random ? Math.floor(Math.random() * this.files.length) : this.at]);
  }
  apply() {
    this.audio.volume = Math.min(1, this.volume * this.master);
    if (this.master > 0 && !this.pausedNow && this.audio.src) this.audio.play().catch(() => {});
    else this.audio.pause();
  }
  setPaused(p) { this.pausedNow = p; this.apply(); }
  setMaster(v) { this.master = v; this.apply(); }
  stop() { this.audio.pause(); URL.revokeObjectURL(this.audio.src); this.audio.removeAttribute("src"); }
};
