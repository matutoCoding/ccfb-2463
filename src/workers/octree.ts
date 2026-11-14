// 八叉树分级构建（Worker 内运行）。
// 策略：根节点保存空间均匀下采样点；递归 8 叉划分，每个内部节点保存
// “本层代表点”（相对父采样做差集，避免重复存储），叶节点保存全部剩余点。
// 节点二进制：pos Float32*3n | nrm Int8*3n（可选）| col Uint8*3n（可选）
import type { Bounds, OctreeNodeMeta, RawPointCloud, Vec3 } from '../core/types';

export const OCTREE_CAPACITY = 8192; // 叶节点目标点数
export const MAX_DEPTH = 12;

interface BuildNode {
  id: number;
  depth: number;
  parent: number;
  bounds: Bounds;
  /** 该节点直接保存的点（在输入数组中的索引） */
  ownIndices: number[];
  /** 全部后代点索引（用于下划分），构建完成后释放 */
  allIndices: number[];
  children: number[];
  spacing: number;
}

export interface BuildResult {
  metas: OctreeNodeMeta[];
  blobs: { id: number; blob: Blob }[];
  rootId: number;
  hasNormals: boolean;
  hasColors: boolean;
  totalPoints: number;
}

type ProgressCb = (done: number, total: number, message: string) => void;

/** 32 位确定性哈希，用于稳定的网格下采样 */
function hash32(i: number): number {
  let h = i | 0;
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b);
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b);
  h ^= h >>> 16;
  return h >>> 0;
}

export function buildOctree(raw: RawPointCloud, onProgress: ProgressCb): BuildResult {
  const { count, positions, colors, normals, origin } = raw;
  const hasColors = !!colors;
  const hasNormals = !!normals;
  const size: Vec3 = [
    raw.bounds.max[0] - raw.bounds.min[0],
    raw.bounds.max[1] - raw.bounds.min[1],
    raw.bounds.max[2] - raw.bounds.min[2],
  ];
  const rootBounds: Bounds = {
    min: [0, 0, 0],
    max: [
      Math.max(size[0], 1e-6),
      Math.max(size[1], 1e-6),
      Math.max(size[2], 1e-6),
    ],
  };
  const rootSpacing = Math.max(size[0], size[1], size[2]) / 128;

  const nodes: BuildNode[] = [];
  const root: BuildNode = {
    id: 0,
    depth: 0,
    parent: -1,
    bounds: rootBounds,
    ownIndices: [],
    allIndices: Array.from({ length: count }, (_, i) => i),
    children: new Array(8).fill(-1),
    spacing: rootSpacing,
  };
  nodes.push(root);

  // 栈式构建，避免深递归
  const stack: BuildNode[] = [root];
  let processed = 0;
  const totalForProgress = Math.max(1, count);

  while (stack.length) {
    const node = stack.pop()!;
    const { allIndices, depth, bounds } = node;
    const cell: Vec3 = [
      (bounds.max[0] - bounds.min[0]) / 2,
      (bounds.max[1] - bounds.min[1]) / 2,
      (bounds.max[2] - bounds.min[2]) / 2,
    ];
    const spacing = Math.max(cell[0], cell[1], cell[2]) / 16;
    node.spacing = spacing;

    // 网格下采样：cell 大小取 spacing，每格保留哈希最小的点
    const grid = new Map<number, number>();
    const isLeaf = depth >= MAX_DEPTH || allIndices.length <= OCTREE_CAPACITY;
    if (isLeaf) {
      node.ownIndices = allIndices;
    } else {
      const remainder: number[] = [];
      for (const idx of allIndices) {
        const o = idx * 3;
        const gx = Math.min(
          1048575,
          Math.max(0, Math.floor((positions[o] - bounds.min[0]) / spacing)),
        );
        const gy = Math.min(
          1048575,
          Math.max(0, Math.floor((positions[o + 1] - bounds.min[1]) / spacing)),
        );
        const gz = Math.min(
          1048575,
          Math.max(0, Math.floor((positions[o + 2] - bounds.min[2]) / spacing)),
        );
        const key = (gx * 1048576 + gy) * 1048576 + gz;
        const existing = grid.get(key);
        if (existing === undefined) {
          grid.set(key, idx);
        } else if (hash32(idx) < hash32(existing)) {
          remainder.push(existing);
          grid.set(key, idx);
        } else {
          remainder.push(idx);
        }
      }
      node.ownIndices = Array.from(grid.values());

      // 下划分到 8 个子节点
      const buckets: number[][] = Array.from({ length: 8 }, () => []);
      const mid: Vec3 = [
        bounds.min[0] + cell[0],
        bounds.min[1] + cell[1],
        bounds.min[2] + cell[2],
      ];
      for (const idx of remainder) {
        const o = idx * 3;
        const oct =
          (positions[o] >= mid[0] ? 1 : 0) |
          (positions[o + 1] >= mid[1] ? 2 : 0) |
          (positions[o + 2] >= mid[2] ? 4 : 0);
        buckets[oct].push(idx);
      }
      for (let oct = 0; oct < 8; oct++) {
        const pts = buckets[oct];
        if (pts.length === 0) continue;
        const childBounds: Bounds = {
          min: [
            bounds.min[0] + (oct & 1 ? cell[0] : 0),
            bounds.min[1] + (oct & 2 ? cell[1] : 0),
            bounds.min[2] + (oct & 4 ? cell[2] : 0),
          ],
          max: [
            bounds.min[0] + (oct & 1 ? 2 * cell[0] : cell[0]),
            bounds.min[1] + (oct & 2 ? 2 * cell[1] : cell[1]),
            bounds.min[2] + (oct & 4 ? 2 * cell[2] : cell[2]),
          ],
        };
        const child: BuildNode = {
          id: nodes.length,
          depth: depth + 1,
          parent: node.id,
          bounds: childBounds,
          ownIndices: [],
          allIndices: pts,
          children: new Array(8).fill(-1),
          spacing: 0,
        };
        nodes.push(child);
        node.children[oct] = child.id;
        stack.push(child);
      }
    }
    node.allIndices = []; // 释放
    processed += isLeaf ? allIndices.length : 0;
    onProgress(
      Math.min(processed, totalForProgress),
      totalForProgress,
      `八叉树构建：${nodes.length} 节点，深度 ${depth}`,
    );
  }

  // 序列化：每个节点一个 Blob，按 ownIndices 顺序紧凑打包。
  // 布局：pos Float32*3n(12n) | nrm Int8*3n | col Uint8*3n | 填充到 4 字节对齐
  const metas: OctreeNodeMeta[] = [];
  const blobs: { id: number; blob: Blob }[] = [];
  const rawStride = 12 + (hasNormals ? 3 : 0) + (hasColors ? 3 : 0);
  // 每点末尾补 0..3 字节，使单点步长 4 字节对齐，整块 ArrayBuffer 即可被 Float32Array 直接视图化
  const pointStride = Math.ceil(rawStride / 4) * 4;
  const padPerPoint = pointStride - rawStride;
  let totalPoints = 0;
  let byteOffset = 0;

  for (const node of nodes) {
    const n = node.ownIndices.length;
    totalPoints += n;
    const buf = new ArrayBuffer(n * pointStride);
    const f32 = new Float32Array(buf);
    const u8 = new Uint8Array(buf);
    for (let k = 0; k < n; k++) {
      const src = node.ownIndices[k] * 3;
      const dst = k * 3;
      f32[dst] = positions[src];
      f32[dst + 1] = positions[src + 1];
      f32[dst + 2] = positions[src + 2];
    }
    if (hasNormals && normals) {
      const nrmBase = n * 12;
      for (let k = 0; k < n; k++) {
        const src = node.ownIndices[k] * 3;
        // 量化到 int8：法线分量 [-1,1] -> [-127,127]
        u8[nrmBase + k * 3] = Math.max(-127, Math.min(127, Math.round(normals[src] * 127)));
        u8[nrmBase + k * 3 + 1] = Math.max(
          -127,
          Math.min(127, Math.round(normals[src + 1] * 127)),
        );
        u8[nrmBase + k * 3 + 2] = Math.max(
          -127,
          Math.min(127, Math.round(normals[src + 2] * 127)),
        );
      }
    }
    if (hasColors && colors) {
      const colBase = n * 12 + (hasNormals ? n * 3 : 0);
      for (let k = 0; k < n; k++) {
        const src = node.ownIndices[k] * 3;
        u8[colBase + k * 3] = colors[src];
        u8[colBase + k * 3 + 1] = colors[src + 1];
        u8[colBase + k * 3 + 2] = colors[src + 2];
      }
    }
    const worldBounds: Bounds = {
      min: [
        node.bounds.min[0] + origin[0],
        node.bounds.min[1] + origin[1],
        node.bounds.min[2] + origin[2],
      ],
      max: [
        node.bounds.max[0] + origin[0],
        node.bounds.max[1] + origin[1],
        node.bounds.max[2] + origin[2],
      ],
    };
    metas.push({
      collectionId: '',
      id: node.id,
      parent: node.parent,
      depth: node.depth,
      children: Int32Array.from(node.children),
      bounds: worldBounds,
      pointCount: n,
      byteOffset,
      byteLength: buf.byteLength,
      spacing: node.spacing,
    });
    byteOffset += buf.byteLength;
    blobs.push({ id: node.id, blob: new Blob([buf], { type: 'application/octet-stream' }) });
  }

  onProgress(totalForProgress, totalForProgress, `八叉树完成：${nodes.length} 节点 / ${totalPoints} 点`);
  return { metas, blobs, rootId: 0, hasNormals, hasColors, totalPoints };
}
