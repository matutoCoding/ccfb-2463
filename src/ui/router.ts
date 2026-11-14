// Hash 路由：#/collections | #/viewer/:id | #/measures | #/compare | #/settings
export type Route =
  | { name: 'collections' }
  | { name: 'viewer'; id: string }
  | { name: 'measures'; collectionId?: string }
  | { name: 'compare' }
  | { name: 'settings' };

export function parseHash(): Route {
  const hash = location.hash.replace(/^#\/?/, '');
  const [path, query] = hash.split('?');
  const parts = path.split('/').filter(Boolean);
  if (parts[0] === 'viewer' && parts[1]) return { name: 'viewer', id: decodeURIComponent(parts[1]) };
  if (parts[0] === 'measures') {
    const cid = new URLSearchParams(query ?? '').get('collection') ?? undefined;
    return { name: 'measures', collectionId: cid };
  }
  if (parts[0] === 'compare') return { name: 'compare' };
  if (parts[0] === 'settings') return { name: 'settings' };
  return { name: 'collections' };
}

export function go(hash: string): void {
  location.hash = hash.startsWith('#') ? hash : `#/${hash.replace(/^\//, '')}`;
}

export function onRouteChange(fn: (r: Route) => void): () => void {
  const handler = () => fn(parseHash());
  window.addEventListener('hashchange', handler);
  return () => window.removeEventListener('hashchange', handler);
}
