// Loads the UI's plain browser scripts into one Node context, the way the player page does, so the
// pure parts (parsers, the frame clock, the shader preprocessor) can be tested without a browser.
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const UI = path.join(__dirname, "..");

function load(files, extra = {}) {
  const ctx = {
    console, TextDecoder, TextEncoder, performance, setTimeout, clearTimeout, URL, Blob,
    requestAnimationFrame: () => 0, cancelAnimationFrame: () => {},
    ...extra,
  };
  ctx.window = ctx;
  ctx.self = ctx;
  vm.createContext(ctx);
  for (const f of files) vm.runInContext(fs.readFileSync(path.join(UI, f), "utf8"), ctx, { filename: f });
  return ctx;
}

const SCENE = ["scene/tex.js", "scene/shader.js", "scene/scene.js", "scene/text.js", "scene/particles.js", "scene/puppet.js", "scene/script.js"];

module.exports = { load, SCENE };
