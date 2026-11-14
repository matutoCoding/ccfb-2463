// 测量与剖切的几何计算
import { planeSignedDistance, v3, type Plane, type Vec3 } from './math';
import type { MeasureKind, MeasureRecord } from './types';
import { uuid } from './util';

export function computeMeasure(kind: MeasureKind, points: Vec3[]): number {
  switch (kind) {
    case 'distance': {
      if (points.length < 2) return 0;
      return v3.dist(points[0], points[1]);
    }
    case 'area': {
      if (points.length < 3) return 0;
      // 三角形面积（海伦公式的向量叉积版，数值更稳）
      const ab = v3.sub(points[1], points[0]);
      const ac = v3.sub(points[2], points[0]);
      return v3.len(v3.cross(ab, ac)) / 2;
    }
    case 'angle': {
      if (points.length < 3) return 0;
      // points[1] 是顶点
      const a = v3.norm(v3.sub(points[0], points[1]));
      const b = v3.norm(v3.sub(points[2], points[1]));
      const cos = Math.max(-1, Math.min(1, v3.dot(a, b)));
      return (Math.acos(cos) * 180) / Math.PI;
    }
  }
}

export function makeMeasureRecord(
  collectionId: string,
  kind: MeasureKind,
  points: Vec3[],
  note = '',
): MeasureRecord {
  return {
    id: uuid(),
    collectionId,
    kind,
    points: points.map((p) => [p[0], p[1], p[2]] as Vec3),
    result: computeMeasure(kind, points),
    note,
    createdAt: Date.now(),
  };
}

export function unitOf(kind: MeasureKind): string {
  return kind === 'distance' ? 'm' : kind === 'area' ? 'm²' : '°';
}

export function formatMeasure(m: MeasureRecord): string {
  const digits = m.kind === 'angle' ? 2 : 5;
  return `${m.result.toFixed(digits)} ${unitOf(m.kind)}`;
}

/** 点到平面的投影（剖面线上 2D 坐标用） */
export function projectToPlane(p: Vec3, plane: Plane): Vec3 {
  const d = planeSignedDistance(plane, p);
  return v3.sub(p, v3.scale(plane.normal, d));
}

/** 在平面内构造正交基 u/v，用于把三维剖面点展开成二维 */
export function planeBasis(plane: Plane): { u: Vec3; v: Vec3 } {
  const n = plane.normal;
  const ref: Vec3 = Math.abs(n[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
  const u = v3.norm(v3.cross(ref, n));
  const v = v3.norm(v3.cross(n, u));
  return { u, v };
}

export interface SectionRow {
  index: number;
  x: number;
  y: number;
  z: number;
  u: number;
  v: number;
  signedDistance: number;
}

/** 提取剖切面 ±tolerance 内的点，生成 CSV（含 2D 剖面坐标） */
export function buildSectionCsv(
  rows: SectionRow[],
  plane: Plane,
): string {
  const header = [
    'index', 'x_m', 'y_m', 'z_m',
    'section_u_m', 'section_v_m', 'signed_distance_m',
    'plane_nx', 'plane_ny', 'plane_nz',
  ].join(',');
  const lines = [header];
  const n = plane.normal;
  for (const r of rows) {
    lines.push(
      [
        r.index,
        r.x.toFixed(6), r.y.toFixed(6), r.z.toFixed(6),
        r.u.toFixed(6), r.v.toFixed(6), r.signedDistance.toFixed(6),
        n[0].toFixed(6), n[1].toFixed(6), n[2].toFixed(6),
      ].join(','),
    );
  }
  // 加 UTF-8 BOM，Excel 直接打开中文不乱码
  return '﻿' + lines.join('\n') + '\n';
}
