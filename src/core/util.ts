// 通用小工具
import type { Bounds, Vec3 } from './types';

export function uuid(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID();
  }
  return 'id-' + Math.random().toString(36).slice(2) + Date.now().toString(36);
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(2)} ${units[i]}`;
}

export function formatNumber(n: number, digits = 4): string {
  if (!Number.isFinite(n)) return '—';
  if (Math.abs(n) >= 10000) return n.toFixed(0);
  return n.toFixed(digits);
}

export function formatDate(ts: number): string {
  const d = new Date(ts);
  const pad = (x: number) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function boundsToStr(b: Bounds): string {
  const f = (v: Vec3) => v.map((x) => x.toFixed(3)).join(', ');
  return `min(${f(b.min)})  max(${f(b.max)})`;
}

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

/** 简单事件发射器 */
export class Emitter<T extends Record<string, unknown>> {
  private map = new Map<keyof T, Set<(payload: T[keyof T]) => void>>();

  on<K extends keyof T>(event: K, fn: (payload: T[K]) => void): () => void {
    let set = this.map.get(event);
    if (!set) {
      set = new Set();
      this.map.set(event, set);
    }
    set.add(fn as (payload: T[keyof T]) => void);
    return () => set!.delete(fn as (payload: T[keyof T]) => void);
  }

  emit<K extends keyof T>(event: K, payload: T[K]): void {
    this.map.get(event)?.forEach((fn) => fn(payload));
  }
}
