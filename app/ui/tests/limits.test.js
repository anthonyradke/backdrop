"use strict";
const test = require("node:test");
const assert = require("node:assert");
const { load, SCENE } = require("./load.js");

test("a huge instantaneous burst stops at the particle limit", () => {
  const ctx = load(SCENE);
  const emit = require("node:vm").runInContext("System.prototype.emit", ctx);
  let spawned = 0;
  const live = [];
  const sys = { maxEach: 1000, rateK: 1, spawn: (inst) => { spawned++; if (inst.live.length < 1000) inst.live.push(1); } };
  const em = { age: 0, delay: 0, duration: 0, rate: 0, acc: 0, spent: false, d: { instantaneous: 1e12 } };
  emit.call(sys, { emitters: [em], live }, 0.016);
  assert.strictEqual(spawned, 1000);
});

test("a script that never returns gets its worker stopped", () => {
  const ctx = load(SCENE);
  let now = 0;
  ctx.performance = { now: () => now };
  const posted = [];
  let terminated = false;
  const scene = { worker: { postMessage: (m) => posted.push(m), terminate: () => { terminated = true; } }, warn: () => {}, cursorLayers: [], pointer: [0, 0] };
  ctx.WE.tickScripts(scene);
  assert.strictEqual(posted.length, 1);
  now = 1500;
  ctx.WE.tickScripts(scene);
  assert.ok(!terminated && posted.length === 1);
  now = 2600;
  ctx.WE.tickScripts(scene);
  assert.ok(terminated && scene.worker === null);
});

test("worker messages can't write outside a layer's script fields", async () => {
  const ctx = load(SCENE, { Worker: class { constructor() { ctx.lastWorker = this; } postMessage() {} terminate() {} } });
  const layer = { id: 1, name: "l", data: {}, origin: [0, 0, 0], scale: [1, 1, 1], angles: [0, 0, 0], color: [1, 1, 1], alpha: [1], brightness: [1], visible: [true], size: [1, 1], effects: [{ name: "fx" }] };
  const scene = {
    scripts: [{ id: 0, key: "origin", owner: layer, out: [0, 0, 0], properties: {}, source: "" }],
    layers: [layer], byId: new Map([[1, layer]]), timelines: [], userProps: {}, width: 1, height: 1,
    assets: { text: async (p) => (p.endsWith("baseclasses.js") ? "class Vec3 {}" : null) }, warn() {}, warnOnce() {}, addLayer() { throw new Error("no"); }, removeLayer() {},
  };
  await ctx.WE.startScripts(scene).catch((e) => console.log("startScripts:", e.message));
  const w = ctx.lastWorker;
  assert.ok(w && w.onmessage, "worker started");
  w.onmessage({ data: { type: "frame", results: [["__proto__", 1], [5, 1]], writes: [[1, "effects", [0]], [1, "origin", [1, 2, 3]], ["__proto__", "origin", [9]]], ops: [["play", "__proto__"], ["create", 2, null]] } });
  assert.deepStrictEqual(layer.origin, [1, 2, 3]);
  assert.deepStrictEqual(layer.effects, [{ name: "fx" }]);
  assert.strictEqual(Array.prototype.playing, undefined);
  assert.strictEqual(Object.prototype.playing, undefined);
});
