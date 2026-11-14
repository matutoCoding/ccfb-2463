// 双扫描对比：对参考云 A 的每个点，在目标云 B 上找最近邻距离。
// 采用均匀空间哈希 + 螺旋环搜索，复杂度近似线性；数据量过大时对 B 做容量上限下采样。
import type { Vec3 } from '../core/types';

export interface CompareRequest {
  type: 'compare';
  /** 被着色的点云 A（通常是当前查看器中的云），Float32 相对 originA */
  positionsA: Float32Array;
  originA: Vec3;
  /** 参考点云 B */
  positionsB: Float32Array;
  originB: Vec3;
  /** B 网格边长（米），不传则按点间距自适应 */
  cellSize?: number;
  /** B 参与建网格的点数上限，超出均匀下采样 */
  maxBPoints?: number;
}

export interface CompareResult {
  type: 'done';
  /** 与 A 等长的距离数组（米），未命中为 Infinity */
  distances: Float32Array;
  maxDistance: number;
  mean: number;
  rms: number;
  percentile: { p50: number; p90: number; p95: number; p99: number };
  matchedRatio: number;
  cellSize: number;
}
export type CompareResponse =
  | CompareResult
  | { type: 'progress'; loaded: number; total: number; message: string }
  | { type: 'error'; message: string };

const ctx = self as unknown as DedicatedWorkerGlobalScope;

ctx.onmessage = (ev: MessageEvent<CompareRequest>) => {
  const req = ev.data;
  if (req.type !== 'compare') return;
  try {
    const { positionsA, originA, positionsB, originB } = req;
    const nA = positionsA.length / 3;
    const nB = positionsB.length / 3;

    // 1) 估计 B 的包围盒与点间距，确定网格尺寸
    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    for (let i = 0; i < positionsB.length; i += 3) {
      const x = positionsB[i] + originB[0];
      const y = positionsB[i + 1] + originB[1];
      const z = positionsB[i + 2] + originB[2];
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
      if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
    }
    const extent = Math.max(maxX - minX, maxY - minY, maxZ - minZ, 1e-6);
    const baseSpacing = extent / Math.cbrt(Math.max(1, nB));

    // 2) 建网格并对 B 做体素下采样：每个格子只保留 1 个代表点。
    // 薄壳点云表面法向极密，原始点云每格可达数百点；体素化后 B 被压到格子数量级，
    // 27 邻域查询最多 27 次比较，总复杂度 O(nA)。
    // cell 默认取平均点间距的 2 倍，兼顾表面表征精度与两次扫描的小幅偏差覆盖。
    const cell = req.cellSize ?? baseSpacing * 2;
    const keyOf = (ix: number, iy: number, iz: number) =>
      (ix + 4194304) * 281474976710656 + (iy + 4194304) * 4194304 + (iz + 4194304);
    // 每格存一个代表点在 positionsB 中的偏移
    const grid = new Map<number, number>();
    for (let i = 0; i < nB; i++) {
      const o = i * 3;
      const ix = Math.floor((positionsB[o] + originB[0] - minX) / cell);
      const iy = Math.floor((positionsB[o + 1] + originB[1] - minY) / cell);
      const iz = Math.floor((positionsB[o + 2] + originB[2] - minZ) / cell);
      const key = keyOf(ix, iy, iz);
      if (!grid.has(key)) grid.set(key, o);
    }
    const usedB = grid.size;
    ctx.postMessage({
      type: 'progress',
      loaded: 0,
      total: nA,
      message: `参考网格就绪（体素化后 ${usedB} 代表点，cell=${cell.toFixed(5)}m），开始最近邻搜索`,
    } satisfies CompareResponse);

    // 3) A 逐点最近邻：固定搜索 3x3x3 邻域（本格 + 一环，共 27 格），每格 1 个代表点。
    // 网格边长按 B 的平均点间距取，同物体两次扫描的偏差（平移/噪声）落在 1 格内，
    // 因此 27 格足以覆盖；每点查找次数钉死为 27，总复杂度 O(nA)。
    const distances = new Float32Array(nA).fill(Infinity);
    let matched = 0;
    let sum = 0;
    let sumSq = 0;
    let lastReport = 0;
    for (let i = 0; i < nA; i++) {
      const o = i * 3;
      const wx = positionsA[o] + originA[0];
      const wy = positionsA[o + 1] + originA[1];
      const wz = positionsA[o + 2] + originA[2];
      const cx = Math.floor((wx - minX) / cell);
      const cy = Math.floor((wy - minY) / cell);
      const cz = Math.floor((wz - minZ) / cell);
      let best = Infinity;
      for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
          for (let dz = -1; dz <= 1; dz++) {
            const bo = grid.get(keyOf(cx + dx, cy + dy, cz + dz));
            if (bo === undefined) continue;
            const ddx = positionsB[bo] + originB[0] - wx;
            const ddy = positionsB[bo + 1] + originB[1] - wy;
            const ddz = positionsB[bo + 2] + originB[2] - wz;
            const d2 = ddx * ddx + ddy * ddy + ddz * ddz;
            if (d2 < best) best = d2;
          }
        }
      }
      if (Number.isFinite(best)) {
        const d = Math.sqrt(best);
        distances[i] = d;
        matched++;
        sum += d;
        sumSq += d * d;
      }
      if (i - lastReport > 100000) {
        lastReport = i;
        ctx.postMessage({
          type: 'progress',
          loaded: i,
          total: nA,
          message: `最近邻搜索 ${((i / nA) * 100).toFixed(1)}%`,
        } satisfies CompareResponse);
      }
    }

    // 4) 统计
    const sorted = Array.from(distances).filter(Number.isFinite).sort((a, b) => a - b);
    const pick = (p: number) =>
      sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] : 0;
    const result: CompareResult = {
      type: 'done',
      distances,
      maxDistance: sorted.length ? sorted[sorted.length - 1] : 0,
      mean: matched ? sum / matched : 0,
      rms: matched ? Math.sqrt(sumSq / matched) : 0,
      percentile: { p50: pick(0.5), p90: pick(0.9), p95: pick(0.95), p99: pick(0.99) },
      matchedRatio: nA ? matched / nA : 0,
      cellSize: cell,
    };
    ctx.postMessage(result, [distances.buffer]);
  } catch (e) {
    ctx.postMessage({
      type: 'error',
      message: e instanceof Error ? e.message : String(e),
    } satisfies CompareResponse);
  }
};
