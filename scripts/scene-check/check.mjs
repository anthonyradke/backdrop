// Checks the scene renderer against real wallpapers in a real browser engine. Nothing here ships and
// no wallpaper is kept in the repo: public repositories are cloned into a scratch folder.
//
//   node scripts/scene-check/check.mjs [--out dir] [--angle swiftshader|d3d11] [--channel msedge] [--only name]
//
// Writes report.json and a JPEG of each scene to --out, and exits non-zero if anything failed.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i < 0 ? fallback : process.argv[i + 1];
};
const here = path.dirname(fileURLToPath(import.meta.url));
const ui = path.resolve(here, "../../app/ui");
const out = path.resolve(arg("out", path.join(os.tmpdir(), "scene-check")));
const work = path.resolve(arg("work", path.join(os.tmpdir(), "scene-check-work")));
const only = arg("only", null);
const angle = arg("angle", "swiftshader");
const channel = arg("channel", null);
const executablePath = arg("browser", null);
const require = createRequire(path.resolve(arg("modules", here), "x.js"));
const { chromium } = require("playwright-core");

// Stock assets, and scenes as `name: [repo, folder inside it]`.
const STOCK = ["laobamac/MirageWallpaper", "assets"];
const SCENES = {
  ultrakill: ["SuppliedOrange/cyber-ultrakill-v2", "cyber_ultrakill_v2"],
  ultraglow: ["SuppliedOrange/cyber-ultrakill-v2", "cyber_ultrakill_v2_minimal_glow"],
  kobeni: ["Iemontine/Kobeni-Wallpaper", ""],
  lonelycat: ["dearxiwei/dearxiwei.github.io", "repkg/3299228616"],
  arona: ["vanh1910/Arona", "scene"],
};

function clone(repo) {
  const dir = path.join(work, repo.replace("/", "_"));
  if (!fs.existsSync(dir)) execFileSync("git", ["clone", "-q", "--depth", "1", `https://github.com/${repo}`, dir], { stdio: "inherit", env: { ...process.env, GIT_LFS_SKIP_SMUDGE: "1" } });
  return dir;
}

function unpack(pkg, dest) {
  const b = fs.readFileSync(pkg);
  let o = 0;
  const str = () => { const n = b.readUInt32LE(o); o += 4; const s = b.toString("utf8", o, o + n); o += n; return s; };
  str();
  const count = b.readUInt32LE(o); o += 4;
  const files = [];
  for (let i = 0; i < count; i++) { const name = str(); files.push([name, b.readUInt32LE(o), b.readUInt32LE(o + 4)]); o += 8; }
  for (const [name, offset, len] of files) {
    const to = path.join(dest, name);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.writeFileSync(to, b.subarray(o + offset, o + offset + len));
  }
}

fs.mkdirSync(out, { recursive: true });
fs.mkdirSync(work, { recursive: true });
const stock = path.join(clone(STOCK[0]), STOCK[1]);
const scenes = {};
for (const [name, [repo, sub]] of Object.entries(SCENES)) {
  if (only && only !== name) continue;
  const src = path.join(clone(repo), sub), dest = path.join(work, "scenes", name);
  if (!fs.existsSync(dest)) {
    fs.cpSync(src, dest, { recursive: true, filter: (f) => !f.endsWith(".pkg") && !f.includes(`${path.sep}.git`) });
    if (fs.existsSync(path.join(src, "scene.pkg"))) unpack(path.join(src, "scene.pkg"), dest);
  }
  scenes[name] = dest;
}

const TYPES = { ".html": "text/html", ".js": "text/javascript", ".json": "application/json" };
const server = http.createServer((q, r) => {
  const u = decodeURIComponent(q.url.split("?")[0]);
  let f = null;
  if (u === "/") { r.setHeader("Content-Type", "text/html"); return r.end(PAGE); }
  if (u.startsWith("/ui/")) f = path.join(ui, u.slice(4));
  else if (u.startsWith("/assets/")) f = path.join(stock, u.slice(8));
  else if (u.startsWith("/scene/")) f = path.join(work, "scenes", u.slice(7));
  if (!f || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { r.statusCode = 404; return r.end(); }
  r.setHeader("Content-Type", TYPES[path.extname(f)] || "application/octet-stream");
  fs.createReadStream(f).pipe(r);
});
const PAGE = `<!doctype html><body style="margin:0"><canvas id=c></canvas>${["tex", "shader", "scene", "text", "particles", "puppet", "script"].map((s) => `<script src=/ui/scene/${s}.js></script>`).join("")}`;
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;

const shaders = [];
for (const e of fs.readdirSync(path.join(stock, "effects"))) {
  for (const sub of ["shaders", "shaders/effects"]) {
    const d = path.join(stock, "effects", e, sub);
    if (!fs.existsSync(d)) continue;
    for (const f of fs.readdirSync(d)) if (f.endsWith(".frag")) shaders.push([(sub === "shaders" ? "" : "effects/") + f.slice(0, -5), `/assets/effects/${e}/`]);
  }
}
for (const f of ["genericimage2", "genericimage3", "genericimage4", "genericparticle", "composelayer", "flat"]) shaders.push([f, null]);

const browser = await chromium.launch({
  channel: channel || undefined, executablePath: executablePath || undefined, headless: true,
  args: [`--use-angle=${angle}`, "--use-gl=angle", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist", "--autoplay-policy=no-user-gesture-required"],
});
const report = { angle, scenes: {}, variants: null };

const page = await browser.newPage();
page.on("pageerror", (e) => console.log("pageerror", e.message));
await page.goto(base);
report.gpu = await page.evaluate(() => {
  const gl = document.createElement("canvas").getContext("webgl2");
  if (!gl) return { webgl2: false };
  const info = gl.getExtension("WEBGL_debug_renderer_info");
  return { webgl2: true, renderer: info && gl.getParameter(info.UNMASKED_RENDERER_WEBGL), s3tc: !!gl.getExtension("WEBGL_compressed_texture_s3tc"), bptc: !!gl.getExtension("EXT_texture_compression_bptc"), floatFbo: !!gl.getExtension("EXT_color_buffer_float"), vertexUniforms: gl.getParameter(gl.MAX_VERTEX_UNIFORM_VECTORS) };
});
console.log(report.gpu);
report.variants = await page.evaluate(async (list) => {
  const gl = document.createElement("canvas").getContext("webgl2");
  let ok = 0, slowest = 0, total = 0;
  const errors = {};
  for (const [name, root] of list) {
    const a = { async text(p) { for (const r of [root, "/assets/"].filter(Boolean)) { const x = await fetch(r + p); if (x.ok) return x.text(); } return null; } };
    let src;
    try { src = await WE.loadShaderSourceFresh(a, name); } catch (e) { errors[name] = e.message; continue; }
    const base = WE.resolveCombos(src.meta, {}, null), variants = [{}];
    for (const k of Object.keys(base)) variants.push({ [k]: base[k] ? 0 : 1 });
    for (const u of Object.values(src.meta.uniforms)) if (u.meta.combo) variants.push({ [u.meta.combo]: 1 });
    if (/BLENDMODE/.test(src.vert + src.frag)) for (const m of [1, 7, 24, 30, 31]) variants.push({ BLENDMODE: m });
    for (const v of variants) {
      const t = performance.now();
      try { const p = WE.buildProgram(gl, src, { ...base, ...v }); gl.deleteProgram(p.prog); ok++; } catch (e) { errors[`${name} ${JSON.stringify(v)}`] = String(e.message).slice(0, 300); }
      const ms = performance.now() - t;
      total += ms; slowest = Math.max(slowest, ms);
    }
  }
  return { ok, failed: Object.keys(errors).length, errors, totalMs: Math.round(total), slowestMs: Math.round(slowest) };
}, shaders);
console.log(`shader variants: ${report.variants.ok} ok, ${report.variants.failed} failed, slowest ${report.variants.slowestMs} ms`);
await page.close();

let failed = report.variants.failed;
for (const name of Object.keys(scenes)) {
  const p = await browser.newPage();
  const errors = [];
  p.on("pageerror", (e) => errors.push(e.message));
  await p.goto(base);
  try {
    const r = await p.evaluate(async (name) => {
      const s = new WE.Scene(document.getElementById("c"), { base: `/scene/${name}/`, stock: "/assets/", keepBuffer: true, screen: [1920, 1080] });
      const t0 = performance.now();
      await s.load();
      const load = Math.round(performance.now() - t0);
      s.setSpectrum(Array.from({ length: 128 }, (_, i) => 0.2 + 0.7 * Math.abs(Math.sin(i * 0.35))));
      s.setPointer(0.4, 0.45);
      const times = [];
      for (let i = 1; i <= 6; i++) {
        const a = performance.now();
        s.renderAt(i * 0.25);
        s.gl.finish();
        s.gl.readPixels(0, 0, 1, 1, s.gl.RGBA, s.gl.UNSIGNED_BYTE, new Uint8Array(4));
        times.push(Math.round(performance.now() - a));
        await new Promise((d) => setTimeout(d, 40));
      }
      // HDR scenes draw to a float framebuffer, which reads differently.
      const gl = s.gl, b = s.hdr ? new Float32Array(s.fbWidth * s.fbHeight * 4) : new Uint8Array(s.fbWidth * s.fbHeight * 4);
      gl.bindFramebuffer(gl.FRAMEBUFFER, s.sceneTarget.fb);
      gl.readPixels(0, 0, s.fbWidth, s.fbHeight, gl.RGBA, s.hdr ? gl.FLOAT : gl.UNSIGNED_BYTE, b);
      const floor = s.hdr ? 0.1 : 24;
      let lit = 0;
      for (let i = 0; i < b.length; i += 4 * 97) if (b[i] + b[i + 1] + b[i + 2] > floor) lit++;
      s.renderAt(2);
      return { size: [s.width, s.height], layers: s.layers.length, loadMs: load, frameMs: times, warnings: s.warnings, glError: s.gl.getError(), lit: lit / (b.length / (4 * 97)), jpeg: s.canvas.toDataURL("image/jpeg", 0.85) };
    }, name);
    fs.writeFileSync(path.join(out, `${name}.jpg`), Buffer.from(r.jpeg.split(",")[1], "base64"));
    delete r.jpeg;
    report.scenes[name] = { ...r, errors };
    if (r.warnings.length || r.glError || errors.length || r.lit < 0.02) failed++;
    console.log(`${name}: ${r.size.join("x")} load ${r.loadMs} ms, frames ${r.frameMs.join(" ")} ms, ${r.warnings.length} warnings, gl ${r.glError}, lit ${r.lit.toFixed(2)}`);
    for (const w of r.warnings.slice(0, 12)) console.log(`  ${w.slice(0, 300)}`);
  } catch (e) {
    failed++;
    report.scenes[name] = { failed: e.message.slice(0, 500), errors };
    console.log(`${name}: FAILED ${e.message.slice(0, 300)}`);
  }
  await p.close();
}
fs.writeFileSync(path.join(out, "report.json"), JSON.stringify(report, null, 1));
await browser.close();
server.close();
console.log(failed ? `${failed} problems` : "all good");
process.exit(failed ? 1 : 0);
