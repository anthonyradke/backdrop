// Turns Wallpaper Engine shaders into GLSL ES 3.00 for WebGL2. They're written for desktop GL's
// loose rules, so this runs its own preprocessor (undefined macros in #if are an error here), keeps
// the [COMBO] and uniform metadata in their comments, and repairs what the compiler then rejects.
"use strict";
var WE = window.WE || (window.WE = {});

const HEADER = `#define mul(x, y) ((y) * (x))
#define lerp mix
#define frac fract
#define CAST2(x) (vec2(x))
#define CAST3(x) (vec3(x))
#define CAST4(x) (vec4(x))
#define CAST3X3(x) (mat3(x))
#define float2 vec2
#define float3 vec3
#define float4 vec4
#define int2 ivec2
#define int3 ivec3
#define int4 ivec4
#define saturate(x) (clamp(x, 0.0, 1.0))
#define texSample2D texture
#define texSample2DLod textureLod
#define log10(x) (log2(x) * 0.301029995663981)
#define atan2 atan
#define fmod(x, y) ((x)-(y)*trunc((x)/(y)))
#define ddx dFdx
#define ddy(x) dFdy(-(x))
#define sampler2DComparison sampler2DShadow
#define texSample2DCompare texture
#define sampler2DBackBuffer sampler2D
#define texSample2DBackBuffer(s, uv, res) texture(s, uv)
#define CASTF(x) float(x)
#define GLSL 1
`;
const PRECISION = "precision highp float;\nprecision highp int;\nprecision highp sampler2D;\nprecision highp sampler2DShadow;\n";
// ES reserves these; desktop GL doesn't, and shaders use them as plain names.
const RESERVED = /\b(input|output|half|fixed|filter|sample|common|partition|active|cast|namespace|using|class|union|enum|template|this|public|static|extern|external|interface|long|short|double|superp|sizeof|goto|inline|noinline|volatile|resource|atomic_uint|noperspective|patch|subroutine|coherent|restrict|readonly|writeonly|typedef|asm)\b/g;

function stripComments(src) {
  return src.replace(/\r\n?/g, "\n").replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " ")).replace(/\\\n/g, " ");
}

// Pulls the JSON out of `// [COMBO] {...}` and `uniform T name; // {...}` lines.
function metadata(src, out) {
  for (const line of src.split("\n")) {
    const combo = line.match(/\/\/\s*\[COMBO\]\s*(\{.*\})/);
    if (combo) {
      try {
        const c = JSON.parse(combo[1]);
        if (c.combo && !(c.combo in out.combos)) out.combos[c.combo] = c;
      } catch {}
      continue;
    }
    const u = line.match(/^\s*uniform\s+(\w+)\s+(\w+)(\[\w+\])?\s*;\s*\/\/\s*(\{.*\})/);
    if (u) {
      try {
        const meta = JSON.parse(u[4]);
        if (!out.uniforms[u[2]]) out.uniforms[u[2]] = { type: u[1], name: u[2], meta };
      } catch {}
    }
  }
}

async function expandIncludes(src, read, seen, out) {
  metadata(src, out);
  const lines = stripComments(src).split("\n");
  const res = [];
  for (const raw of lines) {
    const line = raw.replace(/\/\/.*$/, "");
    const inc = line.match(/^\s*#\s*include\s+"([^"]+)"/);
    if (inc) {
      if (seen.has(inc[1])) continue;
      seen.add(inc[1]);
      const text = await read(inc[1]);
      if (text != null) res.push(await expandIncludes(text, read, seen, out));
      continue;
    }
    const req = line.match(/^\s*#\s*require\s+(\w+)/);
    if (req) {
      if (req[1] === "LightingV1") res.push("vec3 PerformLighting_V1(vec3 worldPos, vec3 albedo, vec3 normal, vec3 viewDir, vec3 specularTint, vec3 baseReflectance, float roughness, float metallic) { return vec3(0.0); }");
      continue;
    }
    res.push(line);
  }
  return res.join("\n");
}

// Evaluates a #if condition. Only numbers and operators reach Function(), which keeps it safe.
function evalCond(expr, defs) {
  let e = expr.replace(/\bdefined\s*\(\s*(\w+)\s*\)|\bdefined\s+(\w+)/g, (_, a, b) => (defs.has(a || b) ? "1" : "0"));
  for (let i = 0; i < 16; i++) {
    let changed = false;
    e = e.replace(/\b[A-Za-z_]\w*\b/g, (id) => {
      const d = defs.get(id);
      changed = true;
      return d === undefined || d.params || d.body === "" ? "0" : `(${d.body})`;
    });
    if (!changed) break;
  }
  if (!/^[\s\d.()!<>=&|+\-*/%^~?:]*$/.test(e) || !e.trim()) return false;
  try { return !!Function(`return (${e});`)(); } catch { return false; }
}

// Keeps only active lines. #defines stay in the output for the real compiler to expand.
function preprocess(src, defines) {
  const defs = new Map();
  for (const [k, v] of Object.entries(defines)) defs.set(k, { body: String(v) });
  const out = [];
  const stack = []; // { active, taken, parent }
  const on = () => !stack.length || stack[stack.length - 1].active;
  for (const line of src.split("\n")) {
    const m = line.match(/^\s*#\s*(\w+)\s*(.*)$/);
    if (!m) { if (on()) out.push(line); continue; }
    const [, dir, rest] = m;
    if (dir === "if" || dir === "ifdef" || dir === "ifndef") {
      const parent = on();
      const c = parent && (dir === "if" ? evalCond(rest, defs) : defs.has(rest.trim()) === (dir === "ifdef"));
      stack.push({ active: c, taken: c, parent });
    } else if (dir === "elif") {
      const s = stack[stack.length - 1];
      if (!s) continue;
      const c = s.parent && !s.taken && evalCond(rest, defs);
      s.active = c; s.taken = s.taken || c;
    } else if (dir === "else") {
      const s = stack[stack.length - 1];
      if (!s) continue;
      s.active = s.parent && !s.taken; s.taken = true;
    } else if (dir === "endif") {
      stack.pop();
    } else if (!on()) {
      continue;
    } else if (dir === "define") {
      const d = rest.match(/^(\w+)(\([^)]*\))?\s*(.*)$/);
      if (d) { defs.set(d[1], { params: d[2], body: d[3].trim() }); out.push(`#define ${rest}`); }
    } else if (dir === "undef") {
      defs.delete(rest.trim()); out.push(`#undef ${rest}`);
    }
    // #version, #extension, #pragma and the like are dropped.
  }
  return out.join("\n");
}

// Uniforms can be declared twice across includes, which ES refuses. And includes come before the
// uniforms they use (Wallpaper Engine pastes them lower down), so declarations move above the
// first function.
function hoistGlobals(src) {
  const seen = new Set(), globals = [], rest = [];
  let depth = 0, first = -1;
  for (const l of src.split("\n")) {
    if (depth === 0) {
      const m = l.match(/^\s*(uniform|varying|attribute)\s+(?:highp\s+|mediump\s+|lowp\s+)?\w+\s+(\w+)\s*(\[[^\]]*\])?\s*;/);
      if (m) {
        if (!seen.has(m[2])) { seen.add(m[2]); globals.push(l); }
        continue;
      }
    }
    for (const c of l) {
      if (c === "{") { if (depth === 0 && first < 0) first = rest.length; depth++; } else if (c === "}") depth--;
    }
    rest.push(l);
  }
  // The signature may sit on the line above the brace.
  if (first < 0) first = rest.length;
  else if (first > 0 && !/[(]/.test(rest[first]) && /[(]/.test(rest[first - 1])) first--;
  rest.splice(first, 0, ...globals);
  return rest.join("\n");
}

function intsToFloats(line) {
  // Array sizes and indices stay ints; so do hex numbers and anything glued to a name or a dot.
  const parts = line.split(/(\[[^\]]*\])/);
  return parts.map((p, i) => (i % 2 ? p : p.replace(/(?<![\w.])(\d+)(?![\w.])/g, "$1.0"))).join("");
}

function blanketFloats(src) {
  return src.split("\n").map((l) => {
    if (/^\s*#/.test(l) && !/^\s*#\s*define\s+\w+\(/.test(l)) return l;
    if (/\b(int|uint|ivec\d|uvec\d|for)\b/.test(l) || /%|<<|>>/.test(l)) return l;
    return intsToFloats(l);
  }).join("\n");
}

function errorLines(log, headerLines) {
  const lines = new Set();
  for (const m of log.matchAll(/ERROR:\s*\d+:(\d+):/g)) lines.add(+m[1] - headerLines - 1);
  return lines;
}

// HLSL's math functions take any mix of scalars, vectors and ints. Wrappers for exactly the names
// the compiler complained about stand in for the missing overloads.
const LOOSE = {
  pow: 2, max: 2, min: 2, mod: 2, step: 2, atan: 2, distance: 2, dot: 2, reflect: 2,
  clamp: 3, mix: 3, smoothstep: 3,
};
function looseWrappers(names) {
  let out = "";
  const types = ["float", "vec2", "vec3", "vec4"];
  for (const fn of names) {
    const arity = LOOSE[fn];
    if (arity === 2 && (fn === "dot" || fn === "distance" || fn === "reflect")) {
      const ret = (t) => (fn === "reflect" ? t : "float");
      for (const t of types) out += `${ret(t)} _${fn}(${t} a, ${t} b) { return ${fn}(a, b); }\n`;
      continue;
    }
    const seen = new Set();
    for (const t of types) {
      const kinds = t === "float" ? ["float", "int"] : [t, "float", "int"];
      const args = arity === 2 ? kinds.flatMap((a) => kinds.map((b) => [a, b])) : kinds.flatMap((a) => kinds.flatMap((b) => kinds.map((c) => [a, b, c])));
      for (const list of args) {
        if (!list.includes(t) && t !== "float") continue;
        const key = list.join();
        if (seen.has(key)) continue;
        seen.add(key);
        const names_ = "abc".slice(0, arity).split("");
        const params = list.map((ty, i) => `${ty} ${names_[i]}`).join(", ");
        const call = list.map((ty, i) => `${t}(${names_[i]})`);
        // mix's last argument stays a scalar when it was given one.
        if (fn === "mix" && list[2] !== t) call[2] = `float(c)`;
        out += `${t} _${fn}(${params}) { return ${fn}(${call.join(", ")}); }\n`;
      }
    }
  }
  return out + names.map((fn) => `#define ${fn} _${fn}\n`).join("");
}

// Compiles a shader, repairing the lines the compiler objects to (nearly always an int where ES
// wants a float) and falling back to converting every literal.
function compileWithFixes(gl, type, body, prefix) {
  let head = `#version 300 es\n${prefix}`;
  let headerLines = head.split("\n").length - 1;
  const wrapped = new Set();
  const wide = new Set([...body.matchAll(/^\s*varying\s+vec[34]\s+(\w+)\s*;/gm)].map((m) => m[1]));
  const ints = new Set([...body.matchAll(/\b(?:const\s+)?(?:int|uint)\s+(\w+)\s*[=;]/g)].map((m) => m[1]));
  const attempt = (src) => {
    const s = gl.createShader(type);
    gl.shaderSource(s, head + src);
    gl.compileShader(s);
    if (gl.getShaderParameter(s, gl.COMPILE_STATUS)) return { shader: s };
    const log = gl.getShaderInfoLog(s) || "";
    gl.deleteShader(s);
    return { log };
  };
  let src = body, last = "";
  for (let round = 0; round < 12; round++) {
    const r = attempt(src);
    if (r.shader) return r;
    last = r.log;
    if (!/ERROR/.test(last)) break; // context lost
    const lines = src.split("\n");
    let changed = false;
    for (const m of last.matchAll(/'(\w+)' : no matching overloaded function/g)) {
      if (LOOSE[m[1]] && !wrapped.has(m[1])) { wrapped.add(m[1]); changed = true; }
    }
    if (changed) {
      head = `#version 300 es\n${prefix}${looseWrappers([...wrapped])}`;
      headerLines = head.split("\n").length - 1;
      continue;
    }
    for (const n of errorLines(last, headerLines)) {
      if (lines[n] === undefined) continue;
      let fixed = intsToFloats(lines[n]);
      // HLSL quietly drops the extra components of a vec3 or vec4 varying passed as a vec2.
      if (fixed === lines[n]) fixed = lines[n].replace(/\b(\w+)\b(?![\w.(])/g, (id) => (wide.has(id) ? `${id}.xy` : id));
      // An int variable where a float belongs.
      if (fixed === lines[n] && !/\[/.test(lines[n]) && !/\bfor\b/.test(lines[n])) {
        fixed = lines[n].replace(/(?<![\w.])(\w+)(?![\w(])/g, (id, _, at) => (ints.has(id) && !/\b(int|uint)\s+$/.test(lines[n].slice(0, at)) ? `float(${id})` : id));
      }
      if (fixed !== lines[n]) { lines[n] = fixed; changed = true; }
    }
    if (!changed) break;
    src = lines.join("\n");
  }
  const r = attempt(blanketFloats(src));
  if (r.shader) return r;
  return { log: last || r.log, source: src };
}

// Varyings can disagree between stages (vec2 out, vec4 in). ES fails to link that, so the vertex
// shader's is widened to match.
function matchVaryings(vert, frag) {
  const want = {};
  for (const m of frag.matchAll(/^\s*varying\s+(\w+)\s+(\w+)\s*;/gm)) want[m[2]] = m[1];
  const copies = [];
  let out = vert.replace(/^(\s*varying\s+)(vec[234])(\s+)(\w+)(\s*;)/gm, (all, a, ty, b, name, c) => {
    if (!want[name] || want[name] === ty || !/^vec[234]$/.test(want[name])) return all;
    const from = +ty[3], to = +want[name][3];
    const local = `${name}_`;
    if (to > from) copies.push(`${name} = ${want[name]}(${local}${to - from === 1 ? ", 1.0" : ", 0.0, 1.0"});`);
    else copies.push(`${name} = ${local}.${"xyzw".slice(0, to)};`);
    return `${a}${want[name]}${b}${name}${c}\n${ty} ${local};`;
  });
  if (!copies.length) return out;
  const widened = copies.map((c) => c.split(" ")[0]);
  const lines = out.split("\n").map((l) => {
    if (/^\s*varying\b/.test(l)) return l;
    for (const n of widened) l = l.replace(new RegExp(`\\b${n}\\b`, "g"), `${n}_`);
    return l;
  });
  out = lines.join("\n");
  const end = out.lastIndexOf("}");
  return `${out.slice(0, end)}${copies.join("\n")}\n${out.slice(end)}`;
}

const fetchers = new Map();

// A shader's two stages with their metadata, ahead of knowing the combos.
WE.loadShaderSource = async function (assets, name) {
  if (fetchers.has(name)) return fetchers.get(name);
  const p = (async () => {
    const includeRead = (f) => assets.text(`shaders/${f}`);
    const [vs, fs] = await Promise.all([assets.text(`shaders/${name}.vert`), assets.text(`shaders/${name}.frag`)]);
    if (vs == null || fs == null) throw new Error(`shader ${name} not found`);
    const meta = { combos: {}, uniforms: {} };
    const vert = await expandIncludes(vs, includeRead, new Set(), meta);
    const frag = await expandIncludes(fs, includeRead, new Set(), meta);
    return { name, vert, frag, meta };
  })();
  fetchers.set(name, p);
  return p;
};

// Which combos a texture slot switches on, and the combos' defaults. `set` wins over both.
WE.resolveCombos = function (meta, set, textures) {
  const combos = {};
  for (const [k, c] of Object.entries(meta.combos)) combos[k] = c.default ?? 0;
  for (const u of Object.values(meta.uniforms)) {
    const slot = u.name.match(/^g_Texture(\d+)$/);
    if (!slot || !u.meta.combo) continue;
    if (textures && textures[+slot[1]]) combos[u.meta.combo] = 1;
    else if (!(u.meta.combo in combos)) combos[u.meta.combo] = 0;
  }
  for (const [k, v] of Object.entries(set || {})) combos[k.toUpperCase()] = +v;
  return combos;
};

// Attribute slots are fixed so a mesh works with any program.
WE.ATTRIB = { a_Position: 0, a_TexCoord: 1, a_TexCoordVec4: 1, a_Color: 2, a_TexCoordC2: 3, a_TexCoordVec4C1: 4, a_BlendIndices: 5, a_BlendWeights: 6, a_Normal: 7 };

WE.buildProgram = function (gl, source, combos) {
  const defines = {};
  for (const [k, v] of Object.entries(combos)) defines[k] = v;
  const pre = (src, vertex) => {
    const d = { ...defines, GLSL: 1 };
    const body = preprocess(HEADER + src, d);
    return hoistGlobals(body).replace(RESERVED, "$1_").replace(/\bgl_FragColor\b/g, vertex ? "gl_FragColor" : "out_FragColor");
  };
  const defs = Object.entries(defines).map(([k, v]) => `#define ${k} ${v}`).join("\n") + "\n";
  const fragBody = pre(source.frag, false);
  let vertBody = matchVaryings(pre(source.vert, true), fragBody);
  const vPrefix = `${PRECISION}#define attribute in\n#define varying out\n${defs}`;
  const fPrefix = `${PRECISION}out vec4 out_FragColor;\n#define varying in\n${defs}`;
  const v = compileWithFixes(gl, gl.VERTEX_SHADER, vertBody, vPrefix);
  if (!v.shader) throw new Error(`${source.name}.vert: ${firstError(v.log)}`);
  const f = compileWithFixes(gl, gl.FRAGMENT_SHADER, fragBody, fPrefix);
  if (!f.shader) { gl.deleteShader(v.shader); throw new Error(`${source.name}.frag: ${firstError(f.log)}`); }
  const prog = gl.createProgram();
  gl.attachShader(prog, v.shader);
  gl.attachShader(prog, f.shader);
  for (const [name, slot] of Object.entries(WE.ATTRIB)) gl.bindAttribLocation(prog, slot, name);
  gl.linkProgram(prog);
  gl.deleteShader(v.shader);
  gl.deleteShader(f.shader);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(prog);
    gl.deleteProgram(prog);
    throw new Error(`${source.name}: link: ${firstError(log)}`);
  }
  const uniforms = {};
  const n = gl.getProgramParameter(prog, gl.ACTIVE_UNIFORMS);
  for (let i = 0; i < n; i++) {
    const info = gl.getActiveUniform(prog, i);
    const name = info.name.replace(/\[0\]$/, "");
    uniforms[name] = { loc: gl.getUniformLocation(prog, info.name), type: info.type, size: info.size };
  }
  const attribs = {};
  for (let i = 0, c = gl.getProgramParameter(prog, gl.ACTIVE_ATTRIBUTES); i < c; i++) attribs[gl.getActiveAttrib(prog, i).name] = true;
  return { prog, uniforms, attribs, source, combos };
};

function firstError(log) {
  const m = String(log).match(/ERROR:[^\n]*/);
  return (m ? m[0] : String(log)).slice(0, 240);
}

WE.parseVec = function (v) {
  if (typeof v === "number" || typeof v === "boolean") return [+v];
  if (Array.isArray(v)) return v.map(Number);
  if (typeof v === "string") return v.trim().split(/\s+/).map(Number);
  return [0];
};
