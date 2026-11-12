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
