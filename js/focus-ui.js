/* ═══════════════════════════════════════════════════════════
   focus-ui.js — 专注页（左划进来）

   版面就三块，排满，不写废话：
     ① 最上面一行：时间块名 + 时间段
     ② 中间：待办名 + 大计时器（挨在一起）
     ③ 底部：五个小圆圈 —— 🫘 查题 · 📴 息屏 · 🌙 熄灯 · ⏱ 倒计时 · ✕ 退出

   退出必须长按 15 秒；松手就归零重来。满 15 秒会强制你写一句话总结。

   计时和账本全在 focus.js，这里只管画和手势。
   ═══════════════════════════════════════════════════════════ */

import {
  TEMPLATE, blockPhase, todayKey, findRunningSession, putSession, newId,
} from './store.js';
import * as F from './focus.js';
import { el } from './render.js';
import { attachSwipe } from './gestures.js';

const START_HOLD_MS = 1200;
const EXIT_HOLD_MS = 15000;

/* 倒计时可选值：5 的倍数 */
const COUNTDOWNS = [5, 10, 15, 20, 25, 30, 45, 60];

let deps = { toast: () => {}, onChange: () => {}, getDate: () => todayKey() };

let session = null;          // 当前会话（没开始就是 null）
let state = 'idle';          // idle | running | note | done
let pickedBlockId = null;
let pickedTodoId = null;
let pickedLabel = '';

let tickHandle = null;
let tickCount = 0;
let lastPersist = 0;
let lightsOff = false;

/* 倒计时 */
let cdEndAt = null;
let cdDone = false;

let holdTimer = null;
let holdStart = 0;
let holdNeed = 0;
let holdDone = null;

const $ = (id) => document.getElementById(id);

/* ── 小工具 ────────────────────────────────────────────── */

function clockText(ms) {
  const t = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = t % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function mmss(ms) {
  const t = Math.max(0, Math.ceil(ms / 1000));
  return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
}

function blockById(id) { return TEMPLATE.find(b => b.id === id) || null; }

function defaultBlockId() {
  const now = TEMPLATE.find(b => blockPhase(b) === 1);
  if (now) return now.id;
  const next = TEMPLATE.find(b => blockPhase(b) === 2);
  return next ? next.id : TEMPLATE[0].id;
}

function currentBlock() {
  return blockById(session ? session.blockId : pickedBlockId);
}

/* ── 蜂鸣 + 震动（倒计时到点时） ───────────────────────── */

let audioCtx = null;

function chime() {
  try {
    if (navigator.vibrate) navigator.vibrate([180, 90, 180]);
  } catch { /* 不支持就算了 */ }

  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    if (!audioCtx) audioCtx = new AC();
    if (audioCtx.state === 'suspended') audioCtx.resume();

    const t0 = audioCtx.currentTime;
    [880, 1174.7].forEach((freq, i) => {
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      const at = t0 + i * 0.28;
      gain.gain.setValueAtTime(0.0001, at);
      gain.gain.exponentialRampToValueAtTime(0.28, at + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.42);
      osc.connect(gain).connect(audioCtx.destination);
      osc.start(at);
      osc.stop(at + 0.5);
    });
  } catch { /* 没声音也不影响计时 */ }
}

/* ── 长按（开始 / 退出共用一个） ───────────────────────── */

function holdBegin(e) {
  if (state !== 'idle' && state !== 'running') return;
  if (e.pointerType === 'mouse' && e.button !== 0) return;
  e.preventDefault();

  holdStart = Date.now();
  holdDone = state === 'running' ? askNote : startSession;
  holdNeed = state === 'running' ? EXIT_HOLD_MS : START_HOLD_MS;

  clearInterval(holdTimer);
  holdTimer = setInterval(() => {
    const p = (Date.now() - holdStart) / holdNeed;
    paintHold(p);
    if (p >= 1) {
      clearInterval(holdTimer);
      holdTimer = null;
      const fn = holdDone;
      holdDone = null;
      holdStart = 0;
      paintHold(0);
      if (fn) fn();
    }
  }, 40);
}

function holdEnd() {
  if (!holdTimer) { paintHold(0); return; }
  clearInterval(holdTimer);
  holdTimer = null;
  holdDone = null;
  holdStart = 0;
  paintHold(0);
}

/** 长按进度画在那个小圆里，不再用大圆环 */
function paintHold(p) {
  const btn = holdNeed === EXIT_HOLD_MS ? $('fExit') : $('fStart');
  const other = holdNeed === EXIT_HOLD_MS ? $('fStart') : $('fExit');
  if (other) { other.style.background = ''; }
  if (!btn) return;

  const v = Math.max(0, Math.min(1, p));
  if (v <= 0.001) {
    btn.style.background = '';
    btn.textContent = btn.dataset.icon || btn.textContent;
    return;
  }
  btn.style.background = `conic-gradient(var(--accent) ${(v * 100).toFixed(1)}%, transparent 0)`;
  if (holdNeed === EXIT_HOLD_MS) {
    btn.textContent = String(Math.ceil((1 - v) * (EXIT_HOLD_MS / 1000)));
  }
}

/* ── 会话生命周期 ──────────────────────────────────────── */

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
    label: pickedLabel || (block ? block.title : '专注'),
    startedAt: Date.now(),
  });
  state = 'running';
  lastPersist = Date.now();
  await persist();
  startTick();
  render();
}

/** 长按 15 秒满了 —— 强制写一句话 */
function askNote() {
  if (!session) return;
  F.endSession(session, Date.now());
  stopTick();
  persist();
  state = 'note';
  render();
  const ta = $('fNoteText');
  ta.value = '';
  setTimeout(() => ta.focus(), 140);
}

async function finishWithNote() {
  if (!session) { closeLayerAndReset(); return; }
  session.note = ($('fNoteText').value || '').trim();
  await persist();
  state = 'done';
  render();
  deps.onChange();
}

function startTick() {
  stopTick();
  tickCount = 0;
  tickHandle = setInterval(async () => {
    if (!session || session.endedAt) return;
    tickCount++;
    renderClock();

    /* 倒计时到点：响一声，但**不退出专注**，继续正计时 */
    if (cdEndAt && !cdDone && Date.now() >= cdEndAt) {
      cdDone = true;
      chime();
      F.stopMark(session, 'countdown', cdEndAt);
      cdEndAt = null;
      await persist();
      deps.toast('倒计时结束 · 继续', 2400);
    }

    if (tickCount % 5 === 0) renderStats();
    const now = Date.now();
    if (now - lastPersist > 20000) { lastPersist = now; await persist(); }
  }, 1000);
}

function stopTick() {
  if (tickHandle) clearInterval(tickHandle);
  tickHandle = null;
}

/* ── 渲染 ──────────────────────────────────────────────── */

function renderClock() {
  if (!session) return;
  $('fClock').textContent = clockText(F.summarize(session).totalMs);
  renderCdLine();
}

function renderCdLine() {
  const line = $('fCdLine');
  if (cdEndAt) {
    line.hidden = false;
    line.textContent = '⏱ ' + mmss(cdEndAt - Date.now());
  } else {
    line.hidden = true;
  }
}

function renderStats() {
  /* 这个页面不放统计 —— 统计去日总结看 */
  const marks = session ? (session.marks || []) : [];
  const on = (k) => marks.some(m => m.kind === k && m.to === null);
  $('fLookup').classList.toggle('on', on('lookup'));
  $('fScreen').classList.toggle('on', on('screenoff'));
}

function render() {
  const layer = $('focusLayer');
  const block = currentBlock();
  const todoLabel = session ? (session.todoId ? session.label : '') : pickedLabel;

  /* ① 最上面一行：块名 + 时间段 */
  $('fBlockName').textContent = block ? block.title : '专注';
  $('fBlockTime').textContent = block ? `${block.start}–${block.end}` : '';

  /* ② 中间：待办名 + 计时器 */
  const label = todoLabel || (block ? block.title : '');
  const nameEl = $('fTodoName');
  nameEl.textContent = label;
  nameEl.hidden = !label;

  layer.classList.toggle('lights-off', lightsOff);
  layer.classList.toggle('is-running', state === 'running');
  layer.classList.toggle('is-note', state === 'note');
  layer.classList.toggle('is-idle', state === 'idle');

  $('fStart').hidden = state !== 'idle';
  $('fClock').hidden = state === 'idle' || state === 'note';
  $('fCdLine').hidden = true;
  $('fBar').hidden = state === 'note' || state === 'done';
  $('fNote').hidden = state !== 'note';
  $('fCdPicker').hidden = true;

  if (state === 'running') {
    renderClock();
    renderStats();
  }

  if (state === 'done') {
    $('fClock').hidden = false;
    $('fClock').textContent = '✓';
    setTimeout(closeLayerAndReset, 800);
  }

  if (state === 'idle') {
    cdEndAt = null; cdDone = false;
    $('fLookup').classList.remove('on');
    $('fScreen').classList.remove('on');
    $('fLights').classList.remove('on');
  }
}

function renderCountdownPicker() {
  const host = $('fCdPicker');
  host.textContent = '';
  for (const min of COUNTDOWNS) {
    const b = el('button', { type: 'button', class: 'cd-item', 'data-min': min, text: String(min) });
    b.addEventListener('click', () => { startCountdown(min); host.hidden = true; });
    host.appendChild(b);
  }
  host.hidden = !host.hidden;
}

function startCountdown(min) {
  if (state !== 'running') return;
  const now = Date.now();
  if (cdEndAt) F.stopMark(session, 'countdown', now);   /* 上一段先收尾 */
  cdEndAt = now + min * 60000;
  cdDone = false;
  F.startMark(session, 'countdown', now);
  persist();
  renderCdLine();
  deps.toast(`倒计时 ${min} 分钟`, 1800);
}

/* ── 开关 ──────────────────────────────────────────────── */

function showLayer() {
  const layer = $('focusLayer');
  layer.hidden = false;
  requestAnimationFrame(() => requestAnimationFrame(() => layer.classList.add('show')));
}

function hideLayer() {
  const layer = $('focusLayer');
  layer.classList.remove('show');
  setTimeout(() => { layer.hidden = true; }, 280);
}

function closeLayerAndReset() {
  session = null;
  state = 'idle';
  lightsOff = false;
  cdEndAt = null; cdDone = false;
  hideLayer();
}

/** 左划进来 */
export async function openFocus(blockId, todoId, label) {
  if (session && !session.endedAt) {
    state = 'running';
    startTick();
    showLayer();
    render();
    return;
  }
  /* 上次的结果不算数了，重新开 */
  session = null;
  state = 'idle';
  pickedBlockId = blockId || defaultBlockId();
  pickedTodoId = todoId || null;
  pickedLabel = String(label || '').trim();
  cdEndAt = null; cdDone = false;
  lightsOff = false;
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

/** 页面被杀掉之后接着上次继续 */
export async function resumeIfAny() {
  const rec = await findRunningSession();
  if (!rec) return null;

  const s = F.fromRecord(rec);
  const now = Date.now();
  const sameDay = s.date === todayKey();
  const fresh = now - s.startedAt < 12 * 3600 * 1000;

  if (!sameDay || !fresh) {
    F.endSession(s, s.lastTick || s.startedAt);
    await putSession(F.toRecord(s));
    return null;
  }

  if (F.isAway(s)) {
    F.markBack(s, now);
  } else {
    /* 页面可见时被回收的，中间那段落不明 */
    const gap = now - (s.lastTick || s.startedAt);
    if (gap > 5000) F.addUnknown(s, gap);
  }

  s.lastTick = now;
  session = s;
  state = 'running';
  cdEndAt = null; cdDone = true;
  await persist();
  startTick();
  showLayer();
  render();
  return s;
}

export function closeFocus() {
  if (state === 'running') return false;
  closeLayerAndReset();
  return true;
}

/* ── 接线 ──────────────────────────────────────────────── */

let wired = false;

export function initFocus(options = {}) {
  Object.assign(deps, options);
  if (wired) return;
  wired = true;

  const startBtn = $('fStart');
  startBtn.dataset.icon = '▶';
  startBtn.addEventListener('pointerdown', holdBegin);
  ['pointerup', 'pointercancel', 'pointerleave'].forEach(ev => startBtn.addEventListener(ev, holdEnd));

  const exitBtn = $('fExit');
  exitBtn.dataset.icon = '✕';
  exitBtn.addEventListener('pointerdown', holdBegin);
  ['pointerup', 'pointercancel', 'pointerleave'].forEach(ev => exitBtn.addEventListener(ev, holdEnd));
  exitBtn.addEventListener('contextmenu', e => e.preventDefault());
  startBtn.addEventListener('contextmenu', e => e.preventDefault());

  /* 🫘 查题：点了之后切页面依然算专注，时间线上涂蓝 */
  $('fLookup').addEventListener('click', () => {
    if (state !== 'running') return;
    const on = F.toggleMark(session, 'lookup', Date.now());
    persist();
    renderStats();
    deps.toast(on ? '在查题 · 切页面也算专注' : '回到专注', 2200);
  });

  /* 📴 息屏：点了之后自己去锁屏，这段时间算专注（绿色） */
  $('fScreen').addEventListener('click', () => {
    if (state !== 'running') return;
    const on = F.toggleMark(session, 'screenoff', Date.now());
    persist();
    renderStats();
    deps.toast(on ? '去锁屏吧 · 这段算专注' : '息屏结束', 2200);
  });

  /* 🌙 熄灯 */
  $('fLights').addEventListener('click', () => {
    lightsOff = !lightsOff;
    $('fLights').classList.toggle('on', lightsOff);
    render();
  });

  /* ⏱ 倒计时 */
  $('fCd').addEventListener('click', () => {
    if (state !== 'running') return;
    renderCountdownPicker();
  });

  /* 总结对话框：只有一个输入框 + 一个 ✓，不加任何字 */
  $('fNoteOk').addEventListener('click', finishWithNote);
  $('fNoteText').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); finishWithNote(); }
  });

  /* 回到前台 —— 息屏状态自动结束 */
  document.addEventListener('visibilitychange', async () => {
    if (!session || session.endedAt) return;
    const now = Date.now();
    if (document.visibilityState === 'hidden') {
      F.markAway(session, now);
    } else {
      F.markBack(session, now);
      /* 你说过：再打开这个页面，息屏状态自动结束 */
      if (F.markOpen(session, 'screenoff')) {
        F.stopMark(session, 'screenoff', now);
        deps.toast('息屏结束 · 继续', 1800);
      }
      renderCdLine();
    }
    await persist();
    renderStats();
  });

  window.addEventListener('pagehide', () => { persist(); });

  /* 右划在还没开始时可以退出去 */
  attachSwipe($('focusLayer'), {
    onRight: () => closeFocus(),
    disabled: () => state === 'running',
  });
}
