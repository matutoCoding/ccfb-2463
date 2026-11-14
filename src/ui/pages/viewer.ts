// 查看器页面：3D 画布 + 侧边工具面板（配色/剖切/测量/书签/截图）
import { db } from '../../core/db';
import { formatMeasure, unitOf } from '../../core/measure';
import type { ClipMode, ColorMode, CollectionRecord, MeasureKind } from '../../core/types';
import { h, clear, toast, confirmDialog } from '../dom';
import { go } from '../router';
import { attachInput } from '../input';
import { ViewerController } from '../viewer/viewerController';

export async function renderViewerPage(root: HTMLElement, id: string): Promise<void> {
  const collection = await db.getCollection(id);
  if (!collection || collection.status !== 'ready') {
    root.appendChild(h('div', { class: 'empty' },
      '藏品不存在或尚未就绪。',
      h('div', { style: 'margin-top:12px' },
        h('button', { class: 'primary', text: '返回藏品列表', onclick: () => go('#/collections') }))));
    return;
  }

  const layout = h('div', { class: 'viewer-layout' });
  const main = h('div', { class: 'viewer-main' });
  const canvas = h('canvas', { tabindex: '0' }) as HTMLCanvasElement;
  const hud = h('div', { class: 'hud' });
  main.append(canvas, hud);
  const side = h('div', { class: 'viewer-side' });
  layout.append(main, side);
  root.appendChild(layout);

  let ctrl: ViewerController;
  try {
    ctrl = new ViewerController(canvas, collection, {});
  } catch (e) {
    main.replaceChildren(h('div', { class: 'empty' },
      `渲染器初始化失败：${e instanceof Error ? e.message : String(e)}`));
    return;
  }

  // ---------- 配色 ----------
  const colorModes: { key: ColorMode; label: string }[] = [
    { key: 'rgb', label: '真彩' },
    { key: 'elevation', label: '高程' },
    { key: 'normal', label: '法线' },
    { key: 'diff', label: '差异' },
  ];
  const colorSection = h('div', { class: 'side-section' },
    h('h3', {}, '颜色模式', h('span', { class: 'tag' }, 'EDL 描边已启用')));
  const colorSeg = h('div', { class: 'seg' });
  for (const m of colorModes) {
    if (m.key === 'diff') continue; // 差异模式在对比页开启
    if (m.key === 'rgb' && !collection.hasColors) continue;
    if (m.key === 'normal' && !collection.hasNormals) continue;
    colorSeg.appendChild(h('button', {
      text: m.label,
      onclick: () => {
        ctrl.setColorMode(m.key);
        syncColor();
      },
    }));
  }
  function syncColor(): void {
    Array.from(colorSeg.children).forEach((b) => {
      (b as HTMLElement).classList.toggle(
        'on',
        (b as HTMLButtonElement).textContent ===
        colorModes.find((m) => m.key === ctrl.state.colorMode)?.label,
      );
    });
  }
  colorSection.appendChild(colorSeg);

  // ---------- 剖切 ----------
  const clipSection = h('div', { class: 'side-section' }, h('h3', {}, '剖切'));
  const clipSeg = h('div', { class: 'seg' },
    ...([['none', '关闭'], ['plane', '剖切面'], ['box', '剖切盒']] as [ClipMode, string][]).map(
      ([key, label]) => h('button', {
        text: label,
        onclick: () => {
          ctrl.setClipMode(key);
          syncClip();
        },
      }),
    ));
  clipSection.appendChild(clipSeg);

  const planePanel = h('div', { style: 'margin-top:10px;display:none' });
  const axisSelect = h('select', {},
    h('option', { value: 'x', text: '法向 +X' }),
    h('option', { value: 'y', text: '法向 +Y' }),
    h('option', { value: 'z', text: '法向 +Z' }),
  ) as HTMLSelectElement;
  axisSelect.value = 'z';
  const planePos = h('input', { type: 'range', min: '0', max: '1', step: '0.001', value: '0.5' }) as HTMLInputElement;
  const tolInput = h('input', { type: 'number', value: '0.002', step: '0.0005', min: '0' }) as HTMLInputElement;
  const updatePlane = (): void => {
    const b = collection.bounds;
    const axis = axisSelect.value as 'x' | 'y' | 'z';
    const t = Number(planePos.value);
    const normal: [number, number, number] =
      axis === 'x' ? [1, 0, 0] : axis === 'y' ? [0, 1, 0] : [0, 0, 1];
    const point: [number, number, number] = [
      b.min[0] + (b.max[0] - b.min[0]) * (axis === 'x' ? t : 0.5),
      b.min[1] + (b.max[1] - b.min[1]) * (axis === 'y' ? t : 0.5),
      b.min[2] + (b.max[2] - b.min[2]) * (axis === 'z' ? t : 0.5),
    ];
    ctrl.updateClipPlane({ normal, point });
  };
  axisSelect.addEventListener('change', updatePlane);
  planePos.addEventListener('input', updatePlane);
  tolInput.addEventListener('change', () => ctrl.setSectionTolerance(Number(tolInput.value)));
  planePanel.append(
    h('label', { class: 'field' }, '剖切方向', axisSelect),
    h('label', { class: 'field', style: 'margin-top:8px' }, '位置（沿轴比例）', planePos),
    h('label', { class: 'field', style: 'margin-top:8px' }, '剖面容差 (m)', tolInput),
    h('button', {
      class: 'small',
      style: 'margin-top:10px;width:100%',
      text: '导出剖面线 CSV',
      onclick: async () => {
        try {
          await ctrl.exportSectionCsv();
          toast('剖面线 CSV 已导出', 'success');
        } catch (e) {
          toast(e instanceof Error ? e.message : String(e), 'error');
        }
      },
    }),
  );
  clipSection.appendChild(planePanel);

  const boxPanel = h('div', { style: 'margin-top:10px;display:none' });
  const boxSliders: HTMLInputElement[] = [];
  for (const axis of ['X', 'Y', 'Z'] as const) {
    const lo = h('input', { type: 'range', min: '0', max: '1', step: '0.01', value: '0.25' }) as HTMLInputElement;
    const hi = h('input', { type: 'range', min: '0', max: '1', step: '0.01', value: '0.75' }) as HTMLInputElement;
    boxSliders.push(lo, hi);
    boxPanel.append(
      h('div', { class: 'slider-row' }, h('label', {}, `${axis} 起`), lo, h('span', { class: 'val' }, lo.value)),
      h('div', { class: 'slider-row' }, h('label', {}, `${axis} 止`), hi, h('span', { class: 'val' }, hi.value)),
    );
    const sync = () => {
      (lo.nextElementSibling as HTMLElement).textContent = lo.value;
      (hi.nextElementSibling as HTMLElement).textContent = hi.value;
      const b = collection.bounds;
      ctrl.updateClipBox(
        [
          b.min[0] + (b.max[0] - b.min[0]) * Number(boxSliders[0].value),
          b.min[1] + (b.max[1] - b.min[1]) * Number(boxSliders[2].value),
          b.min[2] + (b.max[2] - b.min[2]) * Number(boxSliders[4].value),
        ],
        [
          b.min[0] + (b.max[0] - b.min[0]) * Number(boxSliders[1].value),
          b.min[1] + (b.max[1] - b.min[1]) * Number(boxSliders[3].value),
          b.min[2] + (b.max[2] - b.min[2]) * Number(boxSliders[5].value),
        ],
      );
    };
    lo.addEventListener('input', sync);
    hi.addEventListener('input', sync);
  }
  clipSection.appendChild(boxPanel);

  function syncClip(): void {
    const mode = ctrl.state.clipMode;
    Array.from(clipSeg.children).forEach((b, i) => {
      (b as HTMLElement).classList.toggle('on',
        (['none', 'plane', 'box'] as ClipMode[])[i] === mode);
    });
    planePanel.style.display = mode === 'plane' ? 'block' : 'none';
    boxPanel.style.display = mode === 'box' ? 'block' : 'none';
  }

  // ---------- 测量 ----------
  const measureSection = h('div', { class: 'side-section' }, h('h3', {}, '测量'));
  const measureSeg = h('div', { class: 'seg' },
    ...([['distance', '距离'], ['area', '面积'], ['angle', '角度']] as [MeasureKind, string][]).map(
      ([kind, label]) => h('button', {
        text: label,
        onclick: () => {
          ctrl.startMeasure(kind);
          syncMeasure();
          toast(`在点云上依次点选${kind === 'distance' ? ' 2' : ' 3'}个点`, 'info', 2500);
        },
      }),
    ));
  const measureHint = h('div', { class: 'muted', style: 'font-size:12px;margin-top:8px' });
  const preview = h('div', { class: 'result-box', style: 'display:none' });
  const pickList = h('div', { class: 'pick-list' });
  const cancelBtn = h('button', {
    class: 'small', style: 'width:100%;margin-top:8px;display:none', text: '取消本次测量',
    onclick: () => { ctrl.cancelMeasure(); syncMeasure(); },
  });
  const recordsHost = h('div', { style: 'margin-top:10px;display:flex;flex-direction:column;gap:6px' });
  measureSection.append(measureSeg, measureHint, pickList, preview, cancelBtn,
    h('h3', { style: 'margin-top:14px' }, '本藏品测量记录'), recordsHost);

  const KIND_LABEL: Record<MeasureKind, string> = {
    distance: '距离', area: '面积', angle: '角度',
  };
  const KIND_HINT: Record<MeasureKind, string> = {
    distance: '距离（选 2 点）',
    area: '面积（选 3 点）',
    angle: '角度（顶点在中间，选 3 点）',
  };

  function syncMeasure(): void {
    const kind = ctrl.state.measureKind;
    Array.from(measureSeg.children).forEach((b) =>
      (b as HTMLElement).classList.toggle('on',
        kind !== null && (b as HTMLButtonElement).textContent === KIND_LABEL[kind]));
    measureHint.textContent = kind
      ? `进行中：${KIND_HINT[kind]}`
      : '选择工具后在点云上点选';
    cancelBtn.style.display = kind ? 'block' : 'none';
    clear(pickList);
    for (const p of ctrl.state.pendingPoints) {
      pickList.appendChild(h('div', { class: 'pick-item' },
        p.map((x: number) => x.toFixed(4)).join(', ')));
    }
    const r = ctrl.currentPreviewResult();
    if (r !== null && kind) {
      preview.style.display = 'block';
      clear(preview);
      preview.appendChild(h('div', {},
        h('span', { class: 'big' }, r.toFixed(5)),
        h('span', { class: 'unit' }, ` ${unitOf(kind)}`)));
    } else {
      preview.style.display = 'none';
    }
    clear(recordsHost);
    for (const m of ctrl.state.confirmedMeasures) {
      recordsHost.appendChild(h('div', {
        style: 'background:var(--bg);border:1px solid var(--border);border-radius:6px;padding:8px;font-size:12px',
      },
        h('div', { class: 'row' },
          h('span', { class: 'badge info' }, KIND_LABEL[m.kind]),
          h('span', { class: 'mono' }, formatMeasure(m)),
          h('span', { class: 'spacer' }),
          h('button', {
            class: 'small danger', text: '删',
            onclick: async () => {
              if (await confirmDialog('删除这条测量记录？')) void ctrl.deleteMeasure(m.id);
            },
          })),
        h('div', { class: 'muted', style: 'margin-top:4px' }, m.note || '无备注'),
        h('button', {
          class: 'small', style: 'margin-top:6px', text: m.note ? '编辑备注' : '添加备注',
          onclick: async () => {
            const note = prompt('测量备注', m.note);
            if (note !== null) await ctrl.updateMeasureNote(m.id, note);
          },
        })));
    }
  }

  // ---------- 书签 ----------
  const bookmarkSection = h('div', { class: 'side-section' }, h('h3', {}, '视角书签'));
  const bookmarkList = h('div', { style: 'display:flex;flex-direction:column;gap:6px' });
  bookmarkSection.append(
    h('button', {
      class: 'small', style: 'width:100%', text: '保存当前视角',
      onclick: async () => {
        const name = prompt('书签名称', `视角 ${ctrl.state.bookmarks.length + 1}`);
        if (name) {
          await ctrl.addBookmark(name);
          toast('书签已保存', 'success');
        }
      },
    }),
    bookmarkList,
  );
  const syncBookmarks = (): void => {
    clear(bookmarkList);
    if (ctrl.state.bookmarks.length === 0) {
      bookmarkList.appendChild(h('div', { class: 'muted', style: 'font-size:12px;margin-top:8px' }, '暂无书签'));
      return;
    }
    for (const b of ctrl.state.bookmarks) {
      bookmarkList.appendChild(h('div', { class: 'row', style: 'margin-top:6px' },
        h('button', {
          class: 'small', style: 'flex:1;text-align:left', text: b.name,
          onclick: () => ctrl.gotoBookmark(b),
        }),
        h('button', {
          class: 'small danger', text: '×',
          onclick: async () => {
            if (await confirmDialog(`删除书签「${b.name}」？`)) void ctrl.deleteBookmark(b.id);
          },
        })));
    }
  };

  // ---------- 截图 ----------
  const shotSection = h('div', { class: 'side-section' },
    h('h3', {}, '高分辨率截图'),
    h('div', { class: 'row' },
      ...[1, 2, 3].map((s) => h('button', {
        class: 'small', text: `${s}×`,
        onclick: async () => {
          try {
            await ctrl.capture(s);
            toast(`${s} 倍分辨率截图已下载`, 'success');
          } catch (e) {
            toast(e instanceof Error ? e.message : String(e), 'error');
          }
        },
      }))),
    h('div', { class: 'muted', style: 'font-size:11.5px;margin-top:6px' },
      '按当前画布尺寸的倍数渲染 PNG'));

  side.append(colorSection, clipSection, measureSection, bookmarkSection, shotSection);

  // 状态订阅
  ctrl.subscribe(() => {
    syncColor();
    syncClip();
    syncMeasure();
    syncBookmarks();
    const s = ctrl.state.stats;
    const fpsClass = s.fps >= 30 ? '' : s.fps >= 20 ? 'hud-warn' : 'hud-bad';
    clear(hud);
    hud.append(
      h('div', {}, h('b', {}, collection.name)),
      h('div', {}, '帧率 ', h('b', { class: fpsClass }, String(s.fps)), ' FPS',
        h('span', { class: 'muted' }, `（${s.frameMs} ms/帧）`)),
      h('div', {}, '绘制点 ', h('b', {}, s.drawnPoints.toLocaleString()),
        ' / 节点 ', h('b', {}, String(s.drawnNodes))),
      h('div', {}, 'GPU 占用 ', h('b', {}, s.gpuMB.toFixed(1)), ' MB'),
      h('div', { class: 'muted' }, '左键旋转 · 右键平移 · 滚轮缩放'),
    );
  });

  await ctrl.init(attachInput);
  syncColor();
  syncClip();
  syncMeasure();
  syncBookmarks();

  // 页面离开时释放 GL 资源
  const onHash = (): void => {
    if (!root.isConnected) {
      ctrl.dispose();
      window.removeEventListener('hashchange', onHash);
    }
  };
  window.addEventListener('hashchange', onHash);
}
