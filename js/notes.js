/* ═══════════════════════════════════════════════════════════
   notes.js — 便签本（第二个小本子）

   和日记不一样：便签**不挂日期**，是随手记的东西。
   攒想法、记账号、抄一句想记住的话，都往这儿扔。

   两个界面：
     列表  一列一列的便签卡片，置顶的排前面
     编辑  整页就是那张便签，直接写
   ═══════════════════════════════════════════════════════════ */

import {
  allNotes, putNote, deleteNote, blankNote, NOTE_COLORS, noteColor,
} from './store.js';
import { el } from './render.js';
import { attachSwipe } from './gestures.js';

let deps = { toast: () => {} };
let wired = false;
let list = [];
let cur = null;
let saveTimer = null;

const $ = (id) => document.getElementById(id);

/* ── 工具 ──────────────────────────────────────────────── */

function fmtDay(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const now = new Date();
  const sameYear = d.getFullYear() === now.getFullYear();
  return `${d.getMonth() + 1}月${d.getDate()}日` + (sameYear ? '' : ` ${d.getFullYear()}`);
}

function showView(which) {
  $('notesList').hidden = which !== 'list';
  $('notesEditor').hidden = which !== 'edit';
}

/* ── 列表 ──────────────────────────────────────────────── */

async function reload() {
  list = await allNotes();
}

function renderGrid() {
  const grid = $('notesGrid');
  grid.textContent = '';

  $('notesEmpty').hidden = list.length > 0;

  for (const n of list) {
    const c = noteColor(n.color);
    const text = (n.text || '').trim();

    const card = el('button', {
      class: 'note-card' + (n.pinned ? ' pinned' : ''),
      type: 'button',
      style: `background:${c.bg};color:${c.ink};`,
      'data-id': n.id,
    });

    card.appendChild(el('span', {
      class: 'note-card-text' + (text ? '' : ' empty'),
      text: text || '（空白便签）',
    }));

    card.appendChild(el('span', { class: 'note-card-foot' }, [
      n.pinned ? el('span', { class: 'note-pin-dot', text: '📌' }) : null,
      el('span', { class: 'note-card-date', text: fmtDay(n.updatedAt || n.createdAt) }),
    ]));

    card.addEventListener('click', () => openEditor(n));
    grid.appendChild(card);
  }
}

/* ── 编辑 ──────────────────────────────────────────────── */

function paintEditor() {
  const view = $('notesEditor');
  const c = noteColor(cur.color);
  view.style.background = c.bg;
  view.style.color = c.ink;
  $('notePin').classList.toggle('on', !!cur.pinned);

  const box = $('noteColors');
  box.textContent = '';
  for (const col of NOTE_COLORS) {
    const dot = el('button', {
      type: 'button',
      class: 'note-dot' + (col.id === cur.color ? ' on' : ''),
      'data-color': col.id,
      'aria-label': col.name,
      style: `background:${col.bg};`,
    });
    dot.addEventListener('click', async () => {
      cur.color = col.id;
      paintEditor();
      await putNote(cur);
    });
    box.appendChild(dot);
  }
}

function openEditor(note) {
  cur = note;
  showView('edit');
  paintEditor();
  const ta = $('noteText');
  ta.value = note.text || '';
  /* 让光标落到末尾，打开就能接着写 */
  requestAnimationFrame(() => {
    ta.focus();
    ta.setSelectionRange(ta.value.length, ta.value.length);
  });
}

async function saveNow() {
  clearTimeout(saveTimer);
  if (!cur) return;
  const ta = $('noteText');
  if ((cur.text || '') === ta.value) return;
  cur.text = ta.value;
  await putNote(cur);
}

async function backToList() {
  await saveNow();
  /* 一个字都没写的便签不留着 —— 点了 ＋ 又反悔的情况 */
  if (cur && !String(cur.text || '').trim()) {
    await deleteNote(cur.id);
    deps.toast('空白便签没保存');
  }
  cur = null;
  await reload();
  renderGrid();
  showView('list');
}

/* ── 开关 ──────────────────────────────────────────────── */

function showLayer() {
  const layer = $('notesLayer');
  layer.hidden = false;
  requestAnimationFrame(() => requestAnimationFrame(() => layer.classList.add('show')));
}

function hideLayer() {
  const layer = $('notesLayer');
  layer.classList.remove('show');
  setTimeout(() => { layer.hidden = true; }, 300);
}

export async function openNotes() {
  await reload();
  renderGrid();
  showView('list');
  showLayer();
}

export function closeNotes() {
  const layer = $('notesLayer');
  if (!layer || layer.hidden) return;
  /* 正在编辑就先存一下，再收起来 */
  if (cur) {
    saveNow().then(async () => {
      if (cur && !String(cur.text || '').trim()) await deleteNote(cur.id);
      cur = null;
    });
  }
  hideLayer();
}

export function isNotesOpen() {
  const layer = $('notesLayer');
  return !!layer && !layer.hidden && layer.classList.contains('show');
}

/* ── 接线 ──────────────────────────────────────────────── */

export function initNotes(options = {}) {
  Object.assign(deps, options);
  if (wired) return;
  wired = true;

  $('notesClose').addEventListener('click', closeNotes);

  $('noteAdd').addEventListener('click', async () => {
    const n = blankNote();
    await putNote(n);
    list.unshift(n);
    openEditor(n);
  });

  $('noteBack').addEventListener('click', backToList);

  $('notePin').addEventListener('click', async () => {
    if (!cur) return;
    cur.pinned = !cur.pinned;
    $('notePin').classList.toggle('on', cur.pinned);
    await putNote(cur);
    deps.toast(cur.pinned ? '置顶了' : '取消置顶');
  });

  $('noteDel').addEventListener('click', async () => {
    if (!cur) return;
    if (!confirm('删掉这条便签？删了就找不回来了。')) return;
    const id = cur.id;
    cur = null;
    await deleteNote(id);
    await reload();
    renderGrid();
    showView('list');
    deps.toast('删掉了');
  });

  const ta = $('noteText');
  ta.addEventListener('input', () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveNow, 500);
  });
  ta.addEventListener('blur', saveNow);

  /* 右划：编辑里退回列表，列表里关掉 */
  attachSwipe($('notesLayer'), {
    onRight: () => {
      if (cur) backToList();
      else closeNotes();
    },
    allowEditable: true,
  });

  window.addEventListener('pagehide', () => { saveNow(); });
}
