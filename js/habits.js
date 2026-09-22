/* ═══════════════════════════════════════════════════════════
   habits.js — 主页面上的习惯打卡条

   位置：时间块下面、日记上面。
   点一下打卡 / 再点一下取消。
   点最右边的 ＋ 加一个；长按某个习惯 → 问你要不要删掉。
   删掉不抹历史 —— 它只是从今天起不再出现。
   ═══════════════════════════════════════════════════════════ */

import { allHabitDefs, addHabit, removeHabit, putDay } from './store.js';
import { el } from './render.js';

let deps = { toast: () => {} };
let wired = false;
let longPressTimer = null;

const $ = (id) => document.getElementById(id);

/* ── 长按：用来删习惯 ──────────────────────────────────── */

function attachLongPress(node, ms, fn) {
  let t0 = 0;
  const start = (e) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    t0 = Date.now();
    clearTimeout(longPressTimer);
    longPressTimer = setTimeout(() => { longPressTimer = null; t0 = 0; fn(); }, ms);
  };
  const cancel = () => {
    clearTimeout(longPressTimer);
    longPressTimer = null;
    t0 = 0;
  };
  node.addEventListener('pointerdown', start);
  ['pointerup', 'pointercancel', 'pointerleave'].forEach(ev => node.addEventListener(ev, cancel));
}

/* ── 画 ────────────────────────────────────────────────── */

export async function renderHabits(day, ctx) {
  const host = $('habitsBar');
  if (!host) return;
  host.textContent = '';

  if (!day.habits) day.habits = {};
  const defs = await allHabitDefs();
  const names = defs.filter(h => !h.end).map(h => h.name);

  for (const name of names) {
    const on = !!day.habits[name];
    const chip = el('button', {
      type: 'button',
      class: 'hb-chip' + (on ? ' on' : ''),
      'data-name': name,
      text: name,
    });

    let swallowed = false;

    attachLongPress(chip, 620, async () => {
      swallowed = true;
      if (!confirm(`删掉「${name}」？\n\n以前的打卡记录不会消失，只是从今天起不再出现。`)) return;
      await removeHabit(name);
      /* 今天这条也一并清掉，免得日总结里还算它 */
      delete day.habits[name];
      await putDay(day);
      await renderHabits(day, ctx);
      deps.toast(`「${name}」已停用`);
      ctx.onChange();
    });

    chip.addEventListener('click', async (e) => {
      e.preventDefault();
      if (swallowed) { swallowed = false; return; }
      day.habits[name] = !day.habits[name];
      await putDay(day);
      chip.classList.toggle('on', day.habits[name]);
      ctx.onChange();
    });

    host.appendChild(chip);
  }

  /* 加一个 */
  const add = el('button', {
    type: 'button',
    class: 'hb-add',
    'aria-label': '添加习惯',
    text: '+',
  });
  add.addEventListener('click', async () => {
    const name = (prompt('新习惯叫什么？') || '').trim();
    if (!name) return;
    if (names.includes(name)) { deps.toast('已经有了'); return; }
    await addHabit(name);
    await renderHabits(day, ctx);
    deps.toast('加了 · 从今天开始算');
  });
  host.appendChild(add);
}
