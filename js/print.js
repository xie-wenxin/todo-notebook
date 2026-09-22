/* ═══════════════════════════════════════════════════════════
   print.js — 导出 PDF

   做法：把要打印的内容拼成一个隐藏的 DOM（#printRoot），
   调 window.print()，靠 print.css 的 @media print 把别的都藏起来。

   iPhone 上实际路径是：
     window.print() → 打印预览 → 分享 → 存储到文件 → PDF
   ═══════════════════════════════════════════════════════════ */

import {
  TEMPLATE, HABITS, TARGET_HOURS,
  getDay, sessionsForDate, fmtMain, dowLong, addDays, fromKey, dateKey,
} from './store.js';
import { dayFocus, byBlock, fmtMs, pct } from './focus.js';
import { el, svgEl } from './render.js';
import { photoURL } from './diary.js';

const NS_H = (ts) => {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

function row(label, value) {
  return el('div', { class: 'pr-kv' }, [
    el('span', { class: 'pr-k', text: label }),
    el('span', { class: 'pr-v', text: value }),
  ]);
}

/* ── 一页 = 一天 ───────────────────────────────────────── */

async function buildDayPage(date) {
  const day = await getDay(date);
  const raw = await sessionsForDate(date);
  const sessions = raw.map(s => ({ ...s, away: s.away || [] }));
  const focus = dayFocus(sessions);
  const per = byBlock(sessions);

  const page = el('section', { class: 'pr-page' });

  /* 页眉 */
  page.appendChild(el('header', { class: 'pr-head' }, [
    el('h1', { class: 'pr-date', text: fmtMain(date) }),
    el('span', { class: 'pr-dow', text: dowLong(date) }),
  ]));

  /* 大数字 */
  const hours = focus.effectiveMs / 3600000;
  page.appendChild(el('div', { class: 'pr-big' }, [
    el('div', { class: 'pr-big-main' }, [
      el('b', { text: fmtMs(focus.effectiveMs) }),
      el('span', { text: ` / ${TARGET_HOURS}h　${pct(hours / TARGET_HOURS)}` }),
    ]),
    el('div', { class: 'pr-big-sub', text:
      `有效专注　离开 ${focus.awayCount} 次（共 ${fmtMs(focus.awayMs)}）　` +
      `会话 ${focus.sessionCount} 段` }),
  ]));

  /* 全天时间线 */
  const segs = focus.segments || [];
  if (segs.length) {
    const DAY_A = 6 * 60 + 30, DAY_B = 23 * 60 + 30;
    const span = DAY_B - DAY_A;
    const W = 1000, H = 26;
    const toX = (ts) => {
      const d = new Date(ts);
      const m = d.getHours() * 60 + d.getMinutes() + d.getSeconds() / 60;
      return Math.max(0, Math.min(W, ((m - DAY_A) / span) * W));
    };
    const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: 'none', class: 'pr-tl' });
    for (let m = DAY_A; m <= DAY_B; m += 180) {
      const x = ((m - DAY_A) / span) * W;
      svg.appendChild(svgEl('line', { x1: x, y1: 0, x2: x, y2: H, class: 'pr-tl-tick' }));
    }
    for (const s of segs) {
      const x1 = toX(s.from);
      const w = Math.max(2.5, toX(s.to) - x1);
      svg.appendChild(svgEl('rect', {
        x: Math.min(x1, W - w), y: 3, width: w, height: H - 6, rx: 3, class: 'pr-tl-focus',
      }));
    }
    page.appendChild(svg);
    const axis = el('div', { class: 'pr-axis' });
    for (let m = DAY_A; m <= DAY_B; m += 180) {
      axis.appendChild(el('span', { text: `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}` }));
    }
    page.appendChild(axis);
  }

  /* 时间块 + 待办 */
  const blocks = el('div', { class: 'pr-blocks' });
  for (const b of TEMPLATE) {
    const got = (per[b.id] && per[b.id].effectiveMs) || 0;
    const list = (day.todos && day.todos[b.id]) || [];
    const doneN = list.filter(t => t.done).length;

    const box = el('div', { class: 'pr-block' });
    box.appendChild(el('div', { class: 'pr-block-top' }, [
      el('span', { class: 'pr-block-time', text: `${b.start}–${b.end}` }),
      el('strong', { class: 'pr-block-name', text: b.title }),
      b.study
        ? el('span', { class: 'pr-block-got', text: `${fmtMs(got)} / ${b.hours}h` })
        : el('span', { class: 'pr-block-got muted', text: got > 0 ? fmtMs(got) : '—' }),
    ]));

    if (b.habit) {
      const on = day.habits && day.habits[b.habit];
      box.appendChild(el('div', { class: 'pr-habit', text: `习惯 · ${b.habit} ${on ? '✓' : '○'}` }));
    }

    if (list.length) {
      const ul = el('ul', { class: 'pr-todos' });
      for (const t of list) {
        ul.appendChild(el('li', { class: 'pr-todo' + (t.done ? ' done' : '') }, [
          el('span', { class: 'pr-box', text: t.done ? '☑' : '☐' }),
          el('span', { text: t.text }),
        ]));
      }
      box.appendChild(ul);
    } else if (!b.habit) {
      box.appendChild(el('div', { class: 'pr-none', text: '（无待办）' }));
    }

    blocks.appendChild(box);
  }
  page.appendChild(el('h2', { class: 'pr-h2', text: '日程' }));
  page.appendChild(blocks);

  /* 睡眠 */
  if (day.sleepAt || day.wakeAt) {
    page.appendChild(el('h2', { class: 'pr-h2', text: '睡眠' }));
    let line = `🌙 ${day.sleepAt ? NS_H(day.sleepAt) : '—'}　☀️ ${day.wakeAt ? NS_H(day.wakeAt) : '—'}`;
    if (day.sleepAt && day.wakeAt) {
      let ms = day.wakeAt - day.sleepAt;
      if (ms < 0) ms += 24 * 3600000;
      line += `　睡了 ${Math.floor(ms / 3600000)} 小时 ${Math.round((ms % 3600000) / 60000)} 分`;
    }
    page.appendChild(el('div', { class: 'pr-line', text: line }));
  }

  /* 日记 */
  const diaryText = (day.diary && day.diary.text || '').trim();
  if (diaryText || (day.photos || []).length) {
    page.appendChild(el('h2', { class: 'pr-h2', text: '日记' }));
    if (diaryText) {
      page.appendChild(el('div', { class: 'pr-diary', text: diaryText }));
    }
    const ids = day.photos || [];
    if (ids.length) {
      const grid = el('div', { class: 'pr-photos' });
      for (const id of ids) {
        const url = await photoURL(id, 'full');
        if (!url) continue;
        grid.appendChild(el('img', { class: 'pr-photo', src: url, alt: '' }));
      }
      page.appendChild(grid);
    }
  }
  return page;
}

/* ── 打印入口 ──────────────────────────────────────────── */

function waitForImages(root) {
  const imgs = [...root.querySelectorAll('img')];
  return Promise.all(imgs.map(img => (img.complete
    ? null
    : new Promise(res => { img.onload = res; img.onerror = res; }))));
}

async function run(builders, root) {
  root.textContent = '';
  for (const b of builders) root.appendChild(await b());
  await waitForImages(root);
  /* 等一帧让排版落定，再叫打印面板 */
  await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
  window.print();
  setTimeout(() => { root.textContent = ''; }, 1500);
}

/** 打印某一天 */
export async function printDay(date) {
  const root = document.getElementById('printRoot');
  if (!root) return;
  await run([() => buildDayPage(date)], root);
}

/** 打印某个月（anchor 所在月） */
export async function printMonth(anchor) {
  const root = document.getElementById('printRoot');
  if (!root) return;

  const d = fromKey(anchor);
  const first = dateKey(new Date(d.getFullYear(), d.getMonth(), 1));
  const lastDay = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();

  const days = [];
  for (let i = 0; i < lastDay; i++) days.push(addDays(first, i));

  const builders = days.map(day => () => buildDayPage(day));
  await run(builders, root);
}
