/* ═══════════════════════════════════════════════════════════
   goals.js — 目标栏

   位置：日总结页。**没完成的在顶上**（跟扇形图一起看），
        **完成的沉到最底下**（月亮太阳下面），变成一个「完成记录」。

   和待办不一样：目标是**全局的**，不属于某一天，每天的总结页都看得到。
   为什么勾掉要记完成日期：不然用半年之后底下就是一堆没日期的旧条目，
   那就不叫成就墙，叫垃圾场了。

   操作：
     点 ○        勾掉 / 取消勾掉
     点文字      直接改
     长按整行    隐藏（底下有「已隐藏 N 条」可以展开找回）
   ═══════════════════════════════════════════════════════════ */

import { loadSettings, saveSettings } from './store.js';
import { el, autoGrow } from './render.js';

let deps = { toast: () => {} };

const $ = (id) => document.getElementById(id);

/* ── 数据 ──────────────────────────────────────────────── */

function blankGoal(text) {
  const at = Date.now();
  return {
    id: 'g' + at.toString(36) + Math.random().toString(36).slice(2, 6),
    text: String(text || ''),
    done: false,
    doneAt: null,
    hidden: false,
    createdAt: at,
  };
}

async function allGoals() {
  const s = await loadSettings();
  if (!Array.isArray(s.goals)) s.goals = [];
  return s.goals;
}

async function persist() {
  const s = await loadSettings();
  await saveSettings({ goals: s.goals });
}

export async function addGoal(text) {
  const list = await allGoals();
  const t = String(text || '').trim();
  if (!t) return null;
  const g = blankGoal(t);
  list.push(g);
  await persist();
  return g;
}

async function toggleGoal(id) {
  const list = await allGoals();
  const g = list.find(x => x.id === id);
  if (!g) return;
  g.done = !g.done;
  g.doneAt = g.done ? Date.now() : null;
  await persist();
}

async function setText(id, text) {
  const list = await allGoals();
  const g = list.find(x => x.id === id);
  if (!g) return;
  g.text = text;
  await persist();
}

async function hideGoal(id) {
  const list = await allGoals();
  const g = list.find(x => x.id === id);
  if (!g) return;
  g.hidden = true;
  await persist();
}

async function unhideAll() {
  const list = await allGoals();
  for (const g of list) g.hidden = false;
  await persist();
}

/* ── 小工具 ────────────────────────────────────────────── */

function fmtDay(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  return `${d.getMonth() + 1}月${String(d.getDate()).padStart(2, '0')}日`;
}

function attachLongPress(node, ms, fn) {
  let timer = null;
  let fired = false;
  const start = (e) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    fired = false;
    clearTimeout(timer);
    timer = setTimeout(() => { timer = null; fired = true; fn(); }, ms);
  };
  const cancel = () => { clearTimeout(timer); timer = null; };
  node.addEventListener('pointerdown', start);
  ['pointerup', 'pointercancel', 'pointerleave'].forEach(ev => node.addEventListener(ev, cancel));
  return () => fired;
}

/* ── 画 ────────────────────────────────────────────────── */

export async function renderGoals(ctx) {
  deps = { toast: (ctx && ctx.toast) || (() => {}) };
  const hostOpen = $('sumGoals');
  const hostDone = $('sumGoalsDone');
  const cardDone = $('goalsDoneCard');
  const hostHidden = $('sumGoalsHidden');
  if (!hostOpen) return;

  const list = await allGoals();
  const open = list.filter(g => !g.done && !g.hidden);
  const done = list.filter(g => g.done && !g.hidden)
    .sort((a, b) => (b.doneAt || 0) - (a.doneAt || 0));
  const hidden = list.filter(g => g.hidden);

  /* ── 没完成的：在顶上 ── */
  hostOpen.textContent = '';

  for (const g of open) {
    const row = el('div', { class: 'goal-item', 'data-id': g.id });

    const tick = el('button', { class: 'goal-tick', type: 'button', 'aria-label': '完成' });
    tick.addEventListener('click', async (e) => {
      e.stopPropagation();
      await toggleGoal(g.id);
      renderGoals(ctx);
      ctx && ctx.onChange && ctx.onChange();
      deps.toast('完成了一个目标');
    });

    const ta = el('textarea', { class: 'goal-text', rows: '1', autocomplete: 'off' });
    ta.value = g.text;
    let timer = null;
    ta.addEventListener('input', () => {
      autoGrow(ta, 1);
      clearTimeout(timer);
      timer = setTimeout(() => setText(g.id, ta.value), 500);
    });
    ta.addEventListener('blur', () => { clearTimeout(timer); setText(g.id, ta.value); });

    row.append(tick, ta);

    const wasLong = attachLongPress(row, 620, async () => {
      if (!confirm(`隐藏「${g.text}」？\n\n它不会消失，底下「已隐藏」里能找回来。`)) return;
      await hideGoal(g.id);
      renderGoals(ctx);
      deps.toast('已隐藏');
    });
    /* 长按之后别再把这次触摸当成点击 */
    row.addEventListener('click', (e) => { if (wasLong()) { e.stopPropagation(); e.preventDefault(); } }, true);

    hostOpen.appendChild(row);
  }

  /* 加号：挂在这一栏的最后 */
  const add = el('button', { class: 'goal-add', type: 'button', 'aria-label': '添加目标', text: '+' });
  add.addEventListener('click', async () => {
    const text = (prompt('目标是什么？') || '').trim();
    if (!text) return;
    await addGoal(text);
    renderGoals(ctx);
    deps.toast('加上了');
  });
  hostOpen.appendChild(el('div', { class: 'goal-addline' }, [add]));

  /* ── 完成的：沉到最底下（月亮太阳下面） ── */
  hostDone.textContent = '';
  if (cardDone) cardDone.hidden = done.length === 0;

  for (const g of done) {
    const row = el('div', { class: 'goal-item done', 'data-id': g.id });

    const tick = el('button', { class: 'goal-tick', type: 'button', 'aria-label': '取消完成', text: '✓' });
    tick.addEventListener('click', async (e) => {
      e.stopPropagation();
      await toggleGoal(g.id);
      renderGoals(ctx);
      ctx && ctx.onChange && ctx.onChange();
    });

    row.append(
      tick,
      el('span', { class: 'goal-text', text: g.text }),
      el('span', { class: 'goal-date', text: fmtDay(g.doneAt) }),
    );

    const wasLong = attachLongPress(row, 620, async () => {
      await hideGoal(g.id);
      renderGoals(ctx);
      deps.toast('已隐藏');
    });
    row.addEventListener('click', (e) => { if (wasLong()) { e.stopPropagation(); e.preventDefault(); } }, true);

    hostDone.appendChild(row);
  }

  /* ── 已隐藏的：能找回来 ── */
  if (hostHidden) {
    hostHidden.textContent = '';
    if (hidden.length) {
      const btn = el('button', {
        type: 'button', class: 'goal-hidden', text: `已隐藏 ${hidden.length} 条`,
      });
      let openList = false;
      const box = el('div', { class: 'goal-hidden-list', hidden: true });
      for (const g of hidden) {
        box.appendChild(el('div', { class: 'goal-item hidden' }, [
          el('span', { class: 'goal-text', text: g.text }),
        ]));
      }
      btn.addEventListener('click', () => {
        openList = !openList;
        box.hidden = !openList;
        btn.textContent = openList ? `收起（全部恢复）` : `已隐藏 ${hidden.length} 条`;
        if (openList) {
          const restore = el('button', { type: 'button', class: 'goal-restore', text: '全部恢复' });
          restore.addEventListener('click', async () => {
            await unhideAll();
            renderGoals(ctx);
            deps.toast('都找回来了');
          });
          box.appendChild(el('div', { class: 'goal-addline' }, [restore]));
        } else {
          box.textContent = '';
          for (const g of hidden) {
            box.appendChild(el('div', { class: 'goal-item hidden' }, [
              el('span', { class: 'goal-text', text: g.text }),
            ]));
          }
        }
      });
      hostHidden.append(btn, box);
    }
  }
}
