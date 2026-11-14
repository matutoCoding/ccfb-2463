// 八叉树构建 Worker：接收 RawPointCloud（transfer），输出节点 meta + blob 列表
import type { ProgressMsg, RawPointCloud, WorkerError } from '../core/types';
import { buildOctree } from './octree';

export interface OctreeRequest {
  type: 'build';
  collectionId: string;
  raw: RawPointCloud;
}
export interface OctreeDone {
  type: 'done';
  collectionId: string;
  rootId: number;
  hasNormals: boolean;
  hasColors: boolean;
  totalPoints: number;
  metas: ReturnType<typeof buildOctree>['metas'];
  blobs: { id: number; blob: Blob }[];
}
export type OctreeResponse =
  | OctreeDone
  | { type: 'progress'; progress: ProgressMsg }
  | { type: 'error'; error: WorkerError };

const ctx = self as unknown as DedicatedWorkerGlobalScope;

ctx.onmessage = (ev: MessageEvent<OctreeRequest>) => {
  const req = ev.data;
  if (req.type !== 'build') return;
  try {
    const result = buildOctree(req.raw, (done, total, message) => {
      const resp: OctreeResponse = {
        type: 'progress',
        progress: { stage: 'octree', loaded: done, total, message },
      };
      ctx.postMessage(resp);
    });
    const resp: OctreeResponse = {
      type: 'done',
      collectionId: req.collectionId,
      rootId: result.rootId,
      hasNormals: result.hasNormals,
      hasColors: result.hasColors,
      totalPoints: result.totalPoints,
      metas: result.metas,
      blobs: result.blobs,
    };
    ctx.postMessage(resp);
  } catch (e) {
    const resp: OctreeResponse = {
      type: 'error',
      error: {
        code: 'UNKNOWN',
        message: e instanceof Error ? e.message : String(e),
      },
    };
    ctx.postMessage(resp);
  }
};
