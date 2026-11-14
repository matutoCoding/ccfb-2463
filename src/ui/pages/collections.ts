// 藏品列表页：导入 PLY/XYZ、进度展示、坏文件可见、删除级联清理
import { db } from '../../core/db';
import { importFile } from '../../core/importPipeline';
import type { CollectionRecord, ProgressMsg } from '../../core/types';
import { formatBytes, formatDate } from '../../core/util';
import { h, clear, toast, confirmDialog } from '../dom';
import { go } from '../router';

interface ImportState {
  id: string;
  name: string;
  progress: ProgressMsg | null;
  status: 'running' | 'error' | 'done';
  message: string;
}

const imports = new Map<string, ImportState>();

export async function renderCollectionsPage(root: HTMLElement): Promise<void> {
  const collections = await db.listCollections();
  collections.sort((a, b) => b.createdAt - a.createdAt);

  const dropZone = h('div', {
    class: 'card drop-zone',
    style: 'border-style:dashed;text-align:center;padding:34px;cursor:pointer',
  });
  const fileInput = h('input', {
    type: 'file',
    accept: '.ply,.xyz,.txt,.asc',
    multiple: true,
    style: 'display:none',
  }) as HTMLInputElement;

  const renderZone = (): void => {
    clear(dropZone);
    const active = Array.from(imports.values()).filter((s) => s.status === 'running');
    dropZone.append(
      h('div', { style: 'font-size:15px;margin-bottom:6px' },
        '点击选择或拖拽 PLY / XYZ 文件到此处（可多选，Worker 后台解析，不卡界面）'),
      h('div', { class: 'muted', style: 'font-size:12.5px' },
        '支持 ASCII 与二进制（大小端）PLY；坏文件会标记错误并保留记录'),
      ...active.map((s) => {
        const pct = s.progress ? Math.round((s.progress.loaded / Math.max(1, s.progress.total)) * 100) : 0;
        return h('div', { style: 'margin-top:14px;text-align:left' },
          h('div', { class: 'row' },
            h('strong', { style: 'font-size:12.5px' }, s.name),
            h('span', { class: 'muted', style: 'font-size:12px' }, s.message)),
          h('div', { class: 'progress-wrap', style: 'margin-top:6px' },
            h('div', { class: 'progress-bar', style: `width:${pct}%` })),
          h('div', { class: 'progress-text' },
            s.progress ? `${s.progress.message}（${pct}%）` : '等待开始…'));
      }),
    );
  };

  dropZone.addEventListener('click', () => fileInput.click());
  dropZone.addEventListener('dragover', (e) => {
    e.preventDefault();
    dropZone.classList.add('dragover');
  });
  dropZone.addEventListener('dragleave', () => dropZone.classList.remove('dragover'));
  dropZone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropZone.classList.remove('dragover');
    const files = Array.from((e as DragEvent).dataTransfer?.files ?? []);
    void handleFiles(files);
  });
  fileInput.addEventListener('change', () => {
    void handleFiles(Array.from(fileInput.files ?? []));
    fileInput.value = '';
  });

  const listHost = h('div', { class: 'grid-cards' });

  const renderList = async (): Promise<void> => {
    const recs = await db.listCollections();
    recs.sort((a, b) => b.createdAt - a.createdAt);
    clear(listHost);
    if (recs.length === 0) {
      listHost.appendChild(h('div', { class: 'empty', style: 'grid-column:1/-1' },
        '还没有藏品。先导入一个 PLY 或 XYZ 点云文件。'));
      return;
    }
    for (const rec of recs) {
      listHost.appendChild(await collectionCard(rec, renderList));
    }
  };

  async function handleFiles(files: File[]): Promise<void> {
    for (const file of files) {
      const state: ImportState = {
        id: file.name + Date.now(),
        name: file.name,
        progress: null,
        status: 'running',
        message: '排队中…',
      };
      imports.set(state.id, state);
      renderZone();
      const handle = importFile(file, (p) => {
        state.progress = p;
        state.message = p.message;
        renderZone();
      });
      try {
        const rec = await handle.promise;
        state.status = 'done';
        state.message = `完成：${rec.pointCount.toLocaleString()} 点`;
        toast(`${file.name} 导入成功（${rec.pointCount.toLocaleString()} 点）`, 'success');
      } catch (e) {
        state.status = 'error';
        state.message = e instanceof Error ? e.message : String(e);
        toast(`${file.name} 导入失败：${state.message}`, 'error', 6000);
      } finally {
        setTimeout(() => imports.delete(state.id), 4000);
        renderZone();
        await renderList();
      }
    }
  }

  async function collectionCard(
    rec: CollectionRecord,
    onChange: () => void,
  ): Promise<HTMLElement> {
    const size = [
      rec.bounds.max[0] - rec.bounds.min[0],
      rec.bounds.max[1] - rec.bounds.min[1],
      rec.bounds.max[2] - rec.bounds.min[2],
    ];
    const card = h('div', { class: 'card', style: 'margin-bottom:0' },
      h('div', { class: 'row' },
        h('strong', { style: 'font-size:14.5px' }, rec.name),
        h('span', {
          class: `badge ${rec.status === 'ready' ? 'ready' : 'error'}`,
          text: rec.status === 'ready' ? '可用' : '损坏',
        }),
        h('span', { class: 'spacer' }),
        h('span', { class: 'muted', style: 'font-size:11.5px' }, formatDate(rec.createdAt))),
      h('div', { class: 'muted', style: 'font-size:12px;margin:6px 0' }, rec.fileName),
      h('table', {},
        h('tbody', {},
          infoRow('点数', rec.pointCount.toLocaleString()),
          infoRow('文件大小', formatBytes(rec.fileSize)),
          infoRow('包围盒尺寸 (m)', size.map((x) => x.toFixed(3)).join(' × ')),
          infoRow('属性', [
            rec.hasColors ? '真彩' : null,
            rec.hasNormals ? '法线' : null,
          ].filter(Boolean).join(' / ') || '仅坐标'))),
      rec.status === 'error'
        ? h('div', {
            style: 'color:var(--red);font-size:12px;margin:8px 0;font-family:var(--mono);word-break:break-all',
          }, `错误：${rec.error ?? '未知错误'}`)
        : null,
      h('div', { class: 'row', style: 'margin-top:10px' },
        h('button', {
          class: 'primary small',
          text: '打开查看器',
          disabled: rec.status !== 'ready',
          onclick: () => go(`#/viewer/${encodeURIComponent(rec.id)}`),
        }),
        h('button', {
          class: 'small',
          text: '测量记录',
          disabled: rec.status !== 'ready',
          onclick: () => go(`#/measures?collection=${encodeURIComponent(rec.id)}`),
        }),
        h('span', { class: 'spacer' }),
        h('button', {
          class: 'danger small',
          text: '删除',
          onclick: async () => {
            const ok = await confirmDialog(
              `确定删除藏品「${rec.name}」？其八叉树节点、测量记录与书签会一并清除，不可恢复。`,
            );
            if (!ok) return;
            await db.deleteCollection(rec.id);
            toast('已删除', 'success');
            onChange();
          },
        })));
    return card;
  }

  function infoRow(k: string, v: string): HTMLElement {
    return h('tr', {}, h('td', { class: 'muted', style: 'padding:4px 0' }, k),
      h('td', { class: 'num', style: 'padding:4px 0' }, v));
  }

  root.append(
    h('h1', { class: 'page-title' }, '藏品列表'),
    dropZone,
    fileInput,
    listHost,
  );
  renderZone();
  await renderList();
}
