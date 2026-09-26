/* ═══════════════════════════════════════════════════════════
   focus-ui.js — 专注页（左划进来）

   极简：
     最上面一行   块名 + 时间段
     中间         待办名 + 大计时器 + 一个大按钮
     最下面       🌙 熄灯 · ⏱ 倒计时
     结束时       强制写一句话

   开始 / 停止都是**点一下**那个大按钮。
   只要在计时，时间就算数 —— 切走、息屏一律不扣。
   ═══════════════════════════════════════════════════════════ */

import {
  TEMPLATE, blockPhase, todayKey, allSessions, putSession, newId,
} from './store.js';
import * as F from './focus.js';
import { el } from './render.js';
import { attachSwipe } from './gestures.js';

/* 倒计时可选值：5 的倍数 */
const COUNTDOWNS = [5, 10, 15, 20, 25, 30, 45, 60];

let deps = { toast: () => {}, onChange: () => {}, getDate: () => todayKey() };

let session = null;
let state = 'idle';          // idle | running | note | done
let pickedBlockId = null;
let pickedTodoId = null;
let pickedLabel = '';

let tickHandle = null;
let tickCount = 0;
let lastPersist = 0;
let lightsOff = false;
let busy = false;            // 防止连点两下 ▶ 造出两条会话

let cdEndAt = null;
let cdDone = false;

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
  try { if (navigator.vibrate) navigator.vibrate([180, 90, 180]); } catch { /* 不支持就算了 */ }

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

/* ── 会话 ──────────────────────────────────────────────── */

async function persist() {
  if (!session) return;
  session.lastTick = Date.now();
  await putSession(F.toRecord(session));
}

/**
 * 库里有没有「没结束、但不是当前这条」的会话？
 * 正常不会有。真出现了就说明上一步出过错 —— 两条计时器叠着算，
 * 时长会凭空变多，比少算还糟。所以开新的之前先把它们收掉。
 */
async function closeOrphans(keepId = null) {
  try {
    const all = await allSessions();
    for (const rec of all) {
      if (rec.endedAt || rec.id === keepId) continue;
      const o = F.fromRecord(rec);
      F.endSession(o, o.lastTick || o.startedAt);
      await putSession(F.toRecord(o));
    }
  } catch { /* 收不掉也不拦着开始计时 */ }
}

async function startSession() {
  if (busy) return;
  busy = true;
  try {
    await closeOrphans();

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
  } finally {
    busy = false;
  }
}

/** 点一下停止 —— 会话立刻结束，然后强制写一句话 */
async function stopSession() {
  if (busy) return;
  if (!session || session.endedAt) return;
  busy = true;
  try {
    F.endSession(session, Date.now());
    stopTick();
    await persist();
    state = 'note';
    render();
    const ta = $('fNoteText');
    ta.value = '';
    setTimeout(() => ta.focus(), 140);
  } finally {
    busy = false;
  }
}

async function finishWithNote() {
  if (!session) { closeLayerAndReset(); return; }
  session.note = ($('fNoteText').value || '').trim();
  await persist();
  state = 'done';
  render();
  deps.onChange();
  deps.toast('记下了 · ' + F.fmtDur(F.summarize(session).effectiveMs), 2600);
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

function render() {
  const layer = $('focusLayer');
  const block = currentBlock();
  const todoLabel = session ? (session.todoId ? session.label : '') : pickedLabel;

  /* 最上面一行：块名 + 时间段 */
  $('fBlockName').textContent = block ? block.title : '专注';
  $('fBlockTime').textContent = block ? `${block.start}–${block.end}` : '';

  const label = todoLabel || (block ? block.title : '');
  const nameEl = $('fTodoName');
  nameEl.textContent = label;
  nameEl.hidden = !label;

  layer.classList.toggle('lights-off', lightsOff);
  layer.classList.toggle('is-running', state === 'running');
  layer.classList.toggle('is-note', state === 'note');
  layer.classList.toggle('is-idle', state === 'idle');

  $('fClock').hidden = state === 'idle' || state === 'note';
  $('fCdLine').hidden = true;
  $('fBar').hidden = state === 'note' || state === 'done';
  $('fNote').hidden = state !== 'note';
  $('fCdPicker').hidden = true;

  const startBtn = $('fStart');
  startBtn.hidden = state === 'note' || state === 'done';
  startBtn.textContent = state === 'running' ? '■' : '▶';
  startBtn.classList.toggle('stopping', state === 'running');
  startBtn.setAttribute('aria-label', state === 'running' ? '停止' : '开始');

  if (state === 'running') renderClock();

  if (state === 'done') {
    $('fClock').hidden = false;
    $('fClock').textContent = '✓';
    setTimeout(closeLayerAndReset, 800);
  }

  if (state === 'idle') {
    cdEndAt = null; cdDone = false;
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
  if (cdEndAt) F.stopMark(session, 'countdown', now);
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

export async function openFocus(blockId, todoId, label) {
  if (session && !session.endedAt) {
    state = 'running';
    startTick();
    showLayer();
    render();
    return;
  }
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
  const all = await allSessions();
  const running = all
    .filter(s => !s.endedAt)
    .sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0));
  if (!running.length) return null;

  /* 只接最近那一条。多余的（正常不会出现）先收掉 ——
     两条计时器叠着算，时长会凭空变多，比少算还糟。 */
  for (const extra of running.slice(1)) {
    const o = F.fromRecord(extra);
    F.endSession(o, o.lastTick || o.startedAt);
    await putSession(F.toRecord(o));
  }

  const s = F.fromRecord(running[0]);
  const now = Date.now();
  /* 该怎么办由 focus.js 的纯函数决定 —— 那段逻辑必须能被单测覆盖 */
  const plan = F.resumePlan(s, { now, today: todayKey() });

  if (!plan.resume) {
    F.endSession(s, plan.stopAt);
    await putSession(F.toRecord(s));
    return null;
  }

  if (plan.away) {
    /* 一直在「离开中」（多半是锁屏了）→ 这段时间照算 */
    F.markBack(s, now);
  } else if (plan.gapMs > 5000) {
    F.addUnknown(s, plan.gapMs);
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

  /* 点一下开始 / 点一下停止 */
  $('fStart').addEventListener('click', () => {
    if (state === 'idle') startSession();
    else if (state === 'running') stopSession();
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

  /* 结束时那句总结：只有一个输入框 + 一个 ✓ */
  $('fNoteOk').addEventListener('click', finishWithNote);
  $('fNoteText').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); finishWithNote(); }
  });

  /* 切走 / 回来只用来记账，不影响时长 */
  document.addEventListener('visibilitychange', async () => {
    if (!session || session.endedAt) return;
    const now = Date.now();
    if (document.visibilityState === 'hidden') F.markAway(session, now);
    else { F.markBack(session, now); renderCdLine(); }
    await persist();
  });

  window.addEventListener('pagehide', () => { persist(); });

  /* 还没开始时右划可以退出去 */
  attachSwipe($('focusLayer'), {
    onRight: () => closeFocus(),
    disabled: () => state === 'running',
  });
}
