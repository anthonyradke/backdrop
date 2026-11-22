"use strict";
// Loads whole (tiny) scenes through WE.Scene.load() against a stand-in WebGL2, so a mistake anywhere
// in the load path fails here rather than on every scene wallpaper. Drawing isn't checked.
const test = require("node:test");
const assert = require("node:assert");
const { load, SCENE } = require("./load.js");

// Enough WebGL2 for load(): constants are distinct numbers, shaders compile unless their source
// says BROKEN, and a program reports the uniforms its shaders declare.
function fakeGl() {
  const consts = new Map();
  const fns = {
    createShader: () => ({ src: "" }),
    shaderSource: (s, src) => { s.src = src; },
    getShaderParameter: (s) => !s.src.includes("BROKEN"),
    getShaderInfoLog: () => "ERROR: 0:1: broken on purpose",
    createProgram: () => ({ uniforms: [] }),
    attachShader: (p, s) => { for (const m of s.src.matchAll(/\buniform\s+\w+\s+(\w+)/g)) p.uniforms.push(m[1]); },
    getProgramParameter: (p, k) => (k === gl.ACTIVE_UNIFORMS ? p.uniforms.length : k === gl.ACTIVE_ATTRIBUTES ? 0 : true),
    getActiveUniform: (p, i) => ({ name: p.uniforms[i], size: 1, type: 0 }),
    getUniformLocation: () => ({}),
    getExtension: () => ({}),
    getParameter: () => 4096,
    checkFramebufferStatus: () => gl.FRAMEBUFFER_COMPLETE,
  };
  const gl = new Proxy(fns, {
    get(t, k) {
      if (k in t) return t[k];
      if (typeof k === "string" && /^[A-Z][A-Z0-9_]*$/.test(k)) {
        if (!consts.has(k)) consts.set(k, 0x1000 + consts.size);
        return consts.get(k);
      }
      return () => ({});
    },
  });
  return gl;
}

const VERT = "attribute vec3 a_Position;\nuniform mat4 g_ModelViewProjectionMatrix;\nvoid main() { gl_Position = mul(vec4(a_Position, 1.0), g_ModelViewProjectionMatrix); }\n";
const frag = (body) => `${body}\nvoid main() { gl_FragColor = vec4(1.0, 1.0, 1.0, 1.0); }\n`;

// A scene with one flat layer per shader name. `shaders` maps a name to its fragment source.
function files(shaders) {
  const names = Object.keys(shaders);
  const f = {
    "project.json": { file: "scene.json", type: "scene" },
    "scene.json": {
      general: { orthogonalprojection: { width: 64, height: 32 } },
      objects: names.map((n, i) => ({ id: i + 1, name: n, image: `models/${n}.json`, origin: "32 16 0", size: "64 32" })),
    },
  };
  for (const n of names) {
    f[`models/${n}.json`] = { material: `materials/${n}.json` };
    f[`materials/${n}.json`] = { passes: [{ shader: n }] };
    f[`shaders/${n}.vert`] = VERT;
    f[`shaders/${n}.frag`] = shaders[n];
  }
  return f;
}

async function loadScene(shaders) {
  const f = files(shaders);
  const fetch = async (url) => {
    const path = decodeURIComponent(url.replace(/^scene:\/\//, ""));
    if (!(path in f)) return { ok: false };
    const body = typeof f[path] === "string" ? f[path] : JSON.stringify(f[path]);
    const bytes = new TextEncoder().encode(body);
    return { ok: true, arrayBuffer: async () => bytes.buffer };
  };
  const gl = fakeGl();
  const canvas = { getContext: () => gl, addEventListener() {}, width: 0, height: 0 };
  const { WE } = load(SCENE, { fetch });
  const warnings = [];
  const scene = new WE.Scene(canvas, { base: "scene://", log: (m) => warnings.push(m), screen: [64, 32] });
  await scene.load();
  return { scene, warnings };
}

test("a scene with a shader pass loads", async () => {
  const { scene, warnings } = await loadScene({ plain: frag("") });
  assert.deepStrictEqual(warnings, []);
  assert.strictEqual(scene.width, 64);
  assert.strictEqual(scene.height, 32);
  assert.ok(scene.layers.some((l) => l.base));
  assert.strictEqual(scene.wantsAudio, false);
});

test("a shader that reads the audio spectrum asks for audio", async () => {
  const { scene } = await loadScene({ bars: frag("uniform float g_AudioSpectrum16Left[16];") });
  assert.strictEqual(scene.wantsAudio, true);
});

test("a shader that fails to build costs only its own layer", async () => {
  const { scene, warnings } = await loadScene({ broken: frag("BROKEN"), plain: frag("") });
  assert.strictEqual(warnings.length, 1);
  assert.match(warnings[0], /^object "broken":/);
  assert.ok(scene.layers.some((l) => l.base));
  assert.strictEqual(scene.wantsAudio, false);
});
