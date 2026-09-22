/* ═══════════════════════════════════════════════════════════
   render.js — 把一天画出来

   版式（第 2 版，收紧过）：
     时间块之间用细横线分隔，不再是一个个厚方框
     待办是一条条带下划线的清单，每条之间也有横线
     「加待办」是右下角一个实心圆带加号
     每条待办可以单独左划 → 只专注这一条
   ═══════════════════════════════════════════════════════════ */

import {
  TEMPLATE, TARGET_HOURS, blockPhase, dayProgress,
  putDay, newId,
} from './store.js';
import { attachSwipe } from './gestures.js';

/* ── DOM 小工具 ────────────────────────────────────────── */

export function el(tag, props = {}, children = []) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') n.className = v;
    else if (k === 'text') n.textContent = v;
    else if (k === 'html') n.innerHTML = v;
    else if (k.startsWith('on') && typeof v === 'function') n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of [].concat(children)) {
    if (c === null || c === undefined || c === false) continue;
    n.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return n;
}

const SVGNS = 'http://www.w3.org/2000/svg';
export function svgEl(tag, props = {}) {
  const n = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === null || v === undefined) continue;
    n.setAttribute(k, String(v));
  }
  return n;
}

/* ── 自适应高度的输入框 ────────────────────────────────── */

/**
 * 用 textarea 而不是 input：input 是单行的，待办写长一点就不聚焦时被截断。
 * textarea + 自动长高 = 短的还是一行，长的自己撑开。
 */
export function autoGrow(ta, minRows = 1) {
  if (!ta) return;
  ta.style.height = 'auto';
  const cs = getComputedStyle(ta);
  const lh = parseFloat(cs.lineHeight);
  const pad = parseFloat(cs.paddingTop || 0) + parseFloat(cs.paddingBottom || 0);
  const line = Number.isFinite(lh) && lh > 0 ? lh : 24;
  const floor = line * minRows + (Number.isFinite(pad) ? pad : 0);
  ta.style.height = Math.max(floor, ta.scrollHeight) + 'px';
}

function makeInput(props) {
  return el('textarea', {
    class: 'todo-input',
    rows: '1',
    autocomplete: 'off',
    autocorrect: 'off',
    autocapitalize: 'off',
    spellcheck: 'false',
    enterkeyhint: 'done',
    ...props,
  });
}

/* ── 单条待办 ──────────────────────────────────────────── */

function todoNode(todo, day, blockId, ctx) {
  const li = el('li', {
    class: 'todo' + (todo.done ? ' done' : ''),
    'data-id': todo.id,
  });

  const tick = el('button', {
    class: 'tick',
    type: 'button',
    'aria-label': todo.done ? '标记为未完成' : '标记为完成',
  });

  const input = makeInput({ placeholder: '' });
  input.value = todo.text;

  const del = el('button', {
    class: 'todo-del',
    type: 'button',
    'aria-label': '删除这条待办',
    text: '×',
  });

  tick.addEventListener('click', async (e) => {
    e.stopPropagation();
    todo.done = !todo.done;
    todo.doneAt = todo.done ? Date.now() : null;
    li.classList.toggle('done', todo.done);
    tick.setAttribute('aria-label', todo.done ? '标记为未完成' : '标记为完成');
    await putDay(day);
    ctx.onChange();
  });

  /* 输入时防抖存盘；清空内容 = 删掉这条 */
  let timer = null;
  const flush = async () => {
    clearTimeout(timer);
    const v = input.value.trim();
    if (!v) return;
    if (v !== todo.text) {
      todo.text = v;
      await putDay(day);
      /* 让顶部「已完成/总数」跟着动 —— 重画只碰头顶那一行，不会动到光标 */
      ctx.onChange();
    }
  };
  input.addEventListener('input', () => {
    autoGrow(input);
    clearTimeout(timer);
    timer = setTimeout(flush, 450);
  });
  input.addEventListener('blur', async () => {
    await flush();
    if (!input.value.trim()) await removeTodo(day, blockId, todo.id, li, ctx);
  });

  del.addEventListener('click', async (e) => {
    e.stopPropagation();
    await removeTodo(day, blockId, todo.id, li, ctx);
  });

  li.append(tick, input, del);

  /* 每条待办单独左划 → 只专注这一条 */
  if (ctx.focusOn) {
    attachSwipe(li, {
      onLeft: () => ctx.focusOn(blockId, todo.id, input.value.trim()),
      allowEditable: true,
      threshold: 56,
    });
  }

  return li;
}

async function removeTodo(day, blockId, todoId, li, ctx) {
  day.todos[blockId] = (day.todos[blockId] || []).filter(t => t.id !== todoId);
  if (!day.todos[blockId].length) delete day.todos[blockId];
  li.style.transition = 'opacity .16s, transform .16s';
  li.style.opacity = '0';
  li.style.transform = 'translateX(-1rem)';
  await putDay(day);
  setTimeout(() => li.remove(), 170);
  ctx.onChange();
}

/* ── 一个时间块 ────────────────────────────────────────── */

export function blockNode(block, day, ctx) {
  const list = day.todos[block.id] || [];
  const phase = ctx.isToday ? blockPhase(block) : 0;

  const section = el('section', {
    class: [
      'block',
      phase === 0 ? 'is-past' : '',
      phase === 1 ? 'is-now' : '',
    ].filter(Boolean).join(' '),
    'data-id': block.id,
    'data-study': block.study ? '1' : '0',
    'data-habit': block.habit ? '1' : '0',
  });

  /* 第一行：时间 · 时长 · 角标 */
  let flag = null;
  if (phase === 1) flag = el('span', { class: 'blk-flag', text: '进行中' });
  else if (block.habit) flag = el('span', { class: 'blk-flag plain', text: block.habit });

  section.appendChild(el('div', { class: 'blk-top' }, [
    el('span', { class: 'blk-time', text: `${block.start}–${block.end}` }),
    block.hours > 0 ? el('span', { class: 'blk-hours', text: `${block.hours}h` }) : null,
    flag,
  ]));

  section.appendChild(el('h2', { class: 'blk-title', text: block.title }));
  if (block.sub) section.appendChild(el('p', { class: 'blk-sub', text: block.sub }));

  /* 待办清单 */
  const ul = el('ul', { class: 'todos' });
  for (const t of list) ul.appendChild(todoNode(t, day, block.id, ctx));
  section.appendChild(ul);

  /* 右下角：实心圆 + 加号 */
  const addBtn = el('button', {
    class: 'add-btn',
    type: 'button',
    'aria-label': '添加待办',
    text: '+',
  });
  section.appendChild(el('div', { class: 'blk-foot' }, [addBtn]));

  /* 点 ⊕ 直接开一条新的并聚焦，不用先点一个假输入框 */
  addBtn.addEventListener('click', () => {
    const todo = { id: newId(), text: '', done: false, createdAt: Date.now(), doneAt: null };
    if (!day.todos[block.id]) day.todos[block.id] = [];
    day.todos[block.id].push(todo);
    const node = todoNode(todo, day, block.id, ctx);
    ul.appendChild(node);
    const ta = node.querySelector('.todo-input');
    autoGrow(ta);
    ta.focus();
    /* 先把这一天滚一点，免得键盘顶上来时新行被挡住 */
    setTimeout(() => node.scrollIntoView({ block: 'center', behavior: 'smooth' }), 220);
  });

  return section;
}

/* ── 一整天 ────────────────────────────────────────────── */

export function renderBlocks(day, ctx) {
  const box = document.getElementById('blocks');
  if (!box) return null;
  box.textContent = '';
  for (const block of TEMPLATE) box.appendChild(blockNode(block, day, ctx));
  requestAnimationFrame(() => {
    box.querySelectorAll('textarea.todo-input').forEach(ta => autoGrow(ta));
  });
  return box;
}

/** 今天的话，滚到正在进行的那一块 */
export function scrollToNow(day) {
  if (!day) return;
  const nowBlock = TEMPLATE.find(b => blockPhase(b) === 1);
  if (!nowBlock) return;
  const target = document.querySelector(`.block[data-id="${nowBlock.id}"]`);
  if (!target) return;
  requestAnimationFrame(() => {
    const scroller = document.getElementById('day');
    if (scroller) scroller.scrollTo({ top: Math.max(0, target.offsetTop - 8), behavior: 'auto' });
  });
}

/* ── 头顶那一行 + 底部目标条 ───────────────────────────── */

export function renderHead(day, ctx) {
  const p = dayProgress(day);
  const planEl = document.getElementById('dhPlan');
  if (planEl) planEl.textContent = `计划 ${TARGET_HOURS}h`;

  const right = document.getElementById('dhRight');
  if (!right) return p;
  if (ctx.isToday) {
    right.textContent = p.total ? `${p.done}/${p.total}` : '';
  } else {
    right.textContent = p.total ? `完成 ${p.done}/${p.total}` : '';
  }
  return p;
}

/**
 * 底部目标条 —— 读的是**真实专注时长**，不是按待办勾选折算的估计值。
 * @param {object|null} focus dayFocus() 的结果
 */
export function renderGoal(focus) {
  const nowEl = document.getElementById('goalNow');
  const fillEl = document.getElementById('goalFill');
  const goalEl = document.getElementById('goal');
  if (!nowEl || !fillEl || !goalEl) return;

  const ms = (focus && focus.effectiveMs) || 0;
  const hours = Math.min(ms / 3600000, TARGET_HOURS);

  const hh = Math.floor(hours);
  const mm = Math.round((hours - hh) * 60);
  nowEl.textContent = `${hh}h${String(mm).padStart(2, '0')}m`;

  const percent = TARGET_HOURS ? Math.min(100, (hours / TARGET_HOURS) * 100) : 0;
  fillEl.style.width = percent.toFixed(1) + '%';
  goalEl.classList.toggle('pending', ms === 0);

  if (focus && focus.awayCount) {
    goalEl.title = `真实专注 ${Math.round(ms / 60000)} 分钟；` +
      `离开 ${focus.awayCount} 次，共 ${Math.round(focus.awayMs / 60000)} 分钟`;
  } else {
    goalEl.title = '今天累计的真实专注时长（左划进入专注开始计时）';
  }
}

/* ── 整页重画 ──────────────────────────────────────────── */

export function renderDay(day, ctx, focus) {
  renderHead(day, ctx);
  renderBlocks(day, ctx);
  renderGoal(focus);
}
