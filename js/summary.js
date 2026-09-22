/* ═══════════════════════════════════════════════════════════
   summary.js — 日总结（右划进来）

   五块内容：
     ① 扇形图（环形）：目标 12h 填了多少，以及这几个小时分别来自哪个块
     ② 日程：每个时间块的 计划 vs 实际专注 + 待办完成情况
     ③ 习惯：英语 / 背单词 / 运动 / 练字 的今日打卡
     ④ 睡眠：🌙 我睡了 / ☀️ 我醒了
     ⑤ 全天专注时间线：一天里所有专注会话合并后铺在 6:30–23:30 上
   ═══════════════════════════════════════════════════════════ */

import {
  TEMPLATE, TARGET_HOURS, HABITS, habitBlock, DAY_START, DAY_END,
  toMin, todayKey, putDay, fmtMain, dowLong, sessionsForDate,
} from './store.js';
import { dayFocus, byBlock, fmtMs, pct } from './focus.js';
import { el, svgEl } from './render.js';
import { attachSwipe } from './gestures.js';

let deps = { toast: () => {}, onChange: () => {} };
let wired = false;
let cur = { date: null, day: null, sessions: [], focus: null, perBlock: {} };

const $ = (id) => document.getElementById(id);

/* ── 工具 ──────────────────────────────────────────────── */

function dayMinutes(ts) {
  const d = new Date(ts);
  return d.getHours() * 60 + d.getMinutes() + d.getSeconds() / 60;
}

function hhmm(ts) {
  if (!ts) return '—';
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function clickable(node, fn) {
  node.addEventListener('click', fn);
  return node;
}

/* ═══ ① 扇形图 ═══════════════════════════════════════════ */

function renderDonut() {
  const host = $('sumDonut');
  host.textContent = '';

  const focus = cur.focus || { effectiveMs: 0, awayCount: 0, awayMs: 0 };
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

  const svg = svgEl('svg', { viewBox: '0 0 100 100', class: 'donut' });

  /* 底圈 = 12h 目标 */
  svg.appendChild(svgEl('circle', {
    class: 'donut-track', cx: 50, cy: 50, r: R,
    'stroke-dasharray': C.toFixed(2),
  }));

  /* 已完成的弧，按块切成段。
     每段长度按「块内占比 × 已填弧长」算，保证加起来正好等于已填部分。 */
  if (sumMs > 0 && fill > 0) {
    const g = svgEl('g', { transform: 'rotate(-90 50 50)' });
    let acc = 0;
    entries.forEach((e, i) => {
      const len = (e.ms / sumMs) * fill;
      const opacity = Math.max(0.34, 0.98 - i * 0.15);
      g.appendChild(svgEl('circle', {
        class: 'donut-seg ' + (e.block.study ? 'study' : 'other'),
        cx: 50, cy: 50, r: R,
        'stroke-dasharray': `${len.toFixed(3)} ${(C - len).toFixed(3)}`,
        'stroke-dashoffset': (-acc).toFixed(3),
        'stroke-opacity': opacity.toFixed(2),
      }));
      acc += len;
    });
    svg.appendChild(g);
  }

  const wrap = el('div', { class: 'donut-wrap' }, [svg]);

  /* 圆心文字用 HTML 叠上去，配色自动跟着主题走 */
  const ratio = focus.effectiveMs / targetMs;
  wrap.appendChild(el('div', { class: 'donut-center' }, [
    el('div', { class: 'donut-big', text: fmtMs(focus.effectiveMs) }),
    el('div', { class: 'donut-mid', text: pct(ratio) + ' / ' + TARGET_HOURS + 'h' }),
    el('div', { class: 'donut-small', text: '有效专注' }),
  ]));

  host.appendChild(wrap);

  /* 图例 */
  const legend = $('sumLegend');
  legend.textContent = '';

  if (!entries.length) {
    legend.appendChild(el('p', {
      class: 'sum-empty',
      text: cur.date === todayKey()
        ? '今天还没开始专注。左划进专注，开始第一段。'
        : '这天没有专注记录。',
    }));
    return;
  }

  for (const e of entries) {
    legend.appendChild(el('div', { class: 'legend-row' }, [
      el('span', {
        class: 'legend-dot ' + (e.block.study ? 'study' : 'other'),
      }),
      el('span', { class: 'legend-name', text: e.block.title }),
      el('span', { class: 'legend-val', text: fmtMs(e.ms) }),
    ]));
  }

  if (focus.awayCount) {
    legend.appendChild(el('p', {
      class: 'sum-note',
      text: `另：离开 ${focus.awayCount} 次，共 ${fmtMs(focus.awayMs)}（短于 2 分钟的不扣有效时长）`,
    }));
  }
}

/* ═══ ② 日程 ═════════════════════════════════════════════ */

function renderBlocks() {
  const host = $('sumBlocks');
  host.textContent = '';
  const per = cur.perBlock || {};
  const day = cur.day;

  for (const b of TEMPLATE) {
    const got = (per[b.id] && per[b.id].effectiveMs) || 0;
    const planMs = b.hours * 3600000;
    const list = (day.todos && day.todos[b.id]) || [];
    const doneN = list.filter(t => t.done).length;

    const row = el('div', { class: 'sum-block' });

    row.appendChild(el('div', { class: 'sum-block-top' }, [
      el('span', { class: 'sum-block-time', text: `${b.start}–${b.end}` }),
      el('span', { class: 'sum-block-name', text: b.title }),
      b.study
        ? el('span', {
          class: 'sum-block-got' + (got >= planMs ? ' full' : ''),
          text: `${fmtMs(got)} / ${b.hours}h`,
        })
        : el('span', { class: 'sum-block-got muted', text: got > 0 ? fmtMs(got) : '不计入' }),
    ]));

    if (b.study) {
      const w = planMs ? Math.min(100, (got / planMs) * 100) : 0;
      const bar = el('div', { class: 'sum-bar' }, [
        el('i', { style: `width:${w.toFixed(1)}%;` }),
      ]);
      if (got >= planMs) bar.classList.add('full');
      row.appendChild(bar);
    }

    const bits = [];
    if (list.length) bits.push(`待办 ${doneN}/${list.length}`);
    if (b.habit) bits.push((day.habits && day.habits[b.habit]) ? `习惯 ${b.habit} ✅` : `习惯 ${b.habit} 未打卡`);
    if (got === 0 && !list.length && !b.habit) bits.push('无记录');

    if (bits.length) {
      row.appendChild(el('div', { class: 'sum-block-sub', text: bits.join(' · ') }));
    }

    host.appendChild(row);
  }
}

/* ═══ ③ 习惯 ═════════════════════════════════════════════ */

function renderHabits() {
  const host = $('sumHabits');
  host.textContent = '';

  if (!HABITS.length) {
    host.appendChild(el('p', { class: 'sum-empty', text: '模板里还没有标记习惯项。' }));
    return;
  }

  for (const name of HABITS) {
    const on = !!(cur.day.habits && cur.day.habits[name]);
    const b = habitBlock(name);
    const chip = el('button', {
      type: 'button',
      class: 'habit' + (on ? ' on' : ''),
      'data-habit': name,
    }, [
      el('span', { class: 'habit-tick', text: on ? '✓' : '' }),
      el('span', { class: 'habit-name', text: name }),
      b ? el('span', { class: 'habit-time', text: `${b.start}–${b.end}` }) : null,
    ]);

    chip.addEventListener('click', async () => {
      if (!cur.day.habits) cur.day.habits = {};
      cur.day.habits[name] = !cur.day.habits[name];
      await putDay(cur.day);
      renderHabits();
      deps.onChange();
    });

    host.appendChild(chip);
  }

  const doneN = HABITS.filter(n => cur.day.habits && cur.day.habits[n]).length;
  host.appendChild(el('p', {
    class: 'sum-note',
    text: `今天打卡 ${doneN}/${HABITS.length}`,
  }));
}

/* ═══ ④ 睡眠 ═════════════════════════════════════════════ */

function renderSleep() {
  const host = $('sumSleep');
  host.textContent = '';
  const day = cur.day;

  const sleepBtn = el('button', {
    type: 'button',
    class: 'sleep-btn' + (day.sleepAt ? ' on' : ''),
  }, [
    el('span', { class: 'sleep-icon', text: '🌙' }),
    el('span', { class: 'sleep-label', text: '我睡了' }),
    el('span', { class: 'sleep-time', text: day.sleepAt ? hhmm(day.sleepAt) : '点一下记录' }),
  ]);

  const wakeBtn = el('button', {
    type: 'button',
    class: 'sleep-btn' + (day.wakeAt ? ' on' : ''),
  }, [
    el('span', { class: 'sleep-icon', text: '☀️' }),
    el('span', { class: 'sleep-label', text: '我醒了' }),
    el('span', { class: 'sleep-time', text: day.wakeAt ? hhmm(day.wakeAt) : '点一下记录' }),
  ]);

  sleepBtn.addEventListener('click', async () => {
    /* 再点一下取消，免得点错了没法改 */
    day.sleepAt = day.sleepAt ? null : Date.now();
    await putDay(day);
    renderSleep();
    deps.toast(day.sleepAt ? `记下了：${hhmm(day.sleepAt)} 睡了` : '已清除睡觉时间');
  });

  wakeBtn.addEventListener('click', async () => {
    day.wakeAt = day.wakeAt ? null : Date.now();
    await putDay(day);
    renderSleep();
    deps.toast(day.wakeAt ? `记下了：${hhmm(day.wakeAt)} 醒了` : '已清除起床时间');
  });

  host.append(sleepBtn, wakeBtn);

  /* 两个都有了才算睡眠时长 */
  let text = '点月亮记睡觉、点太阳记起床。';
  if (day.sleepAt && day.wakeAt) {
    let ms = day.wakeAt - day.sleepAt;
    if (ms < 0) ms += 24 * 3600000;     /* 跨了午夜 */
    const h = Math.floor(ms / 3600000);
    const m = Math.round((ms % 3600000) / 60000);
    text = `昨晚睡了 ${h} 小时 ${m} 分`;
    if (h < 7) text += ` · 比目标 7h 少 ${7 * 60 - (h * 60 + m)} 分钟`;
    else text += ' · 达标 ✅';
  } else if (day.sleepAt) {
    text = '还没记起床时间。';
  }

  host.appendChild(el('p', { class: 'sum-note', text }));
}

/* ═══ ⑤ 全天专注时间线 ═══════════════════════════════════ */

function renderDayTimeline() {
  const host = $('sumTimeline');
  host.textContent = '';

  const startMin = toMin(DAY_START);
  const endMin = toMin(DAY_END);
  const span = endMin - startMin;
  const W = 1000, H = 30;

  const segs = (cur.focus && cur.focus.segments) || [];
  if (!segs.length) {
    host.appendChild(el('p', { class: 'sum-empty', text: '这天没有专注时段。' }));
    return;
  }

  const toX = (ts) => {
    const m = dayMinutes(ts);
    return Math.max(0, Math.min(W, ((m - startMin) / span) * W));
  };

  const svg = svgEl('svg', {
    viewBox: `0 0 ${W} ${H}`,
    preserveAspectRatio: 'none',
    class: 'day-tl',
  });

  /* 背景刻度：每 3 小时一条淡线 */
  for (let m = startMin; m <= endMin; m += 180) {
    const x = ((m - startMin) / span) * W;
    svg.appendChild(svgEl('line', {
      x1: x.toFixed(1), y1: 0, x2: x.toFixed(1), y2: H,
      class: 'day-tl-tick',
    }));
  }

  for (const s of segs) {
    const x1 = toX(s.from);
    /* 给一个最小宽度：不然很短的会话（几秒钟）会被压成 0 像素凭空消失。
       宁可画成一根细线，也不能让记录看不见。 */
    const w = Math.max(2.5, toX(s.to) - x1);
    const x = Math.min(x1, W - w);
    svg.appendChild(svgEl('rect', {
      x: x.toFixed(1), y: 4,
      width: w.toFixed(1), height: H - 8,
      rx: 3,
      class: 'day-tl-focus',
    }));
  }

  /* 今天的话标一条「现在」 */
  if (cur.date === todayKey()) {
    const x = toX(Date.now());
    svg.appendChild(svgEl('line', {
      x1: x.toFixed(1), y1: 0, x2: x.toFixed(1), y2: H,
      class: 'day-tl-now',
    }));
  }

  host.appendChild(svg);

  const axis = el('div', { class: 'day-tl-axis' });
  for (let m = startMin; m <= endMin; m += 180) {
    const d = new Date();
    d.setHours(Math.floor(m / 60), m % 60, 0, 0);
    axis.appendChild(el('span', { text: `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}` }));
  }
  host.appendChild(axis);
}

/* ═══ 装配 ═══════════════════════════════════════════════ */

function renderAll() {
  const d = cur.date;
  $('sumDate').textContent = `${fmtMain(d)} · ${dowLong(d)}`;
  $('sumTitle').textContent = d === todayKey() ? '今日总结' : '这天的小结';
  renderDonut();
  renderBlocks();
  renderHabits();
  renderSleep();
  renderDayTimeline();
}

export async function openSummary(date, day) {
  cur.date = date;
  cur.day = day;
  cur.sessions = await sessionsForDate(date);
  const clean = cur.sessions.map(s => ({ ...s, away: s.away || [] }));
  cur.focus = dayFocus(clean);
  cur.perBlock = byBlock(clean);
  renderAll();
  showLayer();
}

export async function refreshSummary() {
  if (!cur.date) return;
  cur.sessions = await sessionsForDate(cur.date);
  const clean = cur.sessions.map(s => ({ ...s, away: s.away || [] }));
  cur.focus = dayFocus(clean);
  cur.perBlock = byBlock(clean);
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

  /* 右划关掉（和进来是同一个手势方向，顺手） */
  attachSwipe($('summaryLayer'), {
    onRight: () => closeSummary(),
    onLeft: () => closeSummary(),
  });
}
