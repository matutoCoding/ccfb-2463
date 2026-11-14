// 八叉树运行时加载器：LOD 遍历选择可见节点，从 IDB 惰性取节点数据，
// 上传 GPU 后按显存预算做 LRU 驱逐。节点在 GPU 上以交错 VAO 表示。
import { db, type StoredNodeMeta } from './db';
import type { Bounds, CollectionRecord, Vec3 } from './types';
import { v3 } from './math';

export interface GpuNode {
  meta: StoredNodeMeta;
  vao: WebGLVertexArrayObject;
  posBuf: WebGLBuffer;
  nrmBuf: WebGLBuffer | null;
  colBuf: WebGLBuffer | null;
  pointCount: number;
  pickBase: number;
  byteSize: number;
  lastUsedFrame: number;
  /** 本节点点在藏品线性编号中的起始偏移（差异纹理采样用） */
  linearStart: number;
}

export interface LodSelection {
  nodes: GpuNode[];
  /** 因尚未加载完成而缺失的节点 id，供下帧继续请求 */
  missing: number[];
}

interface QueuedLoad {
  id: number;
  priority: number;
}

const MAX_INFLIGHT = 4;

export class OctreeLoader {
  private metas = new Map<number, StoredNodeMeta>();
  private gpuNodes = new Map<number, GpuNode>();
  private queue: QueuedLoad[] = [];
  private inflight = 0;
  private loadingIds = new Set<number>();
  private frame = 0;
  private gpuBytes = 0;
  /** 每个节点在线性点编号空间中的起始偏移（构建期顺序累加） */
  private linearOffset = new Map<number, number>();
  private destroyed = false;

  constructor(
    private gl: WebGL2RenderingContext,
    public collection: CollectionRecord,
    private getVramBudget: () => number,
  ) {}

  async init(): Promise<void> {
    const stored = await db.getAllNodeMeta(this.collection.id);
    // 按 id 排序后计算线性偏移
    stored.sort((a, b) => a.id - b.id);
    let acc = 0;
    for (const m of stored) {
      this.metas.set(m.id, m);
      this.linearOffset.set(m.id, acc);
      acc += m.pointCount;
    }
    // 根节点无条件入队，保证任何视角/预算下最先有兜底画面
    this.enqueue(0, Number.POSITIVE_INFINITY);
  }

  get rootId(): number {
    return 0;
  }

  get totalPoints(): number {
    return this.collection.pointCount;
  }

  get loadedGpuBytes(): number {
    return this.gpuBytes;
  }

  get loadedNodeCount(): number {
    return this.gpuNodes.size;
  }

  get hasNormals(): boolean {
    return this.collection.hasNormals;
  }

  get hasColors(): boolean {
    return this.collection.hasColors;
  }

  /** 每帧调用：推进加载队列，并按当前显存预算主动收敛 */
  pump(): void {
    this.evictIfNeeded();
    if (this.inflight >= MAX_INFLIGHT || this.queue.length === 0) return;
    this.queue.sort((a, b) => b.priority - a.priority);
    const slots = MAX_INFLIGHT - this.inflight;
    const jobs = this.queue.splice(0, slots);
    for (const job of jobs) {
      if (this.gpuNodes.has(job.id) || this.destroyed) continue;
      this.inflight++;
      this.loadNode(job.id)
        .catch((e) => console.warn('节点加载失败', job.id, e))
        .finally(() => {
          this.inflight--;
        });
    }
  }

  private async loadNode(id: number): Promise<void> {
    const meta = this.metas.get(id);
    if (!meta) return;
    // 幂等：await 期间可能被重复入队，已在 GPU 或正在加载则跳过，避免缓冲泄漏与字节重复计数
    if (this.gpuNodes.has(id) || this.loadingIds.has(id)) return;
    this.loadingIds.add(id);
    try {
      await this.loadNodeInner(id, meta);
    } finally {
      this.loadingIds.delete(id);
    }
  }

  private async loadNodeInner(
    id: number,
    meta: StoredNodeMeta,
  ): Promise<void> {
    const buffer = await db.getNodeBlob(this.collection.id, id);
    if (this.destroyed) return;
    const gl = this.gl;
    const n = meta.pointCount;
    const hasN = meta.hasNormals;
    const hasC = meta.hasColors;
    const rawStride = 12 + (hasN ? 3 : 0) + (hasC ? 3 : 0);
    const stride = Math.ceil(rawStride / 4) * 4;
    const nrmOff = n * 12;
    const colOff = nrmOff + (hasN ? n * 3 : 0);

    const vao = gl.createVertexArray()!;
    gl.bindVertexArray(vao);

    const posBuf = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, posBuf);
    gl.bufferData(gl.ARRAY_BUFFER, buffer, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);

    let nrmBuf: WebGLBuffer | null = null;
    if (hasN) {
      nrmBuf = gl.createBuffer()!;
      gl.bindBuffer(gl.ARRAY_BUFFER, nrmBuf);
      // 法线单独缓冲（Int8 归一化）
      const nrmBytes = new Uint8Array(buffer, nrmOff, n * 3);
      gl.bufferData(gl.ARRAY_BUFFER, nrmBytes, gl.STATIC_DRAW);
      gl.enableVertexAttribArray(1);
      gl.vertexAttribPointer(1, 3, gl.BYTE, true, 0, 0);
    } else {
      gl.disableVertexAttribArray(1);
      gl.vertexAttrib3f(1, 0, 1, 0);
    }

    let colBuf: WebGLBuffer | null = null;
    if (hasC) {
      colBuf = gl.createBuffer()!;
      gl.bindBuffer(gl.ARRAY_BUFFER, colBuf);
      const colBytes = new Uint8Array(buffer, colOff, n * 3);
      gl.bufferData(gl.ARRAY_BUFFER, colBytes, gl.STATIC_DRAW);
      gl.enableVertexAttribArray(2);
      gl.vertexAttribPointer(2, 3, gl.UNSIGNED_BYTE, true, 0, 0);
    } else {
      gl.disableVertexAttribArray(2);
      gl.vertexAttrib3f(2, 0.72, 0.68, 0.62); // 无真彩时的石质默认色
    }
    gl.bindVertexArray(null);

    const node: GpuNode = {
      meta,
      vao,
      posBuf,
      nrmBuf,
      colBuf,
      pointCount: n,
      pickBase: this.linearOffset.get(id) ?? 0,
      byteSize: n * stride + (hasN ? n * 3 : 0) + (hasC ? n * 3 : 0),
      lastUsedFrame: this.frame,
      linearStart: this.linearOffset.get(id) ?? 0,
    };
    this.gpuNodes.set(id, node);
    this.gpuBytes += node.byteSize;
    this.evictIfNeeded();
  }

  /** 按显存预算 LRU 驱逐；根节点（id=0）常驻，保证任何预算下都有兜底画面 */
  evictIfNeeded(): void {
    const budget = this.getVramBudget() * 1024 * 1024;
    if (this.gpuBytes <= budget) return;
    const lru = Array.from(this.gpuNodes.values())
      .filter((n) => n.meta.id !== 0) // 根节点常驻
      .sort((a, b) => a.lastUsedFrame - b.lastUsedFrame);
    for (const node of lru) {
      if (this.gpuBytes <= budget * 0.9) break;
      this.disposeGpuNode(node);
      this.gpuNodes.delete(node.meta.id);
    }
  }

  private disposeGpuNode(node: GpuNode): void {
    const gl = this.gl;
    gl.deleteVertexArray(node.vao);
    gl.deleteBuffer(node.posBuf);
    if (node.nrmBuf) gl.deleteBuffer(node.nrmBuf);
    if (node.colBuf) gl.deleteBuffer(node.colBuf);
    this.gpuBytes -= node.byteSize;
  }

  /**
   * LOD 选择：从根向下，计算节点包围球在屏幕上的投影间距。
   * 当 spacing 的屏幕投影 <= 像素误差阈值时停在该节点；
   * 已加载则渲染，未加载则用最近的已加载祖先兜底，并把目标节点入队。
   */
  selectLod(
    viewProj: Float32Array,
    cameraPos: Vec3,
    viewportHeight: number,
    fovy: number,
    pixelError: number,
  ): LodSelection {
    this.frame++;
    const selected: GpuNode[] = [];
    const missing: number[] = [];
    const fallback = new Map<number, GpuNode>();

    const visit = (nodeId: number, ancestorGpu: GpuNode | null): void => {
      const meta = this.metas.get(nodeId);
      if (!meta) return;
      const gpu = this.gpuNodes.get(nodeId) ?? null;
      const currentAncestor = gpu ?? ancestorGpu;
      const center = boundsCenterOf(meta.bounds);
      const radius = v3.dist(center, meta.bounds.max);
      const dist = Math.max(1e-6, v3.dist(cameraPos, center) - radius);
      // spacing 的屏幕像素尺寸
      const projected =
        (meta.spacing * viewportHeight) / (2 * Math.tan(fovy / 2) * dist);
      const meetsError = projected <= pixelError;
      const isLeaf = meta.children.every((c) => c < 0);

      if (meetsError || isLeaf) {
        if (gpu) {
          gpu.lastUsedFrame = this.frame;
          selected.push(gpu);
        } else {
          if (currentAncestor) {
            fallback.set(currentAncestor.meta.id, currentAncestor);
          }
          missing.push(nodeId);
          // 根节点给最高优先级，其余按距离排序
          this.enqueue(nodeId, nodeId === 0 ? Number.POSITIVE_INFINITY : 1 / dist);
        }
        return;
      }
      let hasChild = false;
      for (const childId of meta.children) {
        if (childId >= 0) {
          hasChild = true;
          visit(childId, currentAncestor);
        }
      }
      if (!hasChild) {
        if (gpu) {
          gpu.lastUsedFrame = this.frame;
          selected.push(gpu);
        } else if (currentAncestor) {
          fallback.set(currentAncestor.meta.id, currentAncestor);
          missing.push(nodeId);
          this.enqueue(nodeId, 1 / dist);
        }
      }
    };

    visit(0, null);
    const fallbackNodes = Array.from(fallback.values()).filter(
      (n) => !selected.some((s) => s.meta.id === n.meta.id),
    );
    return { nodes: selected.concat(fallbackNodes), missing };
  }

  private enqueue(id: number, priority: number): void {
    if (this.gpuNodes.has(id)) return;
    const existing = this.queue.find((q) => q.id === id);
    if (existing) {
      existing.priority = Math.max(existing.priority, priority);
    } else {
      this.queue.push({ id, priority });
    }
  }

  /** 拾取：把点线性编号映射回世界坐标（从 IDB 节点数据读取） */
  async resolvePoint(linearId: number): Promise<Vec3 | null> {
    // 线性找到包含该编号的节点（节点按 id 顺序对应线性点编号空间）
    let acc = 0;
    for (const meta of Array.from(this.metas.values()).sort((a, b) => a.id - b.id)) {
      if (linearId < acc + meta.pointCount) {
        const buffer = await db.getNodeBlob(this.collection.id, meta.id);
        const f32 = new Float32Array(buffer, 0, meta.pointCount * 3);
        const local = (linearId - acc) * 3;
        const o = this.collection.origin;
        return [f32[local] + o[0], f32[local + 1] + o[1], f32[local + 2] + o[2]];
      }
      acc += meta.pointCount;
    }
    return null;
  }

  /** 读取某节点的全部世界坐标点（剖面导出用，流式逐节点） */
  async *iterateAllPoints(): AsyncGenerator<{ positions: Float32Array; origin: Vec3 }> {
    const ids = Array.from(this.metas.keys()).sort((a, b) => a - b);
    for (const id of ids) {
      const meta = this.metas.get(id)!;
      const buffer = await db.getNodeBlob(this.collection.id, id);
      // 位置始终在节点 blob 起始处，且长度为 12*n，4 字节对齐
      const f32 = new Float32Array(buffer, 0, meta.pointCount * 3);
      yield { positions: f32, origin: this.collection.origin };
    }
  }

  getMeta(id: number): StoredNodeMeta | undefined {
    return this.metas.get(id);
  }

  allMetas(): StoredNodeMeta[] {
    return Array.from(this.metas.values());
  }

  destroy(): void {
    this.destroyed = true;
    for (const node of this.gpuNodes.values()) {
      this.disposeGpuNode(node);
    }
    this.gpuNodes.clear();
    this.queue = [];
  }
}

function boundsCenterOf(b: Bounds): Vec3 {
  return [
    (b.min[0] + b.max[0]) / 2,
    (b.min[1] + b.max[1]) / 2,
    (b.min[2] + b.max[2]) / 2,
  ];
}
