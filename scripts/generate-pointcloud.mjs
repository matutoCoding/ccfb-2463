#!/usr/bin/env node
// 测试点云生成脚本（零依赖，Node 流式写盘）。
// 产物：
//   test-data/stele_22m.ply        2200 万+点石碑，正面带凹陷刻字（二进制小端 PLY）
//   test-data/bronze_bell_3m.ply   300 万点青铜钟形器，带环带纹
//   test-data/stele_sample.xyz     80 万点 XYZ 文本小样
//   test-data/broken.ply           故意截断的坏文件，用于错误提示测试
//
// 用法：node scripts/generate-pointcloud.mjs [--out test-data]
import { createWriteStream, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const args = process.argv.slice(2);
const outIdx = args.indexOf('--out');
const outDir = resolve(root, outIdx >= 0 ? args[outIdx + 1] : 'test-data');
mkdirSync(outDir, { recursive: true });

// ---------- 确定性 PRNG（mulberry32） ----------
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(20241114);
const gauss = () => {
  // Box-Muller
  let u = 0, v = 0;
  while (u === 0) u = rand();
  while (v === 0) v = rand();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
};

// ---------- 笔画字体（5x7 点阵，0/1 表示刻槽） ----------
const FONT = {
  // 数字
  '0': ['01110','10001','10011','10101','11001','10001','01110'],
  '1': ['00100','01100','00100','00100','00100','00100','01110'],
  '2': ['01110','10001','00001','00010','00100','01000','11111'],
  '3': ['11110','00001','00001','01110','00001','00001','11110'],
  '4': ['00010','00110','01010','10010','11111','00010','00010'],
  '5': ['11111','10000','11110','00001','00001','10001','01110'],
  '6': ['00110','01000','10000','11110','10001','10001','01110'],
  '7': ['11111','00001','00010','00100','01000','01000','01000'],
  '8': ['01110','10001','10001','01110','10001','10001','01110'],
  '9': ['01110','10001','10001','01111','00001','00010','01100'],
  // 大写拉丁（石碑纪年用）
  A: ['01110','10001','10001','11111','10001','10001','10001'],
  B: ['11110','10001','10001','11110','10001','10001','11110'],
  C: ['01111','10000','10000','10000','10000','10000','01111'],
  D: ['11110','10001','10001','10001','10001','10001','11110'],
  E: ['11111','10000','10000','11110','10000','10000','11111'],
  H: ['10001','10001','10001','11111','10001','10001','10001'],
  I: ['11111','00100','00100','00100','00100','00100','11111'],
  N: ['10001','11001','10101','10011','10001','10001','10001'],
  // 中文笔画字（手写 7x7 点阵）
  石: ['0000000','0111100','0001000','0111110','0011000','0100100','0000000'],
  刻: ['0010000','0111110','1010000','0111100','0010100','0100010','0000000'],
  青: ['0010000','0111100','1010101','0111110','0010100','0101010','0100010'],
  铜: ['0011100','0100010','1111111','0100010','1010101','0101010','1000001'],
  馆: ['0010100','0111110','1010101','0111110','0010100','0101010','1010101'],
  藏: ['0111110','1000001','1111111','0010100','0101010','1010101','0000000'],
};

/**
 * 石碑参数（单位米，真实石刻尺寸）：高 1.8、宽 0.9、厚 0.25
 * 正面在 z = depth/2 平面，刻字为向内凹陷的槽
 */
const STELE = {
  height: 1.8,
  width: 0.9,
  depth: 0.25,
  // 目标点数 ~2200 万：正面高密度 + 侧面/顶面/底面
  frontPoints: 20_000_000,
  sidePoints: 2_200_000,
  text: '馆藏石刻 2024 A.D. 青石 001',
  glyphWidth: 0.052,
  glyphHeight: 0.075,
  glyphGap: 0.014,
  lineGap: 0.03,
  engraveDepth: 0.008,
  rows: 4,
};

function textLayout() {
  // 计算每行字符的网格位置（正面 xy 平面，z 为厚度方向）
  const chars = STELE.text.replace(/\s+/g, '').split('');
  const pitchX = STELE.glyphWidth + STELE.glyphGap;
  const pitchY = STELE.glyphHeight + STELE.lineGap;
  const perRow = Math.ceil(chars.length / STELE.rows);
  const placed = [];
  chars.forEach((ch, i) => {
    const row = Math.floor(i / perRow);
    const col = i % perRow;
    const rowChars = Math.min(perRow, chars.length - row * perRow);
    const x = -((rowChars - 1) * pitchX) / 2 + col * pitchX;
    const y = STELE.height / 2 - 0.22 - row * pitchY;
    placed.push({ ch, x, y });
  });
  return placed;
}
const LAYOUT = textLayout();

function isEngraved(x, y) {
  // 判断正面采样点 (x,y) 是否落在任一字符的刻槽内；返回槽深系数 0..1
  for (const g of LAYOUT) {
    const pattern = FONT[g.ch];
    if (!pattern) continue;
    const lx = x - g.x;
    const ly = y - g.y;
    if (lx < -STELE.glyphWidth / 2 || lx > STELE.glyphWidth / 2 ||
        ly < -STELE.glyphHeight / 2 || ly > STELE.glyphHeight / 2) continue;
    const col = Math.floor((lx + STELE.glyphWidth / 2) / (STELE.glyphWidth / 5));
    const row = Math.floor((STELE.glyphHeight / 2 - ly) / (STELE.glyphHeight / 7));
    if (row >= 0 && row < 7 && col >= 0 && col < 5 && pattern[row][col] === '1') {
      return 1;
    }
  }
  return 0;
}

// 石头基色（青灰），刻槽内颜色更深
function stoneColor(x, y, z, engraved) {
  const n = Math.sin(x * 137.1) * Math.cos(y * 91.7) * Math.sin(z * 211.3);
  const base = 118 + n * 14 + rand() * 8;
  if (engraved) {
    return [base * 0.45, base * 0.48, base * 0.5];
  }
  return [base * 0.92, base * 0.95, base];
}

function writePlyHeader(stream, count, hasColor, hasNormal) {
  const lines = [
    'ply',
    'format binary_little_endian 1.0',
    'comment generated by generate-pointcloud.mjs',
    `element vertex ${count}`,
    'property float x',
    'property float y',
    'property float z',
  ];
  if (hasNormal) {
    lines.push('property float nx', 'property float ny', 'property float nz');
  }
  if (hasColor) {
    lines.push('property uchar red', 'property uchar green', 'property uchar blue');
  }
  lines.push('end_header\n');
  stream.write(Buffer.from(lines.join('\n'), 'ascii'));
}

/** 通用流式二进制 PLY 写出器 */
function createPlyWriter(file, count, { color = true, normal = true } = {}) {
  const stream = createWriteStream(file, { highWaterMark: 1 << 20 });
  writePlyHeader(stream, count, color, normal);
  const stride = 12 + (normal ? 12 : 0) + (color ? 3 : 0);
  let written = 0;
  let buffer = Buffer.alloc(Math.min(count, 200000) * stride);
  let offset = 0;
  let closed = false;

  function flush() {
    if (offset === 0) return;
    stream.write(buffer.subarray(0, offset));
    offset = 0;
  }
  return {
    stride,
    write(p) {
      if (offset + stride > buffer.length) flush();
      let o = offset;
      buffer.writeFloatLE(p.x, o); buffer.writeFloatLE(p.y, o + 4); buffer.writeFloatLE(p.z, o + 8);
      o += 12;
      if (normal) {
        buffer.writeFloatLE(p.nx ?? 0, o);
        buffer.writeFloatLE(p.ny ?? 1, o + 4);
        buffer.writeFloatLE(p.nz ?? 0, o + 8);
        o += 12;
      }
      if (color) {
        buffer[o] = p.r; buffer[o + 1] = p.g; buffer[o + 2] = p.b;
        o += 3;
      }
      offset = o;
      written++;
      if (written % 2_000_000 === 0) {
        process.stdout.write(`\r  已写出 ${(written / 1e6).toFixed(1)}M 点`);
      }
    },
    end() {
      if (closed) return Promise.resolve();
      closed = true;
      flush();
      return new Promise((res) => stream.end(res));
    },
    get written() { return written; },
  };
}

async function generateStele() {
  const target = STELE.frontPoints + STELE.sidePoints;
  const file = join(outDir, 'stele_22m.ply');
  console.log(`\n[1/4] 石碑点云 -> ${file}（目标 ${(target / 1e6).toFixed(1)}M 点）`);
  const w = createPlyWriter(file, target, { color: true, normal: true });
  const H = STELE.height, W = STELE.width, D = STELE.depth;
  const frontZ = D / 2;

  // ---- 正面（含刻字）：面积加权均匀采样 + 微粗糙 ----
  for (let i = 0; i < STELE.frontPoints; i++) {
    const x = (rand() - 0.5) * W;
    const y = (rand() - 0.5) * H;
    const engraved = isEngraved(x, y);
    // 刻槽：z 向内凹，槽底略圆（用确定性扰动）
    const groove = engraved
      ? STELE.engraveDepth * (0.8 + 0.2 * Math.sin(x * 900) * Math.cos(y * 700))
      : 0;
    const roughness = gauss() * 0.0006;
    const z = frontZ - groove + roughness;
    const [r, g, b] = stoneColor(x, y, z, engraved);
    // 法线：刻槽内法线略向槽心倾斜，其余接近 +Z
    const tilt = engraved ? 0.35 : 0;
    w.write({
      x, y, z,
      nx: gauss() * 0.05 + (engraved ? Math.sin(x * 600) * tilt : 0),
      ny: gauss() * 0.05 + (engraved ? Math.cos(y * 600) * tilt : 0),
      nz: 1,
      r: Math.round(Math.min(255, r)),
      g: Math.round(Math.min(255, g)),
      b: Math.round(Math.min(255, b)),
    });
  }

  // ---- 背面（平整粗面）----
  const backN = Math.floor(STELE.sidePoints * 0.3);
  for (let i = 0; i < backN; i++) {
    const x = (rand() - 0.5) * W;
    const y = (rand() - 0.5) * H;
    const z = -frontZ + gauss() * 0.0006;
    const [r, g, b] = stoneColor(x, y, z, 0);
    w.write({ x, y, z, nx: 0, ny: gauss() * 0.05, nz: -1, r, g, b });
  }

  // ---- 四个侧面 + 顶面/底面 ----
  const restN = STELE.sidePoints - backN;
  const faceAreas = [
    W * H, W * H, D * H, D * H, W * D, W * D,
  ];
  const areaSum = faceAreas.reduce((a, b) => a + b, 0);
  for (let i = 0; i < restN; i++) {
    let pick = rand() * areaSum;
    let face = 0;
    for (; face < faceAreas.length; face++) {
      pick -= faceAreas[face];
      if (pick <= 0) break;
    }
    let x, y, z, nx, ny, nz;
    const rx = (rand() - 0.5), ry = (rand() - 0.5);
    if (face === 2) { x = -W / 2; y = ry * H; z = rx * D; nx = -1; ny = 0; nz = 0; }
    else if (face === 3) { x = W / 2; y = ry * H; z = rx * D; nx = 1; ny = 0; nz = 0; }
    else if (face === 4) { x = rx * W; y = H / 2; z = ry * D; nx = 0; ny = 1; nz = 0; }
    else { x = rx * W; y = -H / 2; z = ry * D; nx = 0; ny = -1; nz = 0; }
    x += gauss() * 0.0005; y += gauss() * 0.0005; z += gauss() * 0.0005;
    const [r, g, b] = stoneColor(x, y, z, 0);
    w.write({ x, y, z, nx, ny, nz, r, g, b });
  }
  await w.end();
  process.stdout.write(`\r  完成：${w.written.toLocaleString()} 点，${(w.written / 1e6).toFixed(2)}M\n`);
  return w.written;
}

/** 青铜钟形器：旋转剖面 + 环带纹（凸起），金属色 */
async function generateBronze() {
  const count = 3_000_000;
  const file = join(outDir, 'bronze_bell_3m.ply');
  console.log(`[2/4] 青铜钟点云 -> ${file}（${(count / 1e6).toFixed(1)}M 点）`);
  const w = createPlyWriter(file, count, { color: true, normal: true });
  const height = 1.1;
  // 半径随高度变化的钟形剖面（两段收腰）
  const radiusAt = (t) => {
    // t: 0(底) -> 1(顶)
    const base = 0.34 - 0.12 * t + 0.04 * Math.sin(t * Math.PI);
    const bands = 0.012 * (Math.sin(t * Math.PI * 12) > 0.6 ? 1 : 0);
    return base + bands;
  };
  for (let i = 0; i < count; i++) {
    const t = rand();
    const y = (t - 0.5) * height;
    const r = radiusAt(t) + gauss() * 0.0004;
    const theta = rand() * Math.PI * 2;
    const x = Math.cos(theta) * r;
    const z = Math.sin(theta) * r;
    // 青铜绿锈色，带斑驳
    const patina = Math.sin(x * 47 + z * 31) * Math.cos(y * 53);
    const rr = 70 + patina * 22 + rand() * 10;
    const gg = 110 + patina * 28 + rand() * 12;
    const bb = 85 + patina * 18 + rand() * 8;
    w.write({
      x, y, z,
      nx: Math.cos(theta), ny: 0.15 * Math.cos(t * Math.PI * 12), nz: Math.sin(theta),
      r: Math.round(rr), g: Math.round(gg), b: Math.round(bb),
    });
  }
  await w.end();
  process.stdout.write(`\r  完成：${w.written.toLocaleString()} 点\n`);
}

/**
 * 青铜钟“第二次扫描”：与首扫同构，但整体平移 8mm、并叠加毫米级随机噪声，
 * 模拟真实复测。用于对比页的最近邻距离场验证（预期距离集中在 ~0.01m）。
 */
async function generateBronzeRescan() {
  const count = 3_000_000;
  const file = join(outDir, 'bronze_bell_rescan_3m.ply');
  console.log(`[2b] 青铜钟二次扫描 -> ${file}（平移 8mm + 毫米级噪声）`);
  const w = createPlyWriter(file, count, { color: true, normal: true });
  const height = 1.1;
  const shiftX = 0.008; // 8mm 整体错位
  const radiusAt = (t) => {
    const base = 0.34 - 0.12 * t + 0.04 * Math.sin(t * Math.PI);
    const bands = 0.012 * (Math.sin(t * Math.PI * 12) > 0.6 ? 1 : 0);
    return base + bands;
  };
  for (let i = 0; i < count; i++) {
    const t = rand();
    const y = (t - 0.5) * height;
    const r = radiusAt(t) + gauss() * 0.0004;
    const theta = rand() * Math.PI * 2;
    // 毫米级三向噪声 + 整体平移
    const x = Math.cos(theta) * r + gauss() * 0.0012 + shiftX;
    const z = Math.sin(theta) * r + gauss() * 0.0012;
    const yy = y + gauss() * 0.0012;
    const patina = Math.sin(x * 47 + z * 31) * Math.cos(yy * 53);
    const rr = 70 + patina * 22 + rand() * 10;
    const gg = 110 + patina * 28 + rand() * 12;
    const bb = 85 + patina * 18 + rand() * 8;
    w.write({
      x, y: yy, z,
      nx: Math.cos(theta), ny: 0.15 * Math.cos(t * Math.PI * 12), nz: Math.sin(theta),
      r: Math.round(rr), g: Math.round(gg), b: Math.round(bb),
    });
  }
  await w.end();
  process.stdout.write(`\r  完成：${w.written.toLocaleString()} 点\n`);
}
  const count = 800_000;
  const file = join(outDir, 'stele_sample.xyz');
  console.log(`[3/4] XYZ 文本小样 -> ${file}（${(count / 1e4).toFixed(0)} 万点）`);
  const stream = createWriteStream(file, { highWaterMark: 1 << 20 });
  stream.write('# test stele sample, columns: x y z nx ny nz\n');
  const H = STELE.height, W = STELE.width, frontZ = STELE.depth / 2;
  let buf = '';
  for (let i = 0; i < count; i++) {
    const x = (rand() - 0.5) * W;
    const y = (rand() - 0.5) * H;
    const engraved = isEngraved(x, y);
    const z = frontZ - (engraved ? STELE.engraveDepth : 0) + gauss() * 0.0006;
    buf += `${x.toFixed(5)} ${y.toFixed(5)} ${z.toFixed(5)} 0 0 1\n`;
    if (i % 50000 === 0) {
      stream.write(buf);
      buf = '';
      process.stdout.write(`\r  已写出 ${(i / 1e4).toFixed(0)} 万`);
    }
  }
  stream.write(buf);
  await new Promise((r) => stream.end(r));
  process.stdout.write(`\r  完成：${count.toLocaleString()} 点\n`);
}

/** 坏文件：合法头部 + 数据截断，触发 TRUNCATED 错误 */
function generateBroken() {
  const file = join(outDir, 'broken.ply');
  console.log(`[4/4] 坏文件 -> ${file}（头部声明 100000 点，实际只给 100 点）`);
  const header = [
    'ply',
    'format binary_little_endian 1.0',
    'element vertex 100000',
    'property float x',
    'property float y',
    'property float z',
    'property uchar red',
    'property uchar green',
    'property uchar blue',
    'end_header\n',
  ].join('\n');
  const stride = 15;
  const body = Buffer.alloc(100 * stride);
  for (let i = 0; i < 100; i++) {
    body.writeFloatLE(rand(), i * stride);
    body.writeFloatLE(rand(), i * stride + 4);
    body.writeFloatLE(rand(), i * stride + 8);
  }
  writeFileSync(file, Buffer.concat([Buffer.from(header, 'ascii'), body]));
}

console.log('点云测试数据生成（确定性随机，可重复）');
const t0 = Date.now();
await generateStele();
await generateBronze();
await generateBronzeRescan();
await generateXyz();
generateBroken();
console.log(`\n全部完成，输出目录：${outDir}，耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
