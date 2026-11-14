// 仅生成青铜钟二次扫描（对比测试用），独立可执行
import { createWriteStream, mkdirSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = resolve(root, 'test-data');
mkdirSync(outDir, { recursive: true });

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(987654321);
const gauss = () => {
  let u = 0, v = 0;
  while (u === 0) u = rand();
  while (v === 0) v = rand();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
};

const count = 3_000_000;
const file = join(outDir, 'bronze_bell_rescan_3m.ply');
const stream = createWriteStream(file, { highWaterMark: 1 << 20 });
const header = [
  'ply', 'format binary_little_endian 1.0',
  `element vertex ${count}`,
  'property float x', 'property float y', 'property float z',
  'property float nx', 'property float ny', 'property float nz',
  'property uchar red', 'property uchar green', 'property uchar blue',
  'end_header\n',
].join('\n');
stream.write(Buffer.from(header, 'ascii'));
const stride = 27;
const buf = Buffer.alloc(100000 * stride);
let off = 0;
const height = 1.1;
const shiftX = 0.008;
const radiusAt = (t) =>
  0.34 - 0.12 * t + 0.04 * Math.sin(t * Math.PI) +
  0.012 * (Math.sin(t * Math.PI * 12) > 0.6 ? 1 : 0);
for (let i = 0; i < count; i++) {
  const t = rand();
  const y = (t - 0.5) * height;
  const r = radiusAt(t) + gauss() * 0.0004;
  const theta = rand() * Math.PI * 2;
  const x = Math.cos(theta) * r + gauss() * 0.0012 + shiftX;
  const z = Math.sin(theta) * r + gauss() * 0.0012;
  const yy = y + gauss() * 0.0012;
  const patina = Math.sin(x * 47 + z * 31) * Math.cos(yy * 53);
  const rr = Math.round(70 + patina * 22 + rand() * 10);
  const gg = Math.round(110 + patina * 28 + rand() * 12);
  const bb = Math.round(85 + patina * 18 + rand() * 8);
  buf.writeFloatLE(x, off); buf.writeFloatLE(yy, off + 4); buf.writeFloatLE(z, off + 8);
  buf.writeFloatLE(Math.cos(theta), off + 12);
  buf.writeFloatLE(0.15 * Math.cos(t * Math.PI * 12), off + 16);
  buf.writeFloatLE(Math.sin(theta), off + 20);
  buf[off + 24] = rr; buf[off + 25] = gg; buf[off + 26] = bb;
  off += stride;
  if (off === buf.length) { stream.write(buf); off = 0; }
}
if (off > 0) stream.write(buf.subarray(0, off));
await new Promise((res) => stream.end(res));
console.log(`完成：${file}（${count} 点）`);
