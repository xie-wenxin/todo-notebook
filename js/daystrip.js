/* ═══════════════════════════════════════════════════════════
   daystrip.js — 周历（一周一行，一路滑到底就是全部历史）+ 习惯周表

   为什么要能一直往下滑：这个本子最初的目的就是**看见自己坚持了多少天**。
   所以不再是一页 9 天、左右翻页，而是一条连续的时间线：
     一行 = 一周（周一到周日）
     最新的在最上面，往下滑就是往回看
     滑到底 = 你记录的第一天

   性能：一周 7 个格子，一年就是 52 行。一次全渲染会卡，
   所以按批追加（先 14 行，滑到底再加 14 行）。
   ═══════════════════════════════════════════════════════════ */

import {
  blankDay, addDays, todayKey, dateKey, fromKey,
  dowShort, dayNum, fmtMain, themeById,
  HABITS, TARGET_HOURS,
} from './store.js';
import { dayFocus } from './focus.js';
import { themeForDay } from './theme.js';
import { el } from './render.js';
import { idbAll } from './db.js';

const NS = 'http://www.w3.org/2000/svg';
function svg(tag, attrs) {
  const n = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, String(v));
  return n;
}

const DOW = ['一', '二', '三', '四', '五', '六', '日'];
const BATCH = 14;          // 一次追加多少周
const MAX_WEEKS = 520;     // 十年，够用了

/* ── 日期工具 ──────────────────────────────────────────── */

/** 这一天所在周的周一 */
export function weekStartKey(date) {
  const d = fromKey(date);
  const back = (d.getDay() + 6) % 7;   // 周一 = 0
  d.setDate(d.getDate() - back);
  return dateKey(d);
}

/** 「9/15」这种短标签 */
function shortDate(key) {
  const d = fromKey(key);
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

/** 这一天有没有东西 —— 决定历史从哪天开始 */
function hasContent(d) {
  if (!d) return false;
  if (d.todos && Object.keys(d.todos).some(k => (d.todos[k] || []).length)) return true;
  if (d.habits && Object.values(d.habits).some(Boolean)) return true;
  if (d.diary && String(d.diary.text || '').trim()) return true;
  if (Array.isArray(d.photos) && d.photos.length) return true;
  if (d.sleepAt || d.wakeAt) return true;
  return false;
}

/* ── 载入全部历史 ──────────────────────────────────────── */

let hist = { dayMap: new Map(), focusMs: new Map(), oldest: null, weeks: [] };
let opts = null;
let shown = 0;

/**
 * 一次性把 days 和 sessions 两张表全读出来，在内存里按日期分组。
 * 比「每天查一次」快得多 —— 一年就是 365 次 vs 1 次。
 */
export async function loadHistory() {
  const [days, sessions] = await Promise.all([idbAll('days'), idbAll('sessions')]);

  const dayMap = new Map();
  let oldest = null;

  for (const d of days) {
    if (!d || !d.date) continue;
    dayMap.set(d.date, d);
    if (hasContent(d) && (!oldest || d.date < oldest)) oldest = d.date;
  }

  const byDate = new Map();
  for (const s of sessions) {
    if (!s || !s.date) continue;
    if (!byDate.has(s.date)) byDate.set(s.date, []);
    byDate.get(s.date).push({ ...s, away: s.away || [] });
    if (!oldest || s.date < oldest) oldest = s.date;
  }

  const focusMs = new Map();
  for (const [date, list] of byDate) focusMs.set(date, dayFocus(list).effectiveMs);

  hist = { dayMap, focusMs, oldest, weeks: [] };
  return hist;
}

/** 从本周往回排，weeks[0] 是本周（最新的在最上面） */
function buildWeeks(oldest) {
  const endMon = weekStartKey(todayKey());
  const startMon = oldest ? weekStartKey(oldest) : endMon;

  const weeks = [];
  let m = endMon;
  let guard = 0;
  while (m >= startMon && guard < MAX_WEEKS) {
    weeks.push({
      start: m,
      dates: Array.from({ length: 7 }, (_, i) => addDays(m, i)),
    });
    m = addDays(m, -7);
    guard++;
  }
  return weeks;
}

/* ── 一个格子 ──────────────────────────────────────────── */

function dayCell(date, o) {
  const day = hist.dayMap.get(date) || blankDay(date);
  const t = themeById(themeForDay(day, o.settings));
  const today = todayKey();

  const cell = el('button', {
    class: 'cell'
      + (date === today ? ' today' : '')
      + (date > today ? ' future' : '')
      + (date === o.selectedDate ? ' sel' : ''),
    type: 'button',
    'data-date': date,
    style: `background:${t.paper};color:${t.ink};`,
  });

  cell.appendChild(el('span', { class: 'cell-day', text: String(dayNum(date)) }));

  /* 圆环有两种读法 */
  let ratio, label;
  if (o.mode === 'focus') {
    const ms = hist.focusMs.get(date) || 0;
    ratio = Math.max(0, Math.min(1, ms / (TARGET_HOURS * 3600000)));
    label = ms > 0
      ? (ms >= 3600000 ? (ms / 3600000).toFixed(1) + 'h' : Math.round(ms / 60000) + 'm')
      : '';
    cell.setAttribute('aria-label', `${fmtMain(date)} 专注 ${label || 0}`);
  } else {
    /* 用 dayProgress 的口径算待办完成度 */
    let total = 0, done = 0;
    for (const list of Object.values(day.todos || {})) {
      total += list.length;
      done += list.filter(x => x.done).length;
    }
    ratio = total ? done / total : 0;
    label = total ? `${done}/${total}` : '';
    cell.setAttribute('aria-label', `${fmtMain(date)} 待办 ${label || '无'}`);
  }

  const R = 7;
  const C = 2 * Math.PI * R;
  const ring = svg('svg', { class: 'cell-ring', width: 18, height: 18, viewBox: '0 0 20 20' });
  ring.appendChild(svg('circle', { class: 'bg', cx: 10, cy: 10, r: R }));
  if (ratio > 0) {
    const fg = svg('circle', {
      class: 'fg', cx: 10, cy: 10, r: R,
      transform: 'rotate(-90 10 10)',
      'stroke-dasharray': `${(C * ratio).toFixed(2)} ${C.toFixed(2)}`,
    });
    fg.setAttribute('stroke', t.accent);
    ring.appendChild(fg);
  }
  cell.appendChild(ring);
  cell.appendChild(el('span', { class: 'cell-todos', text: label }));

  if (Array.isArray(day.photos) && day.photos.length) {
    cell.appendChild(el('span', { class: 'cell-photo', text: '📷' }));
  }

  return cell;
}

/* ── 一行 = 一周 ───────────────────────────────────────── */

function weekRow(week, o) {
  const today = todayKey();
  const isThisWeek = week.dates.includes(today);

  const row = el('div', { class: 'wk-row' + (isThisWeek ? ' this-week' : '') });

  row.appendChild(el('button', {
    class: 'wk-label',
    type: 'button',
    'data-date': week.start,
  }, [
    el('b', { text: shortDate(week.start) }),
    el('i', { text: shortDate(week.dates[6]) }),
  ]));

  for (const d of week.dates) {
    const c = dayCell(d, o);
    c.addEventListener('click', () => o.onPick(d));
    row.appendChild(c);
  }

  row.querySelector('.wk-label').addEventListener('click', () => o.onPick(week.dates[0]));

  return row;
}

/* ── 批量渲染 ──────────────────────────────────────────── */

export async function renderWeekList(host, options) {
  opts = options;
  host.textContent = '';
  shown = 0;

  await loadHistory();
  hist.weeks = buildWeeks(hist.oldest);

  appendWeeks(host, BATCH);

  /* 打开就停在最近这一周 —— 它在最上面，所以不用滚 */
  const scroller = host.parentElement;
  if (scroller) scroller.scrollTop = 0;

  return {
    weeks: hist.weeks.length,
    rendered: shown,
    oldest: hist.oldest,
  };
}

/** 追加下一批。滑到底时调用 */
export function appendWeeks(host, n = BATCH) {
  const end = Math.min(hist.weeks.length, shown + n);
  for (let i = shown; i < end; i++) {
    host.appendChild(weekRow(hist.weeks[i], opts));
  }
  shown = end;
  return { shown, total: hist.weeks.length, done: shown >= hist.weeks.length };
}

/** 还有没有没渲染的周 */
export function hasMoreWeeks() {
  return shown < hist.weeks.length;
}

/* ── 习惯周表 ──────────────────────────────────────────── */

/**
 * 行 = 习惯，列 = 周（越往右越近），格子里是「这周完成几天 / 这周已过几天」。
 * 一眼能看出哪个习惯在坚持、哪几周断了。
 */
export function renderHabitTable(host, totalsEl, options = {}) {
  host.textContent = '';
  const today = todayKey();

  /* 列：从早到晚，最新的在右边 */
  const weeks = [...hist.weeks].reverse();
  if (!weeks.length) return { weeks: 0 };

  const grid = el('div', { class: 'hx-grid' });

  /* 表头 */
  grid.appendChild(el('span', { class: 'hx-corner' }));
  for (const w of weeks) {
    grid.appendChild(el('span', {
      class: 'hx-head' + (w.dates.includes(today) ? ' today' : ''),
      text: shortDate(w.start),
    }));
  }

  const totals = new Map(HABITS.map(h => [h, 0]));

  for (const name of HABITS) {
    grid.appendChild(el('span', { class: 'hx-name', text: name }));

    for (const w of weeks) {
      /* 未来的日子不算进去，当前周的分母就是「已经过了几天」 */
      const active = w.dates.filter(d => d <= today);
      const done = active.filter((d) => {
        const day = hist.dayMap.get(d);
        return !!(day && day.habits && day.habits[name]);
      }).length;
      totals.set(name, totals.get(name) + done);

      const cls = 'hx-cell'
        + (done === 0 ? ' zero' : '')
        + (active.length && done === active.length ? ' full' : '');
      grid.appendChild(el('span', {
        class: cls,
        title: `${shortDate(w.start)} 那一周：${name} 完成 ${done}/${active.length} 天`,
        text: active.length ? `${done}/${active.length}` : '',
      }));
    }
  }

  host.appendChild(grid);

  /* 表格默认滚到最右边（最近这几周） */
  requestAnimationFrame(() => { host.scrollLeft = host.scrollWidth; });

  if (totalsEl) {
    const parts = HABITS.map(h => {
      const streak = habitStreak(h);
      return `${h} ${totals.get(h)} 天` + (streak > 1 ? ` · 连 ${streak} 天` : '');
    });
    totalsEl.textContent = parts.join('　');
  }

  return { weeks: weeks.length };
}

/** 从今天（或昨天）往回数，连续打卡了几天 */
function habitStreak(name) {
  const today = todayKey();
  let d = today;
  let n = 0;

  /* 今天还没打卡的话，从昨天开始数，免得白天看永远是 0 */
  const t = hist.dayMap.get(today);
  if (!(t && t.habits && t.habits[name])) d = addDays(today, -1);
  else n = 1, d = addDays(today, -1);

  let guard = 0;
  while (guard < 400) {
    const day = hist.dayMap.get(d);
    if (!(day && day.habits && day.habits[name])) break;
    n++;
    d = addDays(d, -1);
    guard++;
  }
  return n;
}

/* ── 顶部星期表头 ──────────────────────────────────────── */

export function buildWeekHead(host) {
  host.textContent = '';
  host.appendChild(el('span', { class: 'wk-label' }));
  for (const d of DOW) host.appendChild(el('span', { class: 'wk-dow', text: d }));
}
