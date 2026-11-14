// 对比页：选择两次扫描 A/B，Worker 计算 A 各点到 B 的最近邻距离，按距离差异上色
import { db } from '../../core/db';
import { OctreeLoader } from '../../core/octreeLoader';
import { PointCloudRenderer } from '../../core/renderer';
import { settingsStore } from '../../core/settings';
import type { CollectionRecord, ProgressMsg, Vec3 } from '../../core/types';
import { h, clear, toast } from '../dom';
import { attachInput } from '../input';
import CompareWorker from '../../workers/compare.worker?worker';
import type { CompareResponse, CompareResult } from '../../workers/compare.worker';

export async function renderComparePage(root: HTMLElement): Promise<void> {
  const collections = (await db.listCollections()).filter((c) => c.status === 'ready');
  if (collections.length < 2) {
    root.appendChild(h('div', { class: 'empty' },
      '对比需要至少两个已就绪的藏品（两次扫描）。请先在藏品列表中导入。'));
    return;
  }

  let renderer: PointCloudRenderer | null = null;
  let loader: OctreeLoader | null = null;
  let detach: (() => void) | null = null;
  let worker: Worker | null = null;

  const layout = h('div', { class: 'viewer-layout' });
  const main = h('div', { class: 'viewer-main' });
  const canvas = h('canvas', { tabindex: '0' }) as HTMLCanvasElement;
  const hud = h('div', { class: 'hud' });
  main.append(canvas, hud);
  const side = h('div', { class: 'viewer-side' });
  layout.append(main, side);
  root.appendChild(layout);

  const selA = h('select', {}, ...collections.map((c) => h('option', { value: c.id, text: c.name }))) as HTMLSelectElement;
  const selB = h('select', {}, ...collections.map((c) => h('option', { value: c.id, text: c.name }))) as HTMLSelectElement;
  selB.value = collections[1]?.id ?? collections[0].id;

  const progressBox = h('div', { style: 'display:none' },
    h('div', { class: 'progress-wrap' }, h('div', { class: 'progress-bar', style: 'width:0%' })),
    h('div', { class: 'progress-text' }));
  const statsHost = h('div');
  const legendHost = h('div');

  side.append(
    h('div', { class: 'side-section' },
      h('h3', {}, '双扫描对比'),
      h('label', { class: 'field' }, 'A（被着色点云）', selA),
      h('label', { class: 'field', style: 'margin-top:8px' }, 'B（参考扫描）', selB),
      h('button', {
        class: 'primary', style: 'margin-top:12px;width:100%', text: '开始对比计算',
        onclick: () => void runCompare(),
      }),
      progressBox),
    h('div', { class: 'side-section' }, h('h3', {}, '差异统计'), statsHost),
    h('div', { class: 'side-section' }, h('h3', {}, '距离图例'), legendHost),
  );

  async function loadCloud(rec: CollectionRecord): Promise<OctreeLoader> {
    const r = new PointCloudRenderer(canvas, settingsStore.get());
    // 复用同一个渲染器：先销毁旧的再建新的
    renderer?.dispose();
    loader?.destroy();
    detach?.();
    renderer = r;
    const l = new OctreeLoader(r.glContext, rec, () => settingsStore.get().vramBudgetMB);
    await l.init();
    r.setLoader(l);
    r.camera.fit(rec.bounds, canvas.clientWidth / Math.max(1, canvas.clientHeight));
    detach = attachInput(canvas, r.camera, {});
    r.start(() => {
      const s = r.getStats();
      const cls = s.fps >= 20 ? '' : 'hud-bad';
      clear(hud);
      hud.append(
        h('div', {}, h('b', {}, rec.name)),
        h('div', {}, '帧率 ', h('b', { class: cls }, String(s.fps)), ' FPS'),
        h('div', {}, '绘制点 ', h('b', {}, s.drawnPoints.toLocaleString()),
          ' / GPU ', h('b', {}, s.gpuMB.toFixed(1)), ' MB'),
      );
    });
    return l;
  }

  /** 收集某藏品全部点（相对其 origin 的 Float32 + origin），逐节点拼接 */
  async function collectAllPoints(rec: CollectionRecord): Promise<{
    positions: Float32Array;
    origin: Vec3;
  }> {
    const tmpLoader = new OctreeLoader(
      renderer!.glContext,
      rec,
      () => settingsStore.get().vramBudgetMB,
    );
    await tmpLoader.init();
    const chunks: Float32Array[] = [];
    let total = 0;
    for await (const chunk of tmpLoader.iterateAllPoints()) {
      chunks.push(chunk.positions);
      total += chunk.positions.length / 3;
    }
    const merged = new Float32Array(total * 3);
    let off = 0;
    for (const c of chunks) {
      merged.set(c, off);
      off += c.length;
    }
    return { positions: merged, origin: rec.origin };
  }

  async function runCompare(): Promise<void> {
    if (selA.value === selB.value) {
      toast('请选择两个不同的扫描藏品', 'warn');
      return;
    }
    const recA = collections.find((c) => c.id === selA.value)!;
    const recB = collections.find((c) => c.id === selB.value)!;
    progressBox.style.display = 'block';
    const bar = progressBox.querySelector('.progress-bar') as HTMLElement;
    const text = progressBox.querySelector('.progress-text') as HTMLElement;
    bar.style.width = '10%';
    text.textContent = '加载点云 A…';

    loader = await loadCloud(recA);
    renderer!.setColorMode('diff');

    const [aData, bData] = await Promise.all([
      collectAllPoints(recA),
      (async () => {
        text.textContent = '加载点云 B…';
        bar.style.width = '30%';
        return collectAllPoints(recB);
      })(),
    ]);

    worker?.terminate();
    worker = new CompareWorker();
    const result = await new Promise<CompareResult>((resolve, reject) => {
      worker!.onmessage = (ev: MessageEvent<CompareResponse>) => {
        const msg = ev.data;
        if (msg.type === 'progress') {
          const p: ProgressMsg = {
            stage: 'compare', loaded: msg.loaded, total: msg.total, message: msg.message,
          };
          bar.style.width = `${30 + Math.round((msg.loaded / Math.max(1, msg.total)) * 65)}%`;
          text.textContent = p.message;
        } else if (msg.type === 'done') {
          resolve(msg);
        } else if (msg.type === 'error') {
          reject(new Error(msg.message));
        }
      };
      worker!.onerror = (e) => reject(e);
      worker!.postMessage(
        {
          type: 'compare',
          positionsA: aData.positions,
          originA: aData.origin,
          positionsB: bData.positions,
          originB: bData.origin,
        },
        [aData.positions.buffer, bData.positions.buffer],
      );
    });

    bar.style.width = '100%';
    text.textContent = `完成：最大距离 ${result.maxDistance.toFixed(5)} m`;
    renderer!.setDiffData(result.distances, Math.max(result.maxDistance, 1e-6));
    renderer!.setColorMode('diff');
    renderStats(result, recA, recB);
    renderLegend(result.maxDistance);
    toast('对比完成，颜色越红表示两扫描偏差越大', 'success', 4500);
  }

  function renderStats(r: CompareResult, a: CollectionRecord, b: CollectionRecord): void {
    clear(statsHost);
    const cell = (k: string, v: string) =>
      h('div', { class: 'stat-cell' }, h('div', { class: 'k' }, k), h('div', { class: 'v' }, v));
    statsHost.append(
      h('div', { class: 'muted', style: 'font-size:12px;margin-bottom:8px' },
        `A: ${a.name} → B: ${b.name}`),
      h('div', { class: 'compare-stats' },
        cell('均值 (m)', r.mean.toFixed(5)),
        cell('RMS (m)', r.rms.toFixed(5)),
        cell('P95 (m)', r.percentile.p95.toFixed(5)),
        cell('最大 (m)', r.maxDistance.toFixed(5)),
        cell('P50 (m)', r.percentile.p50.toFixed(5)),
        cell('P90 (m)', r.percentile.p90.toFixed(5)),
        cell('P99 (m)', r.percentile.p99.toFixed(5)),
        cell('匹配率', `${(r.matchedRatio * 100).toFixed(1)}%`)),
      h('div', { class: 'muted', style: 'font-size:11.5px;margin-top:8px' },
        `网格边长 ${r.cellSize.toFixed(5)} m · 最近邻螺旋搜索`));
  }

  function renderLegend(maxD: number): void {
    clear(legendHost);
    legendHost.append(
      h('div', { class: 'legend' },
        h('div', { style: 'background:rgb(51,191,89)' }),
        h('div', { style: 'background:rgb(150,204,70)' }),
        h('div', { style: 'background:rgb(242,217,64)' }),
        h('div', { style: 'background:rgb(230,140,50)' }),
        h('div', { style: 'background:rgb(230,51,38)' })),
      h('div', { class: 'row', style: 'justify-content:space-between;font-size:11.5px' },
        h('span', { class: 'muted' }, '0'),
        h('span', { class: 'muted' }, `最大 ${maxD.toFixed(4)} m`)),
      h('div', { class: 'muted', style: 'font-size:11.5px;margin-top:6px' },
        '绿色=两扫描一致，红色=偏差最大；未匹配点保留原色'));
  }

  // 初始先载入 A，方便用户旋转检查
  loader = await loadCloud(collections[0]);
}
