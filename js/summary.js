/* ═══════════════════════════════════════════════════════════
   summary.js — 日总结（右划进来）

   版面（尽量一屏）：
     左边  一条**竖的时间轴**，从 06:30 到 23:30，专注的时段涂上颜色
     右边  扇形图 + 图例
     底下  睡眠（只有 🌙 和 ☀️ 两个图标）

   日程明细不在这里展开了 —— 时间轴已经能看出哪段在专注。
   每个时间块有自己的颜色，扇形图和时间轴用同一套色，能对上号。
   ═══════════════════════════════════════════════════════════ */

import {
  TEMPLATE, TARGET_HOURS, DAY_START, DAY_END,
  toMin, todayKey, putDay, fmtMain, dowLong, sessionsForDate,
} from './store.js';
import { dayFocus, byBlock, fmtMs, pct } from './focus.js';
import { el } from './render.js';
import { markAsleep, clearAsleep } from './sleep.js';
import { renderGoals } from './goals.js';
import { attachSwipe } from './gestures.js';

let deps = { toast: () => {}, onChange: () => {} };
let wired = false;
let cur = { date: null, day: null, sessions: [], focus: null, perBlock: {} };

const $ = (id) => document.getElementById(id);

/* 每个时间块一个固定颜色 —— 扇形图和时间轴共用，能对上号 */
const BLOCK_COLORS = [
  '#3E8F71', '#3D80B4', '#B98D1B', '#B85C78',
  '#6E5CB8', '#BE6F2E', '#2F8478', '#7C9473',
];

function colorOf(blockId) {
  const i = TEMPLATE.findIndex(b => b.id === blockId);
  return BLOCK_COLORS[(i < 0 ? 0 : i) % BLOCK_COLORS.length];
}

function hhmm(ts) {
  if (!ts) return '—';
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/* ═══ 扇形图 ═════════════════════════════════════════════ */

function renderDonut() {
  const host = $('sumDonut');
  host.textContent = '';

  const focus = cur.focus || { effectiveMs: 0 };
  const per = cur.perBlock || {};
  const targetMs = TARGET_HOURS * 3600000;

  const entries = TEMPLATE
    .map(b => ({ block: b, ms: (per[b.id] && per[b.id].effectiveMs) || 0 }))
    .filter(e => e.ms > 0)
    .sort((a, b) => b.ms - a.ms);

  const sumMs = entries.reduce((s, e) => s + e.ms, 0);
  const R = 38;
  const C = 2 * Math.PI * R;
  const fill = Math.min(1, focus.effectiveMs / targetMs) * C;

  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 100 100');
  svg.setAttribute('class', 'donut');

  const track = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
  track.setAttribute('class', 'donut-track');
  track.setAttribute('cx', 50); track.setAttribute('cy', 50); track.setAttribute('r', R);
  track.setAttribute('stroke-dasharray', C.toFixed(2));
  svg.appendChild(track);

  if (sumMs > 0 && fill > 0) {
    const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    g.setAttribute('transform', 'rotate(-90 50 50)');
    let acc = 0;
    for (const e of entries) {
      const len = (e.ms / sumMs) * fill;
      const c = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
      c.setAttribute('class', 'donut-seg');
      c.setAttribute('cx', 50); c.setAttribute('cy', 50); c.setAttribute('r', R);
      c.setAttribute('stroke', colorOf(e.block.id));
      c.setAttribute('stroke-dasharray', `${len.toFixed(3)} ${(C - len).toFixed(3)}`);
      c.setAttribute('stroke-dashoffset', (-acc).toFixed(3));
      g.appendChild(c);
      acc += len;
    }
    svg.appendChild(g);
  }

  const wrap = el('div', { class: 'donut-wrap' }, [svg]);
  const ratio = focus.effectiveMs / targetMs;
  wrap.appendChild(el('div', { class: 'donut-center' }, [
    el('div', { class: 'donut-big', text: fmtMs(focus.effectiveMs) }),
    el('div', { class: 'donut-mid', text: pct(ratio) }),
    el('div', { class: 'donut-small', text: `/ ${TARGET_HOURS}h` }),
  ]));
  host.appendChild(wrap);

  /* 图例 */
  const legend = $('sumLegend');
  legend.textContent = '';

  if (!entries.length) {
    legend.appendChild(el('p', { class: 'sum-empty', text: '还没有专注记录' }));
    return;
  }

  for (const e of entries) {
    legend.appendChild(el('div', { class: 'legend-row' }, [
      el('i', { class: 'legend-dot', style: `background:${colorOf(e.block.id)};` }),
      el('span', { class: 'legend-name', text: e.block.title }),
      el('span', { class: 'legend-val', text: fmtMs(e.ms) }),
    ]));
  }
}

/* ═══ 竖时间轴（靠左） ═══════════════════════════════════ */

function renderVTimeline() {
  const host = $('sumTimeline');
  host.textContent = '';

  const startMin = toMin(DAY_START);
  const endMin = toMin(DAY_END);
  const span = endMin - startMin;

  const bar = el('div', { class: 'vtl-bar' });
  const segs = (cur.focus && cur.focus.segments) || [];
  const per = cur.perBlock || {};

  /* 先画整天的底 */
  if (!segs.length) {
    bar.appendChild(el('span', { class: 'vtl-none' }));
  }

  /* 每个块的专注段按块上色 */
  for (const b of TEMPLATE) {
    const list = (per[b.id] && per[b.id].segments) || [];
    for (const s of list) {
      const from = new Date(s.from);
      const to = new Date(s.to);
      const f = from.getHours() * 60 + from.getMinutes() + from.getSeconds() / 60;
      const t = to.getHours() * 60 + to.getMinutes() + to.getSeconds() / 60;
      const top = ((f - startMin) / span) * 100;
      const h = Math.max(0.6, ((t - f) / span) * 100);
      bar.appendChild(el('span', {
        class: 'vtl-seg',
        style: `top:${top.toFixed(2)}%;height:${h.toFixed(2)}%;background:${colorOf(b.id)};`,
      }));
    }
  }

  /* 「现在」那条线（只看今天） */
  if (cur.date === todayKey()) {
    const n = new Date();
    const m = n.getHours() * 60 + n.getMinutes();
    if (m >= startMin && m <= endMin) {
      bar.appendChild(el('span', {
        class: 'vtl-now',
        style: `top:${(((m - startMin) / span) * 100).toFixed(2)}%;`,
      }));
    }
  }

  const hours = [];
  for (let m = startMin; m <= endMin; m += 180) {
    hours.push(`${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`);
  }

  const labels = el('div', { class: 'vtl-labels' });
  for (const t of hours) labels.appendChild(el('span', { text: t }));

  host.appendChild(el('div', { class: 'vtl' }, [bar, labels]));
}

/* ═══ 睡眠（只有月亮和太阳） ════════════════════════════ */

function renderSleep() {
  const host = $('sumSleep');
  host.textContent = '';
  const day = cur.day;

  const mk = (icon, ts, onTap) => {
    const b = el('button', { type: 'button', class: 'sleep-btn' + (ts ? ' on' : '') }, [
      el('span', { class: 'sleep-icon', text: icon }),
      el('span', { class: 'sleep-time', text: hhmm(ts) }),
    ]);
    b.addEventListener('click', onTap);
    return b;
  };

  const sleepBtn = mk('🌙', day.sleepAt, async () => {
    if (day.sleepAt) { await clearAsleep(day); renderSleep(); return; }
    await markAsleep(day);
    renderSleep();
    deps.toast('晚安');
  });

  const wakeBtn = mk('☀️', day.wakeAt, async () => {
    day.wakeAt = day.wakeAt ? null : Date.now();
    await putDay(day);
    renderSleep();
  });

  host.append(sleepBtn, wakeBtn);

  if (day.sleepAt && day.wakeAt) {
    let ms = day.wakeAt - day.sleepAt;
    if (ms < 0) ms += 24 * 3600000;
    host.appendChild(el('p', {
      class: 'sum-note',
      text: `${Math.floor(ms / 3600000)}h${String(Math.round((ms % 3600000) / 60000)).padStart(2, '0')}m`,
    }));
  }
}

/* ═══ 装配 ═══════════════════════════════════════════════ */

function renderAll() {
  $('sumDate').textContent = `${fmtMain(cur.date)} · ${dowLong(cur.date)}`;
  renderDonut();
  renderVTimeline();
  renderSleep();
  renderGoals(deps);
}

export async function openSummary(date, day) {
  cur.date = date;
  cur.day = day;
  await refreshSummary();
  showLayer();
}

export async function refreshSummary() {
  if (!cur.date) return;
  cur.sessions = await sessionsForDate(cur.date);
  const clean = cur.sessions.map(s => ({ ...s, away: s.away || [] }));
  cur.focus = dayFocus(clean);
  cur.perBlock = byBlock(clean, { withSegments: true });
  renderAll();
}

function showLayer() {
  const layer = $('summaryLayer');
  layer.hidden = false;
  requestAnimationFrame(() => requestAnimationFrame(() => layer.classList.add('show')));
}

export function closeSummary() {
  const layer = $('summaryLayer');
  if (!layer || layer.hidden) return;
  layer.classList.remove('show');
  setTimeout(() => { layer.hidden = true; }, 300);
}

export function isSummaryOpen() {
  const layer = $('summaryLayer');
  return !!layer && !layer.hidden && layer.classList.contains('show');
}

export function initSummary(options = {}) {
  Object.assign(deps, options);
  if (wired) return;
  wired = true;

  $('sumClose').addEventListener('click', closeSummary);
  attachSwipe($('summaryLayer'), {
    onRight: closeSummary,
    onLeft: closeSummary,
  });
}
