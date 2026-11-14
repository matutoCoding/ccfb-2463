// 设置页：显存预算、点大小、EDL、LOD、背景、自适应质量
import { settingsStore } from '../../core/settings';
import { h, toast } from '../dom';

export function renderSettingsPage(root: HTMLElement): void {
  const s = settingsStore.get();

  root.appendChild(h('h1', { class: 'page-title' }, '设置'));

  const card = h('div', { class: 'card', style: 'max-width:720px' });

  const slider = (
    label: string,
    key: keyof typeof s,
    min: number,
    max: number,
    step: number,
    unit: string,
  ): HTMLElement => {
    const input = h('input', {
      type: 'range', min: String(min), max: String(max), step: String(step), value: String(s[key]),
    }) as HTMLInputElement;
    const val = h('span', { class: 'val' }, `${s[key]} ${unit}`);
    input.addEventListener('input', () => {
      val.textContent = `${input.value} ${unit}`;
    });
    input.addEventListener('change', () => {
      void settingsStore.update({ [key]: Number(input.value) } as never);
      toast('设置已保存', 'success', 1500);
    });
    return h('div', { class: 'slider-row' }, h('label', {}, label), input, val);
  };

  // 显存预算用数字输入 + 常用档位
  const vramInput = h('input', {
    type: 'number', min: '128', max: '16384', step: '64', value: String(s.vramBudgetMB),
  }) as HTMLInputElement;
  vramInput.addEventListener('change', () => {
    const v = Math.max(128, Number(vramInput.value) || 1024);
    void settingsStore.update({ vramBudgetMB: v });
    vramInput.value = String(v);
    toast('显存预算已更新，超出部分将按 LRU 驱逐节点', 'success', 2200);
  });

  const bgInputs = s.background.map((c, i) => {
    const input = h('input', {
      type: 'number', min: '0', max: '1', step: '0.01', value: String(c),
    }) as HTMLInputElement;
    input.addEventListener('change', () => {
      const cur = settingsStore.get().background;
      const next = [...cur] as [number, number, number];
      next[i] = Math.max(0, Math.min(1, Number(input.value) || 0));
      void settingsStore.update({ background: next });
    });
    return input;
  });

  const adaptive = h('input', { type: 'checkbox' }) as HTMLInputElement;
  adaptive.checked = s.adaptiveQuality;
  adaptive.addEventListener('change', () =>
    void settingsStore.update({ adaptiveQuality: adaptive.checked }));

  const fpsInput = h('input', {
    type: 'number', min: '20', max: '120', step: '5', value: String(s.fpsTarget),
  }) as HTMLInputElement;
  fpsInput.addEventListener('change', () =>
    void settingsStore.update({ fpsTarget: Math.max(20, Number(fpsInput.value) || 30) }));

  card.append(
    h('h2', {}, '性能与显存'),
    h('label', { class: 'field', style: 'max-width:260px' }, '显存预算 (MB) — 超出后 LRU 驱逐八叉树节点', vramInput),
    slider('点大小 (px)', 'pointSize', 1, 8, 0.25, 'px'),
    slider('LOD 像素误差', 'lodPixelError', 1, 8, 0.25, 'px'),
    h('div', { class: 'muted', style: 'font-size:12px;margin:-4px 0 10px 94px' },
      '值越小越精细，加载的节点越多；值越大帧率越稳'),

    h('h2', {}, 'EDL 描边（Eye-Dome Lighting）'),
    slider('EDL 强度', 'edlStrength', 0, 5, 0.1, ''),
    slider('EDL 半径', 'edlRadius', 0.5, 6, 0.1, 'px'),

    h('h2', {}, '显示'),
    h('div', { class: 'row' }, h('label', { style: 'width:90px;color:var(--fg-dim);font-size:12.5px' }, '背景色 RGB'),
      ...bgInputs),

    h('h2', {}, '自适应质量'),
    h('div', { class: 'row' },
      adaptive,
      h('label', { style: 'font-size:13px' }, '帧率低于目标时自动降低点大小、放宽 LOD 误差，保证不跌破 20 FPS')),
    h('label', { class: 'field', style: 'max-width:200px;margin-top:10px' }, '目标帧率 (FPS)', fpsInput),
  );

  root.append(card,
    h('div', { class: 'card', style: 'max-width:720px' },
      h('h2', {}, '存储说明'),
      h('p', { class: 'dim', style: 'font-size:13px' },
        '藏品的八叉树节点与测量/书签数据保存在浏览器 IndexedDB 中，关闭页面后仍保留。',
        '清理浏览器站点数据会一并删除；也可在藏品列表中逐个删除。'),
      h('p', { class: 'dim', style: 'font-size:13px' },
        '所有解析与八叉树构建均在 Web Worker 中完成，导入期间界面保持可交互。')));
}
