// 测量记录页：按藏品筛选、查看/编辑备注、跳转查看器、导出 CSV
import { db } from '../../core/db';
import { formatMeasure, unitOf } from '../../core/measure';
import type { MeasureRecord } from '../../core/types';
import { downloadBlob, formatDate } from '../../core/util';
import { h, clear, toast, confirmDialog } from '../dom';
import { go } from '../router';

export async function renderMeasuresPage(root: HTMLElement, collectionId?: string): Promise<void> {
  const collections = await db.listCollections();
  const nameOf = new Map(collections.map((c) => [c.id, c.name]));
  let measures = await db.listMeasures(collectionId);
  measures.sort((a, b) => b.createdAt - a.createdAt);

  root.appendChild(h('h1', { class: 'page-title' }, '测量记录'));

  const filter = h('select', {},
    h('option', { value: '', text: '全部藏品' }),
    ...collections.map((c) => h('option', { value: c.id, text: c.name })),
  ) as HTMLSelectElement;
  filter.value = collectionId ?? '';

  const tableHost = h('div');

  const renderTable = (rows: MeasureRecord[]): void => {
    clear(tableHost);
    if (rows.length === 0) {
      tableHost.appendChild(h('div', { class: 'empty' }, '暂无测量记录。在查看器中使用测量工具后会保存到这里。'));
      return;
    }
    const table = h('table', {},
      h('thead', {}, h('tr', {},
        h('th', {}, '类型'), h('th', { class: 'num' }, '结果'),
        h('th', {}, '藏品'), h('th', {}, '坐标点'),
        h('th', {}, '备注'), h('th', {}, '时间'), h('th', {}, '操作'))),
      h('tbody', {},
        ...rows.map((m) =>
          h('tr', {},
            h('td', {}, h('span', {
              class: 'badge info',
              text: { distance: '距离', area: '面积', angle: '角度' }[m.kind],
            })),
            h('td', { class: 'num' }, `${m.result.toFixed(5)} ${unitOf(m.kind)}`),
            h('td', {}, nameOf.get(m.collectionId) ?? '（已删除）'),
            h('td', { class: 'num', style: 'font-size:11px' },
              m.points.map((p) => `(${p.map((x) => x.toFixed(3)).join(', ')})`).join(' ')),
            h('td', { style: 'max-width:180px' }, m.note || h('span', { class: 'muted' }, '—')),
            h('td', { class: 'muted', style: 'font-size:12px' }, formatDate(m.createdAt)),
            h('td', {},
              h('div', { class: 'row', style: 'gap:6px' },
                h('button', {
                  class: 'small', text: '查看',
                  onclick: () => go(`#/viewer/${encodeURIComponent(m.collectionId)}`),
                }),
                h('button', {
                  class: 'small', text: '备注',
                  onclick: async () => {
                    const note = prompt('编辑备注', m.note);
                    if (note !== null) {
                      await db.putMeasure({ ...m, note });
                      toast('备注已保存', 'success');
                      void refresh();
                    }
                  },
                }),
                h('button', {
                  class: 'small danger', text: '删除',
                  onclick: async () => {
                    if (await confirmDialog('删除该测量记录？')) {
                      await db.deleteMeasure(m.id);
                      toast('已删除', 'success');
                      void refresh();
                    }
                  },
                })))))));
    tableHost.appendChild(table);
  };

  async function refresh(): Promise<void> {
    measures = await db.listMeasures(filter.value || undefined);
    measures.sort((a, b) => b.createdAt - a.createdAt);
    renderTable(measures);
  }

  filter.addEventListener('change', () => void refresh());

  const exportCsv = (): void => {
    if (measures.length === 0) {
      toast('没有可导出的记录', 'warn');
      return;
    }
    const lines = ['id,collection,kind,result,unit,note,created_at,points'];
    for (const m of measures) {
      lines.push([
        m.id,
        nameOf.get(m.collectionId) ?? m.collectionId,
        m.kind,
        m.result.toFixed(6),
        unitOf(m.kind),
        `"${m.note.replace(/"/g, '""')}"`,
        new Date(m.createdAt).toISOString(),
        `"${m.points.map((p) => p.join(' ')).join(' | ')}"`,
      ].join(','));
    }
    downloadBlob(new Blob(['﻿' + lines.join('\n')], { type: 'text/csv;charset=utf-8' }),
      `measurements_${Date.now()}.csv`);
    toast('CSV 已导出', 'success');
  };

  root.append(
    h('div', { class: 'toolbar' },
      h('label', { class: 'field', style: 'flex-direction:row;align-items:center;gap:8px' }, '藏品', filter),
      h('span', { class: 'spacer' }),
      h('button', { text: '导出 CSV', onclick: exportCsv })),
    tableHost,
  );
  renderTable(measures);
}
