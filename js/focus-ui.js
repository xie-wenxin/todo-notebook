/* ═══════════════════════════════════════════════════════════
   focus-ui.js — 专注面板（左划进来）
   计时和账本全部交给 focus.js，这里只负责画和手势。

   三个状态：
     idle     还没开始，圆环写着「长按开始」
     running  正在计时，同一个圆环写着「长按 15 秒退出」
     done     结算卡片

   为什么退出要长按 15 秒：这是你要的「隐形锁机」。PWA 拦不住你
   按 Home 键，但可以让「逃出去」这件事变得足够麻烦。而且逃走会被
   记进离开账本，有效时长直接变少 —— 代价是真的。
   ═══════════════════════════════════════════════════════════ */

import {
  TEMPLATE, blockPhase, todayKey, findRunningSession, putSession, newId,
} from './store.js';
import * as F from './focus.js';
import { el, svgEl } from './render.js';
import { attachSwipe } from './gestures.js';

const START_HOLD_MS = 1500;
const EXIT_HOLD_MS = 15000;
const RING_R = 52;
const RING_C = 2 * Math.PI * RING_R;

let deps = {
  toast: () => {},
  onChange: () => {},
  getDate: () => todayKey(),
};
let session = null;
let state = 'idle';
let pickedBlockId = null;
let pickedTodoId = null;
let pickedLabel = '';
let tickHandle = null;
let tickCount = 0;
let lastPersist = 0;
let lightsOff = false;

const $ = (id) => document.getElementById(id);

/* ── 小工具 ────────────────────────────────────────────── */

function clockText(ms) {
  const t = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = t % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function blockById(id) {
  return TEMPLATE.find(b => b.id === id) || null;
}

function defaultBlockId() {
  const now = TEMPLATE.find(b => blockPhase(b) === 1);
  if (now) return now.id;
  const next = TEMPLATE.find(b => blockPhase(b) === 2);
  if (next) return next.id;
  return TEMPLATE[0].id;
}

function currentBlock() {
  return blockById(session ? session.blockId : pickedBlockId);
}

/* ═══ 长按圆环 ═══════════════════════════════════════════ */

let holdTimer = null;
let holdStart = 0;
let holdNeed = START_HOLD_MS;
let holdDone = null;

function ringSet(progress) {
  const fg = $('fRingFg');
  if (!fg) return;
  const p = Math.max(0, Math.min(1, progress));
  fg.setAttribute('stroke-dasharray', String(RING_C));
  fg.setAttribute('stroke-dashoffset', String(RING_C * (1 - p)));
  const hold = $('fHold');
  if (hold) hold.classList.toggle('holding', p > 0.001);

  if (state === 'running') {
    const left = Math.max(0, Math.ceil((1 - p) * (holdNeed / 1000)));
    $('fHoldText').textContent = p > 0.001 ? `松手作废 · 还剩 ${left} 秒` : '长按 15 秒退出';
  } else {
    $('fHoldText').textContent = p > 0.001 ? '继续按住…' : '长按开始';
  }
}

function holdBegin(e) {
  if (state === 'done') return;
  if (e.pointerType === 'mouse' && e.button !== 0) return;
  e.preventDefault();
  holdStart = Date.now();
  holdDone = state === 'running' ? endAndShowResult : startSession;
  holdNeed = state === 'running' ? EXIT_HOLD_MS : START_HOLD_MS;

  clearInterval(holdTimer);
  holdTimer = setInterval(() => {
    const p = (Date.now() - holdStart) / holdNeed;
    ringSet(p);
    if (p >= 1) {
      clearInterval(holdTimer);
      holdTimer = null;
      const fn = holdDone;
      holdDone = null;
      holdStart = 0;
      ringSet(0);
      if (fn) fn();
    }
  }, 33);
}

function holdEnd() {
  if (!holdTimer) { ringSet(0); return; }
  clearInterval(holdTimer);
  holdTimer = null;
  holdDone = null;
  holdStart = 0;
  ringSet(0);
}

/* ═══ 会话生命周期 ═══════════════════════════════════════ */

async function persist() {
  if (!session) return;
  session.lastTick = Date.now();
  await putSession(F.toRecord(session));
}

async function startSession() {
  const block = currentBlock();
  session = F.createSession({
    id: 's' + newId(),
    date: deps.getDate(),
    blockId: block ? block.id : null,
    todoId: pickedTodoId,
    label: pickedLabel || (block ? block.title : '自由专注'),
    startedAt: Date.now(),
    strict: !!deps.getStrict?.(),
  });
  state = 'running';
  lastPersist = Date.now();
  await persist();
  startTick();
  render();
  deps.toast(strictNow() ? '严格模式：一离开就作废' : '开始专注', 2000);
}

function strictNow() {
  return !!(session && session.strict);
}

async function endAndShowResult() {
  if (!session || session.endedAt) return;
  F.endSession(session, Date.now());
  stopTick();
  await persist();
  state = 'done';
  render();
  deps.onChange();
}

function discardSession() {
  /* 用于「还没开始就关掉」 */
  session = null;
  state = 'idle';
  stopTick();
}

function startTick() {
  stopTick();
  tickCount = 0;
  tickHandle = setInterval(async () => {
    if (!session || session.endedAt) return;
    tickCount++;
    renderClock();
    if (tickCount % 5 === 0) {
      renderStats();
      renderTimeline();
    }
    const now = Date.now();
    if (now - lastPersist > 20000) { lastPersist = now; await persist(); }
  }, 1000);
}

function stopTick() {
  if (tickHandle) clearInterval(tickHandle);
  tickHandle = null;
}

/* ═══ 渲染 ═══════════════════════════════════════════════ */

function renderClock() {
  if (!session) return;
  const r = F.summarize(session);
  $('fClock').textContent = clockText(r.totalMs);
}

function statChip(label, value, cls = '') {
  return el('div', { class: 'f-stat ' + cls }, [
    el('span', { class: 'f-stat-v', text: value }),
    el('span', { class: 'f-stat-l', text: label }),
  ]);
}

function renderStats() {
  const host = $('fStats');
  host.textContent = '';
  if (!session) return;

  const r = F.summarize(session);

  if (state === 'running') {
    host.appendChild(statChip('总时长', F.fmtMs(r.totalMs)));
    host.appendChild(statChip('有效专注', F.fmtMs(r.effectiveMs), 'good'));
    host.appendChild(statChip('离开', r.awayCount ? `${r.awayCount} 次` : '没有', r.awayCount ? 'warn' : ''));
    host.appendChild(statChip('占比', F.pct(r.ratio), r.ratio >= 0.85 ? 'good' : 'warn'));
  } else {
    host.appendChild(statChip('本次有效', F.fmtMs(r.effectiveMs), 'good'));
    host.appendChild(statChip('总时长', F.fmtMs(r.totalMs)));
    host.appendChild(statChip('离开', r.awayCount ? `${r.awayCount} 次 / ${F.fmtMs(r.awayMs)}` : '没有', r.awayCount ? 'warn' : ''));
    host.appendChild(statChip('专注度', F.pct(r.ratio), r.ratio >= 0.85 ? 'good' : 'warn'));
    if (r.unknownMs > 0) {
      host.appendChild(statChip('其中不明', F.fmtMs(r.unknownMs), 'warn'));
    }
  }
}

function renderTimeline() {
  const host = $('fTimeline');
  host.textContent = '';
  if (!session) return;

  const r = F.summarize(session);
  if (!r.totalMs) return;

  const W = 1000, H = 30;
  const svg = svgEl('svg', {
    viewBox: `0 0 ${W} ${H}`,
    preserveAspectRatio: 'none',
    class: 'f-tl-svg',
  });

  for (const seg of r.segments) {
    const x = ((seg.from - r.startedAt) / r.totalMs) * W;
    const w = Math.max(1.5, (seg.ms / r.totalMs) * W);
    svg.appendChild(svgEl('rect', {
      x: x.toFixed(2), y: 0,
      width: w.toFixed(2), height: H,
      rx: 4,
      class: 'f-tl-' + seg.kind,
    }));
  }
  host.appendChild(svg);

  /* 头尾时间标注 */
  const from = new Date(r.startedAt);
  const to = new Date(r.endedAt ?? Date.now());
  const hm = (d) => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  host.appendChild(el('div', { class: 'f-tl-axis' }, [
    el('span', { text: hm(from) }),
    el('span', { text: '完整时间线' }),
    el('span', { text: hm(to) }),
  ]));
}

function render() {
  const layer = $('focusLayer');
  const block = currentBlock();

  /* 如果是从某一条待办左划进来的，标题就显示那条待办本身 */
  const todoLabel = session ? (session.todoId ? session.label : '') : pickedLabel;
  if (todoLabel) {
    $('fBlockName').textContent = todoLabel;
    $('fBlockSub').textContent = block ? block.title : '';
  } else {
    $('fBlockName').textContent = block ? block.title : '自由专注';
    $('fBlockSub').textContent = block ? (block.sub || '') : '没挂到时间块上';
  }
  $('fBlockTime').textContent = block ? `${block.start} – ${block.end}` : '';

  layer.classList.toggle('lights-off', lightsOff);
  layer.classList.toggle('is-running', state === 'running');
  layer.classList.toggle('is-done', state === 'done');

  if (state === 'idle') {
    $('fClock').textContent = '00:00:00';
    $('fHint').textContent = '长按下面的圆环开始';
    $('fHold').hidden = false;
    $('fFoot').hidden = false;
    $('fPick').disabled = false;
    $('fPick').style.opacity = '';
    $('fStats').textContent = '';
    $('fTimeline').textContent = '';
    $('fDoneBtn').hidden = true;
    ringSet(0);
    return;
  }

  if (state === 'running') {
    $('fHint').textContent = strictNow()
      ? '严格模式 · 离开即作废'
      : '息屏也会继续记 · 回来接着算';
    $('fHold').hidden = false;
    $('fFoot').hidden = false;
    $('fPick').disabled = true;
    $('fPick').style.opacity = '.35';
    $('fDoneBtn').hidden = true;
    renderClock();
    renderStats();
    renderTimeline();
    ringSet(0);
    return;
  }

  /* done */
  const r = F.summarize(session);
  $('fClock').textContent = F.fmtMs(r.effectiveMs);
  $('fHint').textContent = '本次专注';
  $('fHold').hidden = true;
  $('fFoot').hidden = true;
  $('fDoneBtn').hidden = false;
  renderStats();
  renderTimeline();
}

/* ═══ 时间块选择 ═════════════════════════════════════════ */

function renderPicker() {
  const host = $('fPicker');
  host.textContent = '';
  host.appendChild(el('div', { class: 'f-pick-title', text: '在哪个时间段专注' }));

  for (const b of TEMPLATE) {
    const phase = blockPhase(b);
    const btn = el('button', {
      type: 'button',
      class: 'f-pick-item'
        + (b.id === pickedBlockId ? ' on' : '')
        + (phase === 1 ? ' now' : ''),
      'data-id': b.id,
    }, [
      el('span', { class: 'f-pick-time', text: `${b.start}–${b.end}` }),
      el('span', { class: 'f-pick-name', text: b.title }),
      phase === 1 ? el('span', { class: 'f-pick-now', text: '现在' }) : null,
    ]);
    btn.addEventListener('click', () => {
      pickedBlockId = b.id;
      pickedTodoId = null;
      pickedLabel = '';
      $('fPicker').hidden = true;
      render();
    });
    host.appendChild(btn);
  }
}

/* ═══ 开关 ═══════════════════════════════════════════════ */

function showLayer() {
  const layer = $('focusLayer');
  layer.hidden = false;
  requestAnimationFrame(() => requestAnimationFrame(() => layer.classList.add('show')));
}

function hideLayer() {
  const layer = $('focusLayer');
  layer.classList.remove('show');
  setTimeout(() => { layer.hidden = true; }, 300);
}

/** 左划进来的时候调用。从某条待办左划的话会带上 todoId 和文字 */
export async function openFocus(blockId, todoId, label) {
  if (session && !session.endedAt) {
    /* 正在计时，直接回到面板 */
    state = 'running';
    startTick();
    showLayer();
    render();
    return;
  }
  /* 上一次的结算卡不算数了，重新开一张 */
  session = null;
  state = 'idle';
  pickedBlockId = blockId || defaultBlockId();
  pickedTodoId = todoId || null;
  pickedLabel = String(label || '').trim();
  showLayer();
  render();
}

export function isFocusOpen() {
  const layer = $('focusLayer');
  return !!layer && !layer.hidden && layer.classList.contains('show');
}

export function isFocusRunning() {
  return !!(session && !session.endedAt);
}

/** 页面被杀掉之后，接着上次的会话继续 */
export async function resumeIfAny() {
  const rec = await findRunningSession();
  if (!rec) return null;

  const s = F.fromRecord(rec);
  const now = Date.now();
  const sameDay = s.date === todayKey();
  const fresh = now - s.startedAt < 12 * 3600 * 1000;

  if (!sameDay || !fresh) {
    /* 太久远了，直接封存，不打扰你 */
    F.endSession(s, s.lastTick || s.startedAt);
    await putSession(F.toRecord(s));
    return null;
  }

  if (F.isAway(s)) {
    /* 离开期间页面被回收 —— 那段时间本来就在离开区间里，闭合它就行 */
    F.markBack(s, now);
  } else {
    /* 页面可见时被回收的，中间那段落不明，诚实记成未知 */
    const gap = now - (s.lastTick || s.startedAt);
    if (gap > 5000) F.addUnknown(s, gap);
  }

  s.lastTick = now;
  session = s;
  state = 'running';
  await persist();
  startTick();
  showLayer();
  render();
  deps.toast('接着上次的专注继续', 2400);
  return s;
}

/* ═══ 接线 ═══════════════════════════════════════════════ */

let wired = false;

export function initFocus(options = {}) {
  Object.assign(deps, options);
  if (wired) return;
  wired = true;

  const hold = $('fHold');
  hold.addEventListener('pointerdown', holdBegin);
  ['pointerup', 'pointercancel', 'pointerleave'].forEach((ev) => {
    hold.addEventListener(ev, holdEnd);
  });
  /* 长按到底时浏览器可能弹菜单，直接灭掉 */
  hold.addEventListener('contextmenu', (e) => e.preventDefault());

  $('fLights').addEventListener('click', () => {
    lightsOff = !lightsOff;
    $('fLights').textContent = lightsOff ? '☀️ 开灯' : '🌙 熄灯';
    render();
  });

  $('fPick').addEventListener('click', () => {
    if (state === 'running') return;
    renderPicker();
    $('fPicker').hidden = !$('fPicker').hidden;
  });

  $('fDoneBtn').addEventListener('click', () => {
    session = null;
    state = 'idle';
    lightsOff = false;
    $('fLights').textContent = '🌙 熄灯';
    hideLayer();
  });

  /* 还没开始时可以随时退出去：点左上角，或者往右划 */
  $('fClose').addEventListener('click', () => closeFocus());

  attachSwipe($('focusLayer'), {
    onRight: () => closeFocus(),
    disabled: () => state === 'running',
  });

  /* 页面切走 / 回来 —— 这是「息屏照走」的关键两行 */
  document.addEventListener('visibilitychange', async () => {
    if (!session || session.endedAt) return;
    const now = Date.now();
    if (document.visibilityState === 'hidden') {
      F.markAway(session, now);
    } else {
      F.markBack(session, now);
    }
    await persist();
    renderStats();
    renderTimeline();
  });

  /* 页面即将被关闭 —— 尽量把状态落盘 */
  window.addEventListener('pagehide', () => { persist(); });
}

/** 退出专注面板。正在计时的话不许走（唯一的出口是长按 15 秒）。 */
export function closeFocus() {
  if (state === 'running') return false;
  session = null;
  state = 'idle';
  lightsOff = false;
  const lights = $('fLights');
  if (lights) lights.textContent = '🌙 熄灯';
  hideLayer();
  return true;
}
