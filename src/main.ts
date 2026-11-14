import './ui/styles.css';
import { h, clear } from './ui/dom';
import { onRouteChange, parseHash, type Route } from './ui/router';
import { settingsStore } from './core/settings';
import { renderCollectionsPage } from './ui/pages/collections';
import { renderViewerPage } from './ui/pages/viewer';
import { renderMeasuresPage } from './ui/pages/measures';
import { renderComparePage } from './ui/pages/compare';
import { renderSettingsPage } from './ui/pages/settings';

const NAV: { hash: string; label: string; match: Route['name'] }[] = [
  { hash: '#/collections', label: '藏品列表', match: 'collections' },
  { hash: '#/viewer', label: '查看器', match: 'viewer' },
  { hash: '#/measures', label: '测量记录', match: 'measures' },
  { hash: '#/compare', label: '对比', match: 'compare' },
  { hash: '#/settings', label: '设置', match: 'settings' },
];

async function bootstrap(): Promise<void> {
  await settingsStore.init();
  const app = document.getElementById('app')!;
  const header = h('header', { class: 'app-header' });
  const body = h('div', { class: 'app-body' });
  app.append(header, body);

  const render = (route: Route): void => {
    clear(header);
    header.append(
      h('div', { class: 'app-title' }, '石刻青铜器点云系统',
        h('span', { class: 'sub' }, 'WebGL2 · 八叉树 LOD · EDL')),
      h('nav', { class: 'nav' },
        ...NAV.map((n) =>
          h('a', {
            href: n.hash,
            class: route.name === n.match ? 'active' : '',
          }, n.label),
        )),
    );
    clear(body);
    const page = h('div', {
      class: route.name === 'viewer' || route.name === 'compare' ? 'page nopad' : 'page',
    });
    body.appendChild(page);
    renderRoute(route, page);
  };

  const renderRoute = (route: Route, page: HTMLDivElement): void => {
    switch (route.name) {
      case 'collections':
        renderCollectionsPage(page);
        break;
      case 'viewer':
        renderViewerPage(page, route.id);
        break;
      case 'measures':
        renderMeasuresPage(page, route.collectionId);
        break;
      case 'compare':
        renderComparePage(page);
        break;
      case 'settings':
        renderSettingsPage(page);
        break;
    }
  };

  onRouteChange(render);
  if (!location.hash) location.hash = '#/collections';
  render(parseHash());
}

bootstrap().catch((e) => {
  document.getElementById('app')!.innerHTML =
    `<div style="padding:40px;color:#e05d5d">启动失败：${String(e)}</div>`;
});
