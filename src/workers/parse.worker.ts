// 解析 Worker：接收文件 ArrayBuffer，解析后把点云 transfer 回主线程
import type { ProgressMsg, WorkerError } from '../core/types';
import { ParseFailure, parsePointCloud } from './parsers';

export interface ParseRequest {
  type: 'parse';
  fileName: string;
  buffer: ArrayBuffer;
}
export type ParseResponse =
  | ({ type: 'done' } & Awaited<ReturnType<typeof parsePointCloud>>)
  | { type: 'progress'; progress: ProgressMsg }
  | { type: 'error'; error: WorkerError };

const ctx = self as unknown as DedicatedWorkerGlobalScope;

ctx.onmessage = (ev: MessageEvent<ParseRequest>) => {
  const req = ev.data;
  if (req.type !== 'parse') return;
  try {
    const raw = parsePointCloud(req.fileName, req.buffer, (loaded, total, message) => {
      const resp: ParseResponse = {
        type: 'progress',
        progress: { stage: 'parse', loaded, total, message },
      };
      ctx.postMessage(resp);
    });
    const resp: ParseResponse = { type: 'done', ...raw };
    ctx.postMessage(resp, [raw.positions.buffer, ...(raw.colors ? [raw.colors.buffer] : []),
      ...(raw.normals ? [raw.normals.buffer] : [])]);
  } catch (e) {
    const err: WorkerError =
      e instanceof ParseFailure
        ? { code: e.code, message: e.message, byteOffset: e.byteOffset }
        : { code: 'UNKNOWN', message: e instanceof Error ? e.message : String(e) };
    const resp: ParseResponse = { type: 'error', error: err };
    ctx.postMessage(resp);
  }
};
