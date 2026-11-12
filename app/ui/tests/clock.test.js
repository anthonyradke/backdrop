"use strict";
const test = require("node:test");
const assert = require("node:assert");
const { load, SCENE } = require("./load.js");

// Drives Scene.start() with display frames at `hz` for `seconds` and reports what was drawn.
function run(hz, seconds, fps = 30) {
  let pending = null;
  const ctx = load(SCENE, { requestAnimationFrame: (f) => { pending = f; return 1; } });
  const drawn = [];
  const scene = { running: false, paused: false, fps, speed: 1, time: 0, renderAt: (t) => drawn.push(t) };
  ctx.performance = { now: () => 0 };
  ctx.WE.Scene.prototype.start.call(scene);
  for (let i = 1; i <= hz * seconds; i++) {
    const f = pending;
    pending = null;
    f((i * 1000) / hz);
  }
  return drawn;
}

for (const hz of [60, 75, 120, 144, 165, 240]) {
  test(`scene time keeps up with real time at ${hz} Hz`, () => {
    const drawn = run(hz, 10);
    assert.ok(Math.abs(drawn.at(-1) - 10) < 0.05, `scene time ${drawn.at(-1)} after 10 s`);
    assert.ok(drawn.length >= 290 && drawn.length <= 302, `${drawn.length} frames in 10 s`);
  });
}

test("a long gap doesn't jump the scene forward", () => {
  let pending = null;
  const ctx = load(SCENE, { requestAnimationFrame: (f) => { pending = f; return 1; } });
  const drawn = [];
  const scene = { running: false, paused: false, fps: 30, speed: 1, time: 0, renderAt: (t) => drawn.push(t) };
  ctx.WE.Scene.prototype.start.call(scene);
  pending(0);
  pending(60_000);
  assert.ok(drawn.at(-1) <= 0.25 + 1e-9);
});

test("a paused scene schedules no frames, and resuming doesn't jump", () => {
  let pending = null;
  const ctx = load(SCENE, { requestAnimationFrame: (f) => { pending = f; return 1; } });
  let now = 0;
  ctx.performance = { now: () => now };
  const drawn = [];
  const scene = { running: false, paused: false, fps: 30, speed: 1, time: 0, renderAt: (t) => drawn.push(t), videos: [], sounds: [] };
  const Scene = ctx.WE.Scene.prototype;
  Scene.start.call(scene);
  for (let i = 1; i <= 60; i++) { const f = pending; pending = null; now = (i * 1000) / 60; f(now); }
  Scene.setPaused.call(scene, true);
  const f = pending; pending = null; f(now += 16);
  assert.strictEqual(pending, null, "nothing scheduled while paused");
  now += 60_000;
  Scene.setPaused.call(scene, false);
  assert.ok(pending, "frames start again");
  const before = drawn.at(-1);
  for (let i = 1; i <= 30; i++) { const g = pending; pending = null; now += 1000 / 60; g(now); }
  assert.ok(drawn.at(-1) - before < 0.6, `moved ${drawn.at(-1) - before} s in half a second`);
});
