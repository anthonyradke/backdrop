"use strict";
const test = require("node:test");
const assert = require("node:assert");
const { load, SCENE } = require("./load.js");

const { stripComments, evalCond } = load(SCENE).WE.shaderInternals;

test("a /* inside a line comment doesn't swallow the code after it", () => {
  const src = "a; // see /* note\nuniform float keep;\n/* x */ b;";
  const out = stripComments(src);
  assert.match(out, /uniform float keep;/);
  assert.match(out, /^a;/);
  assert.match(out, /b;$/);
  assert.strictEqual(out.split("\n").length, 3);
});

test("the // /* ... // */ toggle keeps the code between", () => {
  const out = stripComments("// /*\nint kept;\n// */\nint also;");
  assert.match(out, /int kept;/);
  assert.match(out, /int also;/);
});

test("block comments still go, keeping line breaks", () => {
  assert.strictEqual(stripComments("a /* b\nc */ d"), "a     \n     d");
});

test("#if follows C rules", () => {
  const defs = new Map([["A", { body: "3" }], ["EMPTY", { body: "" }], ["F", { body: "x", params: ["x"] }]]);
  const t = (e) => evalCond(e, defs);
  assert.strictEqual(t("0x10 > 1"), true);
  assert.strictEqual(t("3/2 == 1"), true);
  assert.strictEqual(t("A == 3 && defined(A)"), true);
  assert.strictEqual(t("defined B || UNKNOWN"), false);
  assert.strictEqual(t("A > 2 ? 1 : 0"), true);
  assert.strictEqual(t("(1 << 4) == 16"), true);
  assert.strictEqual(t("-1 < 0"), true);
  assert.strictEqual(t("1u + 1"), true);
  assert.strictEqual(t("1 / 0"), false);
  assert.strictEqual(t("1 +"), false);
  assert.strictEqual(t(""), false);
  assert.strictEqual(t("alert(1)"), false);
});
