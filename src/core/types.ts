// 全局共享类型定义

/** 解析后的原始点云（点以相对 min 的 float32 存储，min 单独保存以保证精度） */
export interface RawPointCloud {
  count: number;
  /** Float32Array，长度 3*count，相对 origin 的坐标（米） */
  positions: Float32Array;
  /** 原点（世界坐标最小角） */
  origin: Vec3;
  /** Uint8Array，长度 3*count，无颜色时为 null */
  colors: Uint8Array | null;
  /** Float32Array，长度 3*count，无法线时为 null */
  normals: Float32Array | null;
  bounds: Bounds;
}

export type Vec3 = [number, number, number];

export interface Bounds {
  min: Vec3;
  max: Vec3;
}

/** 解析/构建过程中推送的进度消息 */
export interface ProgressMsg {
  stage: 'parse' | 'octree' | 'compare';
  loaded: number;
  total: number;
  message: string;
}

/** Worker 统一错误结构 */
export interface WorkerError {
  code:
    | 'BAD_MAGIC'
    | 'BAD_HEADER'
    | 'UNSUPPORTED_FORMAT'
    | 'TRUNCATED'
    | 'EMPTY_CLOUD'
    | 'BAD_NUMERIC'
    | 'UNKNOWN';
  message: string;
  byteOffset?: number;
}

/** 藏品库记录（collections 表） */
export interface CollectionRecord {
  id: string;
  name: string;
  fileName: string;
  fileSize: number;
  pointCount: number;
  bounds: Bounds;
  origin: Vec3;
  hasColors: boolean;
  hasNormals: boolean;
  createdAt: number;
  status: 'ready' | 'error';
  error?: string;
}

/** 八叉树节点元信息（nodeMeta 表，blob 单独存 nodeData） */
export interface OctreeNodeMeta {
  collectionId: string;
  id: number;
  parent: number; // -1 表示根
  depth: number;
  /** 八叉树子节点 id，长度 8，-1 表示无 */
  children: Int32Array;
  bounds: Bounds;
  /** 本节点包含的点数（含下采样汇总点） */
  pointCount: number;
  /** 在节点 blob 中的字节偏移 */
  byteOffset: number;
  byteLength: number;
  /** 节点代表点的世界空间间距，用于 LOD 屏幕误差判断 */
  spacing: number;
}

/** 节点二进制布局魔数 */
export const NODE_LAYOUT = {
  /** positions Float32 xyz 相对 collection origin */
  posFloats: 3,
  /** normals Int8 xyz（量化法线），无则省略，由 meta 旁的标志判断 */
  nrmBytes: 3,
  /** colors Uint8 rgb，无则省略 */
  colBytes: 3,
} as const;

export type ColorMode = 'rgb' | 'elevation' | 'normal' | 'diff';
export type ClipMode = 'none' | 'plane' | 'box';

export interface Plane {
  /** 归一化法线 */
  normal: Vec3;
  /** 平面上一点 */
  point: Vec3;
}

export type MeasureKind = 'distance' | 'area' | 'angle';

export interface MeasureRecord {
  id: string;
  collectionId: string;
  kind: MeasureKind;
  /** 参与计算的世界坐标点（距离 2 个、面积 3 个、角度 3 个，顶点在中间） */
  points: Vec3[];
  result: number; // 米 / 平方米 / 度
  note: string;
  createdAt: number;
}

export interface Bookmark {
  id: string;
  collectionId: string;
  name: string;
  /** 相机轨道参数 */
  target: Vec3;
  distance: number;
  yaw: number;
  pitch: number;
  createdAt: number;
}

export interface ViewerSettings {
  /** 显存预算（MB），超出后 LRU 驱逐节点 GPU 缓冲 */
  vramBudgetMB: number;
  /** 点大小（像素） */
  pointSize: number;
  /** EDL 强度 */
  edlStrength: number;
  /** EDL 邻域半径（像素） */
  edlRadius: number;
  /** LOD 屏幕误差阈值（像素），越小越精细 */
  lodPixelError: number;
  /** 背景色（线性 0..1 rgb） */
  background: Vec3;
  /** 自适应质量：低于帧率阈值时自动降点大小/提高误差 */
  adaptiveQuality: boolean;
  fpsTarget: number;
}

export const DEFAULT_SETTINGS: ViewerSettings = {
  vramBudgetMB: 1024,
  pointSize: 2.0,
  edlStrength: 1.6,
  edlRadius: 2.2,
  lodPixelError: 2.5,
  background: [0.09, 0.1, 0.12],
  adaptiveQuality: true,
  fpsTarget: 30,
};
