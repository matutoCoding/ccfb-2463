// 轻量 DOM 辅助与全局 Toast
export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | number | boolean | EventListener | undefined> = {},
  ...children: (Node | string | null | undefined | false)[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === false || v === null) continue;
    if (k === 'class') el.className = String(v);
    else if (k === 'text') el.textContent = String(v);
    else if (k.startsWith('on') && typeof v === 'function') {
      el.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
    } else if (v === true) {
      el.setAttribute(k, '');
    } else {
      el.setAttribute(k, String(v));
    }
  }
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    el.append(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return el;
}

export function clear(el: HTMLElement): void {
  el.replaceChildren();
}

let toastHost: HTMLDivElement | null = null;

function ensureHost(): HTMLDivElement {
  if (!toastHost) {
    toastHost = h('div', { class: 'toast-host' });
    document.body.appendChild(toastHost);
  }
  return toastHost;
}

export function toast(message: string, kind: 'info' | 'error' | 'success' | 'warn' = 'info', ms = 3800): void {
  const el = h('div', { class: `toast ${kind === 'info' ? '' : kind}` }, message);
  ensureHost().appendChild(el);
  setTimeout(() => {
    el.style.opacity = '0';
    el.style.transition = 'opacity 0.3s';
    setTimeout(() => el.remove(), 320);
  }, ms);
}

export function confirmDialog(message: string, title = '确认操作'): Promise<boolean> {
  return new Promise((resolve) => {
    const mask = h('div', { class: 'dialog-mask' });
    const dlg = h(
      'div',
      { class: 'dialog' },
      h('h2', {}, title),
      h('p', { class: 'dim' }, message),
      h(
        'div',
        { class: 'row', style: 'justify-content:flex-end;margin-top:16px' },
        h('button', {
          text: '取消',
          onclick: () => { mask.remove(); resolve(false); },
        }),
        h('button', {
          class: 'danger',
          text: '确认',
          onclick: () => { mask.remove(); resolve(true); },
        }),
      ),
    );
    mask.appendChild(dlg);
    document.body.appendChild(mask);
  });
}
