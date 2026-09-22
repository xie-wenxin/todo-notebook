/* ═══════════════════════════════════════════════════════════
   theme.js — 颜色：把主题贴到页面上，以及那 16 个小色块
   ═══════════════════════════════════════════════════════════ */

import { THEMES, themeById, DEFAULT_THEME } from './store.js';
import { el } from './render.js';

/** 把一套主题贴到 <html data-theme> 上，CSS 变量立刻全部生效 */
export function applyTheme(id) {
  const t = themeById(id);
  document.documentElement.setAttribute('data-theme', t.id);

  /* 状态栏 / 浏览器工具栏跟着变色 */
  let meta = document.querySelector('meta[name="theme-color"]');
  if (!meta) {
    meta = document.createElement('meta');
    meta.name = 'theme-color';
    document.head.appendChild(meta);
  }
  meta.content = t.paper;

  /* 饱和色要切成浅色状态栏文字 */
  let bar = document.querySelector('meta[name="apple-mobile-web-app-status-bar-style"]');
  if (bar) bar.content = t.dark ? 'black-translucent' : 'default';

  return t;
}

/** 这一天该用哪个颜色：自己挑过就用自己挑的，没挑过就跟全局默认 */
export function themeForDay(day, settings) {
  return (day && day.theme) || (settings && settings.theme) || DEFAULT_THEME;
}

/** 画色块面板 */
export function renderSwatches(container, currentId, onPick) {
  container.textContent = '';

  /* 第一格：跟随默认色 */
  const isDefault = !currentId;
  const def = themeById(DEFAULT_THEME);
  const defCell = el('button', {
    class: 'swatch' + (isDefault ? ' on' : ''),
    type: 'button',
    'data-id': '',
    style: `background:${def.paper};color:${def.ink};`,
  }, [el('span', { class: 'swatch-name', text: '默认' })]);
  defCell.addEventListener('click', () => onPick(null));
  container.appendChild(defCell);

  for (const t of THEMES) {
    const cell = el('button', {
      class: 'swatch' + (t.id === currentId ? ' on' : ''),
      type: 'button',
      'data-id': t.id,
      'aria-label': t.name,
      style: `background:${t.paper};color:${t.ink};`,
    }, [
      /* 用一个小圆点展示这套颜色的强调色 */
      el('span', {
        style: `position:absolute;top:.4rem;left:.45rem;width:.6rem;height:.6rem;border-radius:50%;background:${t.accent};`,
      }),
      el('span', { class: 'swatch-name', text: t.name }),
    ]);
    cell.addEventListener('click', () => onPick(t.id));
    container.appendChild(cell);
  }
}
