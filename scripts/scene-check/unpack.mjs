// Unpacks a scene.pkg: node unpack.mjs <pkg> <folder>. check.mjs imports `unpack` from here.
// The package comes from the internet, so every name has to stay inside the folder and every
// file has to lie inside the package.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export function unpack(pkg, dest) {
  const b = fs.readFileSync(pkg);
  let o = 0;
  const need = (n) => { if (o + n > b.length) throw new Error(`${pkg}: truncated`); };
  const u32 = () => { need(4); const v = b.readUInt32LE(o); o += 4; return v; };
  const str = () => { const n = u32(); need(n); const s = b.toString("utf8", o, o + n); o += n; return s; };
  str();
  const count = u32();
  if (count > 200_000) throw new Error(`${pkg}: ${count} files`);
  const files = [];
  for (let i = 0; i < count; i++) files.push([str(), u32(), u32()]);
  const root = path.resolve(dest);
  for (const [name, offset, len] of files) {
    const to = path.resolve(root, name);
    if (!to.startsWith(root + path.sep)) throw new Error(`${pkg}: bad file name ${name}`);
    if (o + offset + len > b.length) throw new Error(`${pkg}: ${name} runs past the end`);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.writeFileSync(to, b.subarray(o + offset, o + offset + len));
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [pkg, dest] = process.argv.slice(2);
  unpack(pkg, dest);
}
