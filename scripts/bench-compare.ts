// 对比算法性能基准：在 Node 真实算力下测最近邻搜索耗时
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parsePointCloud } from '../src/workers/parsers';

const here = dirname(fileURLToPath(import.meta.url));
const dataDir = resolve(here, '..', 'test-data');
const toArrayBuffer = (p: string) => {
  const b = readFileSync(p);
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
};

console.log('解析两次扫描…');
const a = parsePointCloud('a.ply', toArrayBuffer(resolve(dataDir, 'bronze_bell_3m.ply')), () => {});
const b = parsePointCloud('b.ply', toArrayBuffer(resolve(dataDir, 'bronze_bell_rescan_3m.ply')), () => {});
console.log(`A=${a.count} 点, B=${b.count} 点`);

// 复刻 worker 的网格 + 27 邻域搜索
const t0 = performance.now();
let minX = Infinity, minY = Infinity, minZ = Infinity;
let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
for (let i = 0; i < b.positions.length; i += 3) {
  const x = b.positions[i] + b.origin[0];
  const y = b.positions[i + 1] + b.origin[1];
  const z = b.positions[i + 2] + b.origin[2];
  if (x < minX) minX = x; if (x > maxX) maxX = x;
  if (y < minY) minY = y; if (y > maxY) maxY = y;
  if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
}
const extent = Math.max(maxX - minX, maxY - minY, maxZ - minZ);
const baseSpacing = extent / Math.cbrt(b.count);
const keyOf = (ix: number, iy: number, iz: number) =>
  (ix + 4194304) * 281474976710656 + (iy + 4194304) * 4194304 + (iz + 4194304);
const cell = baseSpacing * 2;
// 体素下采样：每格一个代表点
const grid = new Map<number, number>();
for (let i = 0; i < b.count; i++) {
  const o = i * 3;
  const ix = Math.floor((b.positions[o] + b.origin[0] - minX) / cell);
  const iy = Math.floor((b.positions[o + 1] + b.origin[1] - minY) / cell);
  const iz = Math.floor((b.positions[o + 2] + b.origin[2] - minZ) / cell);
  const key = keyOf(ix, iy, iz);
  if (!grid.has(key)) grid.set(key, o);
}
const tGrid = performance.now();
console.log(`网格构建：${(tGrid - t0).toFixed(0)}ms，体素化后 ${grid.size} 代表点，cell=${cell.toFixed(5)}m`);

let matched = 0;
let sum = 0;
let maxD = 0;
const nA = a.count;
for (let i = 0; i < nA; i++) {
  const o = i * 3;
  const wx = a.positions[o] + a.origin[0];
  const wy = a.positions[o + 1] + a.origin[1];
  const wz = a.positions[o + 2] + a.origin[2];
  const cx = Math.floor((wx - minX) / cell);
  const cy = Math.floor((wy - minY) / cell);
  const cz = Math.floor((wz - minZ) / cell);
  let best = Infinity;
  for (let dx = -1; dx <= 1; dx++)
    for (let dy = -1; dy <= 1; dy++)
      for (let dz = -1; dz <= 1; dz++) {
        const bo = grid.get(keyOf(cx + dx, cy + dy, cz + dz));
        if (bo === undefined) continue;
        const ddx = b.positions[bo] + b.origin[0] - wx;
        const ddy = b.positions[bo + 1] + b.origin[1] - wy;
        const ddz = b.positions[bo + 2] + b.origin[2] - wz;
        const d2 = ddx * ddx + ddy * ddy + ddz * ddz;
        if (d2 < best) best = d2;
      }
  if (Number.isFinite(best)) {
    const d = Math.sqrt(best);
    matched++;
    sum += d;
    if (d > maxD) maxD = d;
  }
}
const t1 = performance.now();
console.log(`最近邻搜索：${(t1 - tGrid).toFixed(0)}ms（${nA} 点）`);
console.log(`总耗时：${(t1 - t0).toFixed(0)}ms`);
console.log(`匹配率：${(matched / nA * 100).toFixed(1)}%，均值距离：${(sum / matched).toFixed(5)}m，最大：${maxD.toFixed(5)}m`);
console.log(`预期：均值应接近噪声+平移量级 ~0.01m`);
