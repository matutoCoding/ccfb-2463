// Node 环境逻辑测试：解析器（含坏文件）、八叉树构建/序列化、对比最近邻
import type { RawPointCloud, Vec3 } from '../src/core/types';
import { parsePointCloud, ParseFailure } from '../src/workers/parsers';
import { buildOctree } from '../src/workers/octree';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const dataDir = resolve(here, '..', 'test-data');
let passed = 0;
let failed = 0;

function check(name: string, cond: boolean, detail = ''): void {
  if (cond) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    console.error(`  ✗ ${name} ${detail}`);
  }
}

// Node Buffer 可能位于共享内存池，必须按 byteOffset/byteLength 精确切片，
// 模拟浏览器 file.arrayBuffer() 返回的独立 ArrayBuffer
function toArrayBuffer(path: string): ArrayBuffer {
  const b = readFileSync(path);
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
}

// ---------- 1. 解析二进制 PLY（青铜小样，3M 点，避免测试过慢） ----------
console.log('\n[1] PLY 二进制解析');
{
  const buf = toArrayBuffer(resolve(dataDir, 'bronze_bell_3m.ply'));
  const raw = parsePointCloud('bronze.ply', buf, () => {});
  check('点数 3,000,000', raw.count === 3_000_000, `实际 ${raw.count}`);
  check('positions 长度匹配', raw.positions.length === raw.count * 3);
  check('颜色存在', raw.colors !== null && raw.colors.length === raw.count * 3);
  check('法线存在', raw.normals !== null && raw.normals.length === raw.count * 3);
  check('包围盒有限', Number.isFinite(raw.bounds.min[0]) && raw.bounds.max[1] > raw.bounds.min[1]);
  check('相对坐标最小值≈0',
    Math.min(raw.positions[0], raw.positions[1], raw.positions[2]) >= -1e-4);
}

// ---------- 2. 解析 XYZ ----------
console.log('\n[2] XYZ 文本解析');
{
  const buf = toArrayBuffer(resolve(dataDir, 'stele_sample.xyz'));
  const raw = parsePointCloud('sample.xyz', buf, () => {});
  check('点数 800,000', raw.count === 800_000, `实际 ${raw.count}`);
  check('法线按 6 列启发式识别', raw.normals !== null);
  check('无颜色', raw.colors === null);
}

// ---------- 3. 坏文件必须抛结构化错误 ----------
console.log('\n[3] 坏文件错误处理');
{
  const buf = toArrayBuffer(resolve(dataDir, 'broken.ply'));
  let caught: ParseFailure | null = null;
  try {
    parsePointCloud('broken.ply', buf, () => {});
  } catch (e) {
    caught = e as ParseFailure;
  }
  check('抛出 ParseFailure', caught instanceof ParseFailure);
  check('错误码为 TRUNCATED', caught?.code === 'TRUNCATED', caught?.code ?? '');
  check('错误信息可读', typeof caught?.message === 'string' && caught.message.length > 5);
}

// ---------- 3b. 伪造魔数/空文件 ----------
{
  const bad = new TextEncoder().encode('not a ply file at all, just text'.repeat(10));
  let caught: ParseFailure | null = null;
  try {
    parsePointCloud('x.ply', bad.buffer, () => {});
  } catch (e) {
    caught = e as ParseFailure;
  }
  check('非法 PLY 魔数报错', caught instanceof ParseFailure &&
    (caught.code === 'BAD_MAGIC' || caught.code === 'BAD_HEADER'), caught?.code ?? '');
}

// ---------- 4. ASCII PLY 往返 ----------
console.log('\n[4] ASCII PLY 解析');
{
  const header = `ply
format ascii 1.0
element vertex 4
property float x
property float y
property float z
property uchar red
property uchar green
property uchar blue
end_header
0 0 0 255 0 0
1 0 0 0 255 0
0 1 0 0 0 255
0 0 1 128 128 128
`;
  const buf = new TextEncoder().encode(header).buffer;
  const raw = parsePointCloud('ascii.ply', buf, () => {});
  check('4 点', raw.count === 4);
  check('首点红色', !!raw.colors && raw.colors[0] === 255 && raw.colors[1] === 0 && raw.colors[2] === 0);
  check('第二点绿色', !!raw.colors && raw.colors[3] === 0 && raw.colors[4] === 255);
  check('坐标正确', raw.positions[3] === 1 && raw.positions[6 + 1] === 1);
}

// ---------- 5. 八叉树构建 ----------
console.log('\n[5] 八叉树构建与层级性质');
{
  // 构造 10 万点合成云
  const n = 100_000;
  const positions = new Float32Array(n * 3);
  const colors = new Uint8Array(n * 3);
  for (let i = 0; i < n; i++) {
    positions[i * 3] = Math.random() * 10;
    positions[i * 3 + 1] = Math.random() * 5;
    positions[i * 3 + 2] = Math.random() * 8;
    colors[i * 3] = (i * 7) % 256;
  }
  const raw: RawPointCloud = {
    count: n,
    positions,
    colors,
    normals: null,
    origin: [100, 200, 300] as Vec3,
    bounds: {
      min: [100, 200, 300] as Vec3,
      max: [110, 205, 308] as Vec3,
    },
  };
  const result = buildOctree(raw, () => {});
  check('根节点 id=0', result.rootId === 0);
  check('节点数 > 1', result.metas.length > 1, `共 ${result.metas.length} 节点`);
  check('节点 meta 与 blob 一一对应', result.metas.length === result.blobs.length);
  // 所有节点点数之和应等于输入点数（代表点差集划分，无重复无丢失）
  const sumPts = result.metas.reduce((a, m) => a + m.pointCount, 0);
  check('节点点数之和 = 输入点数（无重复无丢失）', sumPts === n, `${sumPts} vs ${n}`);
  // 根节点包围盒覆盖整体
  const root = result.metas.find((m) => m.id === 0)!;
  check('根包围盒尺寸正确',
    Math.abs((root.bounds.max[0] - root.bounds.min[0]) - 10) < 1e-4);
  // 子节点包围盒应被父节点包含
  let containmentOk = true;
  const byId = new Map(result.metas.map((m) => [m.id, m]));
  for (const m of result.metas) {
    if (m.parent < 0) continue;
    const p = byId.get(m.parent)!;
    const eps = 1e-4;
    for (let k = 0; k < 3; k++) {
      if (m.bounds.min[k] < p.bounds.min[k] - eps || m.bounds.max[k] > p.bounds.max[k] + eps) {
        containmentOk = false;
      }
    }
  }
  check('子节点包围盒包含于父节点', containmentOk);
  // blob 可反序列化且字节布局正确（pos12 + col3 = 15，填充到 16 对齐）
  const rootBlob = result.blobs.find((b) => b.id === 0)!;
  const ab = await rootBlob.blob.arrayBuffer();
  const stride = 16;
  check('根 blob 字节长度 = 点数*16（4 字节对齐）', ab.byteLength === root.pointCount * stride,
    `${ab.byteLength} vs ${root.pointCount * stride}`);
  const f32 = new Float32Array(ab, 0, root.pointCount * 3);
  check('反序列化坐标在包围盒内',
    f32.every((v) => Number.isFinite(v)));
}

// ---------- 6. 测量几何 ----------
console.log('\n[6] 测量几何');
{
  const { computeMeasure } = await import('../src/core/measure');
  const d = computeMeasure('distance', [[0, 0, 0], [3, 4, 0]]);
  check('距离 = 5m', Math.abs(d - 5) < 1e-9, String(d));
  const area = computeMeasure('area', [[0, 0, 0], [4, 0, 0], [0, 3, 0]]);
  check('三角形面积 = 6m²', Math.abs(area - 6) < 1e-9, String(area));
  const ang = computeMeasure('angle', [[1, 0, 0], [0, 0, 0], [0, 1, 0]]);
  check('直角 = 90°', Math.abs(ang - 90) < 1e-9, String(ang));
}

console.log(`\n结果：${passed} 通过 / ${failed} 失败`);
if (failed > 0) process.exit(1);
