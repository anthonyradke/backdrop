// Unpacks a scene.pkg: node unpack.mjs <pkg> <folder>
import fs from "node:fs";
import path from "node:path";

const [pkg, dest] = process.argv.slice(2);
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
