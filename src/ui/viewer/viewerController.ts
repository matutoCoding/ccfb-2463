// 查看器控制器：串联渲染器、八叉树加载器、测量/剖切/书签/截图
import { OrbitCamera } from '../../core/camera';
import { db } from '../../core/db';
import {
  buildSectionCsv,
  computeMeasure,
  makeMeasureRecord,
  planeBasis,
  projectToPlane,
  type SectionRow,
} from '../../core/measure';
import { OctreeLoader } from '../../core/octreeLoader';
import { planeSignedDistance, rayPlane, v3, type Plane, type Vec3 } from '../../core/math';
import { PointCloudRenderer, type RenderStats } from '../../core/renderer';
import { settingsStore } from '../../core/settings';
import type {
  Bookmark,
  ClipMode,
  ColorMode,
  CollectionRecord,
  MeasureKind,
  MeasureRecord,
  ViewerSettings,
} from '../../core/types';
import { downloadBlob, uuid } from '../../core/util';

export interface ViewerState {
  colorMode: ColorMode;
  clipMode: ClipMode;
  measureKind: MeasureKind | null;
  pendingPoints: Vec3[];
  confirmedMeasures: MeasureRecord[];
  bookmarks: Bookmark[];
  stats: RenderStats;
  ready: boolean;
  loading: boolean;
}

export class ViewerController {
  renderer: PointCloudRenderer;
  loader: OctreeLoader;
  state: ViewerState;
  private listeners = new Set<() => void>();
  private clipPlane: Plane;
  private clipBox: { min: Vec3; max: Vec3 };
  private sectionTolerance = 0.002;
  private detachInput: () => void;
  private unsubscribeSettings: () => void;

  constructor(
    private canvas: HTMLCanvasElement,
    public collection: CollectionRecord,
    private input: { onPick?: (ndcX: number, ndcY: number) => void },
  ) {
    const settings = settingsStore.get();
    this.renderer = new PointCloudRenderer(canvas, settings);
    this.loader = new OctreeLoader(
      this.renderer.glContext,
      collection,
      () => settingsStore.get().vramBudgetMB,
    );

    const b = collection.bounds;
    this.clipPlane = {
      normal: [0, 0, 1],
      point: [(b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, (b.min[2] + b.max[2]) / 2],
    };
    const c: Vec3 = [
      (b.min[0] + b.max[0]) / 2,
      (b.min[1] + b.max[1]) / 2,
      (b.min[2] + b.max[2]) / 2,
    ];
    const s: Vec3 = [b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]];
    this.clipBox = {
      min: [c[0] - s[0] * 0.25, b.min[1], c[2] - s[2] * 0.25],
      max: [c[0] + s[0] * 0.25, b.max[1], c[2] + s[2] * 0.25],
    };

    this.state = {
      colorMode: collection.hasColors ? 'rgb' : 'elevation',
      clipMode: 'none',
      measureKind: null,
      pendingPoints: [],
      confirmedMeasures: [],
      bookmarks: [],
      stats: { fps: 0, frameMs: 0, drawnPoints: 0, drawnNodes: 0, gpuMB: 0 },
      ready: false,
      loading: true,
    };

    this.unsubscribeSettings = settingsStore.subscribe((s) => this.onSettings(s));
    this.detachInput = () => {};
  }

  get camera(): OrbitCamera {
    return this.renderer.camera;
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private notify(): void {
    this.listeners.forEach((l) => l());
  }

  async init(attachInputFn: (canvas: HTMLCanvasElement, cam: OrbitCamera, h: {
    onPick?: (x: number, y: number) => void;
  }) => () => void): Promise<void> {
    await this.loader.init();
    this.renderer.setLoader(this.loader);
    this.camera.fit(this.collection.bounds, this.canvas.clientWidth / Math.max(1, this.canvas.clientHeight));
    this.renderer.setColorMode(this.state.colorMode);
    this.applyClip();

    this.detachInput = attachInputFn(this.canvas, this.camera, {
      onPick: (x, y) => this.handlePick(x, y),
    });

    this.state.bookmarks = await db.listBookmarks(this.collection.id);
    this.state.confirmedMeasures = await db.listMeasures(this.collection.id);
    this.state.ready = true;
    this.state.loading = false;
    this.renderer.start(() => {
      this.state.stats = this.renderer.getStats();
      this.adaptiveQuality();
      this.notify();
    });
    this.notify();
  }

  private onSettings(s: ViewerSettings): void {
    this.renderer.setSettings(s);
    this.notify();
  }

  // ---------- 配色 ----------
  setColorMode(m: ColorMode): void {
    this.state.colorMode = m;
    this.renderer.setColorMode(m);
    this.notify();
  }

  // ---------- 剖切 ----------
  setClipMode(mode: ClipMode): void {
    this.state.clipMode = mode;
    this.applyClip();
    this.notify();
  }

  getClipPlane(): Plane {
    return { normal: [...this.clipPlane.normal] as Vec3, point: [...this.clipPlane.point] as Vec3 };
  }

  getClipBox() {
    return {
      min: [...this.clipBox.min] as Vec3,
      max: [...this.clipBox.max] as Vec3,
    };
  }

  updateClipPlane(patch: Partial<Plane>): void {
    if (patch.normal) this.clipPlane.normal = v3.norm(patch.normal);
    if (patch.point) this.clipPlane.point = patch.point;
    this.applyClip();
    this.notify();
  }

  updateClipBox(min: Vec3, max: Vec3): void {
    this.clipBox = { min, max };
    this.applyClip();
    this.notify();
  }

  private applyClip(): void {
    this.renderer.setClip(
      this.state.clipMode,
      this.clipPlane,
      this.state.clipMode === 'box' ? this.clipBox : undefined,
    );
    this.refreshOverlays();
  }

  setSectionTolerance(t: number): void {
    this.sectionTolerance = t;
  }

  /** 剖面线导出：遍历所有节点，保留容差带内的点，投影到平面 2D 坐标 */
  async exportSectionCsv(): Promise<void> {
    if (this.state.clipMode !== 'plane') {
      throw new Error('请先启用剖切面再导出剖面线');
    }
    const plane = this.clipPlane;
    const { u, v } = planeBasis(plane);
    const rows: SectionRow[] = [];
    let index = 0;
    for await (const chunk of this.loader.iterateAllPoints()) {
      const { positions, origin } = chunk;
      for (let i = 0; i < positions.length; i += 3) {
        const p: Vec3 = [
          positions[i] + origin[0],
          positions[i + 1] + origin[1],
          positions[i + 2] + origin[2],
        ];
        const d = planeSignedDistance(plane, p);
        if (Math.abs(d) <= this.sectionTolerance) {
          const q = projectToPlane(p, plane);
          const rel = v3.sub(q, plane.point);
          rows.push({
            index: index++,
            x: p[0], y: p[1], z: p[2],
            u: v3.dot(rel, u),
            v: v3.dot(rel, v),
            signedDistance: d,
          });
        }
      }
    }
    if (rows.length === 0) throw new Error('容差带内没有点，可调大剖面容差或移动剖切面');
    const csv = buildSectionCsv(rows, plane);
    downloadBlob(
      new Blob([csv], { type: 'text/csv;charset=utf-8' }),
      `section_${this.collection.name}_${Date.now()}.csv`,
    );
  }

  // ---------- 测量 ----------
  startMeasure(kind: MeasureKind): void {
    this.state.measureKind = kind;
    this.state.pendingPoints = [];
    this.notify();
  }

  cancelMeasure(): void {
    this.state.measureKind = null;
    this.state.pendingPoints = [];
    this.refreshOverlays();
    this.notify();
  }

  private async handlePick(ndcX: number, ndcY: number): Promise<void> {
    const linearId = this.renderer.pick(ndcX, ndcY);
    if (linearId < 0) return;
    const p = await this.loader.resolvePoint(linearId);
    if (!p) return;

    if (this.state.measureKind) {
      this.state.pendingPoints.push(p);
      const need = this.state.measureKind === 'distance' ? 2 : 3;
      if (this.state.pendingPoints.length >= need) {
        const rec = makeMeasureRecord(
          this.collection.id,
          this.state.measureKind,
          this.state.pendingPoints,
        );
        await db.putMeasure(rec);
        this.state.confirmedMeasures = await db.listMeasures(this.collection.id);
        this.state.measureKind = null;
        this.state.pendingPoints = [];
      }
      this.refreshOverlays();
      this.notify();
      return;
    }
    // 非测量模式：临时显示该点坐标
    this.state.pendingPoints = [p];
    this.refreshOverlays();
    this.notify();
    setTimeout(() => {
      if (!this.state.measureKind && this.state.pendingPoints.length === 1) {
        this.state.pendingPoints = [];
        this.refreshOverlays();
        this.notify();
      }
    }, 2500);
  }

  /** 测量模式下也允许在剖切面上用射线交点选点（点云稀疏处兜底） */
  pickOnPlane(ndcX: number, ndcY: number): Vec3 | null {
    if (this.state.clipMode !== 'plane') return null;
    const ray = this.camera.screenRay(ndcX, ndcY);
    return rayPlane(ray.origin, ray.dir, this.clipPlane);
  }

  currentPreviewResult(): number | null {
    const kind = this.state.measureKind;
    if (!kind || this.state.pendingPoints.length < 2) return null;
    return computeMeasure(kind, this.state.pendingPoints);
  }

  async deleteMeasure(id: string): Promise<void> {
    await db.deleteMeasure(id);
    this.state.confirmedMeasures = await db.listMeasures(this.collection.id);
    this.refreshOverlays();
    this.notify();
  }

  async updateMeasureNote(id: string, note: string): Promise<void> {
    const rec = this.state.confirmedMeasures.find((m) => m.id === id);
    if (!rec) return;
    await db.putMeasure({ ...rec, note });
    this.state.confirmedMeasures = await db.listMeasures(this.collection.id);
    this.notify();
  }

  // ---------- 书签 ----------
  async addBookmark(name: string): Promise<Bookmark> {
    const rec: Bookmark = {
      id: uuid(),
      collectionId: this.collection.id,
      name,
      ...this.camera.getPose(),
      createdAt: Date.now(),
    };
    await db.putBookmark(rec);
    this.state.bookmarks = await db.listBookmarks(this.collection.id);
    this.notify();
    return rec;
  }

  gotoBookmark(b: Bookmark): void {
    this.camera.setPose({ target: b.target, distance: b.distance, yaw: b.yaw, pitch: b.pitch });
  }

  async deleteBookmark(id: string): Promise<void> {
    await db.deleteBookmark(id);
    this.state.bookmarks = await db.listBookmarks(this.collection.id);
    this.notify();
  }

  // ---------- 截图 ----------
  async capture(scale: number): Promise<void> {
    const blob = await this.renderer.captureHighRes(scale);
    downloadBlob(blob, `${this.collection.name}_${scale}x_${Date.now()}.png`);
  }

  // ---------- 覆盖物 ----------
  private refreshOverlays(): void {
    const lines: { points: Vec3[]; color: [number, number, number, number] }[] = [];
    const yellow: [number, number, number, number] = [1, 0.82, 0.25, 1];
    const cyan: [number, number, number, number] = [0.35, 0.85, 1, 1];
    // 进行中的测量
    if (this.state.pendingPoints.length > 0) {
      lines.push({ points: this.state.pendingPoints, color: yellow });
    }
    // 已确认测量
    for (const m of this.state.confirmedMeasures) {
      lines.push({ points: m.points, color: cyan });
      if (m.kind === 'angle' && m.points.length === 3) {
        lines.push({ points: [m.points[0], m.points[1], m.points[2]], color: cyan });
      }
    }
    // 剖切盒线框
    if (this.state.clipMode === 'box') {
      const { min, max } = this.clipBox;
      const p = (x: number, y: number, z: number): Vec3 => [
        min[0] + x * (max[0] - min[0]),
        min[1] + y * (max[1] - min[1]),
        min[2] + z * (max[2] - min[2]),
      ];
      const corners: Vec3[] = [
        p(0, 0, 0), p(1, 0, 0), p(1, 1, 0), p(0, 1, 0),
        p(0, 0, 1), p(1, 0, 1), p(1, 1, 1), p(0, 1, 1),
      ];
      const edges: [number, number][] = [
        [0, 1], [1, 2], [2, 3], [3, 0],
        [4, 5], [5, 6], [6, 7], [7, 4],
        [0, 4], [1, 5], [2, 6], [3, 7],
      ];
      for (const [a, b] of edges) lines.push({ points: [corners[a], corners[b]], color: yellow });
    }
    this.renderer.setOverlays(lines);
  }

  // ---------- 自适应质量 ----------
  private adaptiveQuality(): void {
    const s = settingsStore.get();
    if (!s.adaptiveQuality || this.state.stats.fps === 0) return;
    // 仅在持续低帧时调整，每 60 帧评估一次（用 frameMs 抖动近似）
    if (Math.random() > 0.016) return;
    if (this.state.stats.fps < 20) {
      const next = {
        pointSize: Math.max(1, s.pointSize - 0.25),
        lodPixelError: Math.min(8, s.lodPixelError + 0.5),
      };
      void settingsStore.update(next);
    }
  }

  dispose(): void {
    this.detachInput();
    this.unsubscribeSettings();
    this.renderer.dispose();
    this.loader.destroy();
  }
}
