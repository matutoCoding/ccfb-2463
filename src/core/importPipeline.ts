// 导入流水线：文件 -> 解析 Worker -> 八叉树 Worker -> IndexedDB
import { db } from '../core/db';
import type { CollectionRecord, ProgressMsg, WorkerError } from '../core/types';
import { uuid } from '../core/util';
import OctreeWorker from '../workers/octree.worker?worker';
import ParseWorker from '../workers/parse.worker?worker';
import type { ParseResponse } from '../workers/parse.worker';
import type { OctreeDone, OctreeResponse } from '../workers/octree.worker';

export interface ImportHandle {
  promise: Promise<CollectionRecord>;
  cancel: () => void;
}

export function importFile(
  file: File,
  onProgress: (p: ProgressMsg) => void,
): ImportHandle {
  const id = uuid();
  let cancelled = false;
  let parseWorker: Worker | null = null;
  let octreeWorker: Worker | null = null;

  const promise = (async (): Promise<CollectionRecord> => {
    // 先落一条 error 占位记录，成功后更新为 ready，保证坏文件也出现在列表里
    const placeholder: CollectionRecord = {
      id,
      name: file.name.replace(/\.[^.]+$/, ''),
      fileName: file.name,
      fileSize: file.size,
      pointCount: 0,
      bounds: { min: [0, 0, 0], max: [0, 0, 0] },
      origin: [0, 0, 0],
      hasColors: false,
      hasNormals: false,
      createdAt: Date.now(),
      status: 'error',
      error: '导入中…',
    };
    await db.putCollection(placeholder);

    try {
      const buffer = await file.arrayBuffer();
      if (cancelled) throw new Error('已取消导入');

      // 1) 解析
      parseWorker = new ParseWorker();
      const raw = await new Promise<ParseResponse>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('解析超时')), 30 * 60 * 1000);
        parseWorker!.onmessage = (ev: MessageEvent<ParseResponse>) => {
          const msg = ev.data;
          if (msg.type === 'progress') onProgress(msg.progress);
          if (msg.type === 'done' || msg.type === 'error') {
            clearTimeout(timer);
            resolve(msg);
          }
        };
        parseWorker!.onerror = (e) => {
          clearTimeout(timer);
          reject(e);
        };
        parseWorker!.postMessage({ type: 'parse', fileName: file.name, buffer }, [buffer]);
      });
      if (raw.type === 'error') {
        throw makeError(raw.error);
      }
      if (raw.type !== 'done') throw new Error('解析 Worker 返回了意外状态');
      const parsed = raw;
      if (cancelled) throw new Error('已取消导入');

      // 2) 八叉树
      octreeWorker = new OctreeWorker();
      const built = await new Promise<OctreeResponse>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('八叉树构建超时')), 60 * 60 * 1000);
        octreeWorker!.onmessage = (ev: MessageEvent<OctreeResponse>) => {
          const msg = ev.data;
          if (msg.type === 'progress') onProgress(msg.progress);
          if (msg.type === 'done' || msg.type === 'error') {
            clearTimeout(timer);
            resolve(msg);
          }
        };
        octreeWorker!.onerror = (e) => {
          clearTimeout(timer);
          reject(e);
        };
        const transfer = [
          parsed.positions.buffer,
          ...(parsed.colors ? [parsed.colors.buffer] : []),
          ...(parsed.normals ? [parsed.normals.buffer] : []),
        ];
        octreeWorker!.postMessage(
          { type: 'build', collectionId: id, raw: { ...parsed } },
          transfer,
        );
      });
      if (built.type === 'error') throw makeError(built.error);
      if (built.type !== 'done') throw new Error('八叉树 Worker 返回了意外状态');
      const octree = built;
      if (cancelled) throw new Error('已取消导入');

      // 3) 落库（分批，避免单事务过大）
      const BATCH = 64;
      for (let i = 0; i < octree.metas.length; i += BATCH) {
        const metaSlice = octree.metas.slice(i, i + BATCH).map((m) => ({ ...m, collectionId: id }));
        const blobSlice = octree.blobs.filter((b) =>
          metaSlice.some((m) => m.id === b.id),
        );
        await db.putNodes(id, metaSlice, blobSlice, octree.hasNormals, octree.hasColors);
        onProgress({
          stage: 'octree',
          loaded: Math.min(i + BATCH, octree.metas.length),
          total: octree.metas.length,
          message: `写入节点数据 ${Math.min(i + BATCH, octree.metas.length)}/${octree.metas.length}`,
        });
      }

      const record: CollectionRecord = {
        ...placeholder,
        pointCount: octree.totalPoints,
        bounds: parsed.bounds,
        origin: parsed.origin,
        hasColors: octree.hasColors,
        hasNormals: octree.hasNormals,
        status: 'ready',
        error: undefined,
      };
      await db.putCollection(record);
      return record;
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      await db.putCollection({ ...placeholder, status: 'error', error: message });
      throw e instanceof Error ? e : new Error(message);
    } finally {
      parseWorker?.terminate();
      octreeWorker?.terminate();
    }
  })();

  return {
    promise,
    cancel: () => {
      cancelled = true;
      parseWorker?.terminate();
      octreeWorker?.terminate();
    },
  };
}

function makeError(e: WorkerError): Error {
  const err = new Error(`[${e.code}] ${e.message}`) as Error & { code: string };
  err.code = e.code;
  return err;
}
