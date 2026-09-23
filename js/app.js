/* ═══════════════════════════════════════════════════════════
   app.js — 主程序：开局、切天、自动翻页、面板开关
   ═══════════════════════════════════════════════════════════ */

import { openDB, requestPersistence, fmtBytes } from './db.js';
import {
  loadSettings, saveSettings, getDay, putDay, blankDay, todayKey, addDays,
  fmtMain, fmtSub, dayProgress, sessionsForDate,
} from './store.js';
import { applyTheme, themeForDay, renderSwatches } from './theme.js';
import { renderDay, renderHead, renderGoal, scrollToNow } from './render.js';
import { renderDiary } from './diary.js';
import { renderHabits } from './habits.js';
import {
  renderWeekList, appendWeeks, hasMoreWeeks,
  renderHabitTable, buildWeekHead,
} from './daystrip.js';
import { attachSwipe } from './gestures.js';
import { dayFocus } from './focus.js';
import {
  initFocus, openFocus, isFocusOpen, isFocusRunning, resumeIfAny,
} from './focus-ui.js';
import {
  initSummary, openSummary, isSummaryOpen, refreshSummary,
} from './summary.js';
import { exportAll, importAll } from './backup.js';
import { printDay, printMonth } from './print.js';
import { initNotes, openNotes, isNotesOpen } from './notes.js';
import { seedCourses } from './schedule.js';
import { checkWake } from './sleep.js';

/* ── 全局状态 ──────────────────────────────────────────── */

let settings = null;
let currentDate = todayKey();
let currentDay = null;
let currentFocus = null;     // 当天的专注汇总（dayFocus 的结果）
let pinned = false;          // 用户手动翻到了别的日子，就不要再自动跳回今天

const $ = (id) => document.getElementById(id);

/* ── 轻提示 ────────────────────────────────────────────── */

let toastTimer = null;
function toast(msg, ms = 2000) {
  const t = $('toast');
  t.textContent = msg;
  t.hidden = false;
  requestAnimationFrame(() => t.classList.add('show'));
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    t.classList.remove('show');
    setTimeout(() => { t.hidden = true; }, 240);
  }, ms);
}

/* ── 专注数据 ──────────────────────────────────────────── */

/** 重新算一遍当天的真实专注时长，并刷底部那条 */
async function refreshFocus() {
  if (!currentDate) return;
  try {
    const list = await sessionsForDate(currentDate);
    currentFocus = dayFocus(list.map(s => ({ ...s, away: s.away || [] })));
  } catch {
    currentFocus = null;
  }
  renderGoal(currentFocus);
  return currentFocus;
}

/* ── 切天 ──────────────────────────────────────────────── */

let flipping = false;

function paintTopbar(date) {
  $('dateMain').textContent = fmtMain(date);
  $('dateSub').textContent = fmtSub(date);
}

/** 整页：时间块 + 日记本。分开画是为了避开 render.js ←→ diary.js 的循环引用 */
function drawDay() {
  renderDay(currentDay, ctx, currentFocus);
  renderHabits(currentDay, ctx);
  renderDiary(currentDay, ctx);
}

async function paint(date) {
  currentDate = date;
  currentDay = await getDay(date);
  /* 这一天的课，提前填成待办（只填一次，你删了就不会再塞回来） */
  if (await seedCourses(currentDay)) await putDay(currentDay);
  applyTheme(themeForDay(currentDay, settings));
  paintTopbar(date);
  await refreshFocus();
  drawDay();
}

const ctx = {
  get isToday() { return currentDate === todayKey(); },
  /**
   * 待办变动后只刷「顶部计数 + 底部目标条」，绝不重画时间块。
   * 重画会把你正在打字的输入框整个换掉，光标就丢了 —— 这个坑踩过一次。
   */
  onChange() {
    renderHead(currentDay, ctx);
    renderGoal(currentFocus);
  },
  refreshDiary() {
    renderDiary(currentDay, ctx);
  },
  /** 某一条待办被左划 —— 只专注这一条 */
  focusOn(blockId, todoId, label) {
    openFocus(blockId, todoId, label);
  },
  toast,
};

/** 走到某一天。animate=true 时播翻页动画 */
async function goTo(date, { animate = false, dir = 'next' } = {}) {
  if (flipping) return;
  if (date === currentDate && !animate) return;

  const isToday = date === todayKey();
  pinned = !isToday;

  if (!animate) {
    await paint(date);
    if (isToday) scrollToNow(currentDay);
    return;
  }

  flipping = true;
  const page = $('page');
  const outClass = dir === 'next' ? 'flip-out' : 'flip-in';
  const inClass = dir === 'next' ? 'flip-in' : 'flip-out';

  page.classList.add(outClass);
  await new Promise(r => setTimeout(r, 260));

  await paint(date);
  page.classList.remove(outClass);

  page.classList.add(inClass);
  await new Promise(r => setTimeout(r, 300));
  page.classList.remove(inClass);

  flipping = false;
  if (isToday) scrollToNow(currentDay);
}

/* ── 自动翻页：三层保险 ────────────────────────────────── */

/** ① 回到前台时检查 ② 每分钟检查一次 ③ 打开时检查 —— 都走这里 */
async function checkRollover(force = false) {
  const t = todayKey();
  if (currentDate === t) return false;
  if (pinned && !force) return false;      // 你在翻历史，别打扰
  await goTo(t, { animate: true, dir: 'next' });
  toast('新的一天，翻开新的一页', 2600);
  return true;
}

/* ── 底部面板 ──────────────────────────────────────────── */

let openSheetEl = null;

function openSheet(sheet) {
  if (openSheetEl) closeSheet();
  openSheetEl = sheet;
  $('scrim').hidden = false;
  sheet.hidden = false;
  /* 必须等一帧让初始状态（在屏幕外）先渲染出来，否则 transition 不触发 */
  requestAnimationFrame(() => requestAnimationFrame(() => {
    $('scrim').classList.add('show');
    sheet.classList.add('show');
  }));
}

function closeSheet() {
  const sheet = openSheetEl;
  if (!sheet) return;
  openSheetEl = null;
  sheet.classList.remove('show');
  $('scrim').classList.remove('show');
  setTimeout(() => {
    sheet.hidden = true;
    $('scrim').hidden = true;
  }, 300);
}

/* ── 小本子：周历 / 习惯 / 备份 ─────────────────────────── */

let stripMode = 'todo';      // 'todo' | 'focus'
let bookTab = 'weeks';       // 'weeks' | 'habits' | 'io'
let weekTotal = 0;

function markStripMode() {
  document.querySelectorAll('#stripModes button').forEach((b) => {
    b.classList.toggle('on', b.dataset.mode === stripMode);
  });
}

function markBookTab() {
  document.querySelectorAll('#bookTabs button').forEach((b) => {
    b.classList.toggle('on', b.dataset.tab === bookTab);
  });
  $('tabWeeks').hidden = bookTab !== 'weeks';
  $('tabHabits').hidden = bookTab !== 'habits';
  $('tabIo').hidden = bookTab !== 'io';
}

/** 滑到底就把下一批周补上 */
function afterAppend() {
  const more = hasMoreWeeks();
  $('weekEnd').hidden = !(weekTotal > 1 && !more);
}

async function refreshBook() {
  const info = await renderWeekList($('weekRows'), {
    mode: stripMode,
    selectedDate: currentDate,
    settings,
    onPick: async (date) => {
      closeSheet();
      const dir = date >= currentDate ? 'next' : 'prev';
      await goTo(date, { animate: true, dir });
      if (date === todayKey()) pinned = false;
    },
  });

  weekTotal = info.weeks;
  afterAppend();

  $('stripNote').textContent = (stripMode === 'focus'
    ? '圆环＝当天有效专注 / 12h'
    : '圆环＝当天待办完成比例')
    + `　·　共 ${info.weeks} 周，往下滑就是往回看`;

  renderHabitTable($('matrix'), $('matrixTotals'));
  markStripMode();
  markBookTab();
}

/* ── 接线 ──────────────────────────────────────────────── */

function wire() {
  /* 日期条左右箭头 */
  $('prevDay').addEventListener('click', () => goTo(addDays(currentDate, -1), { animate: true, dir: 'prev' }));
  $('nextDay').addEventListener('click', () => goTo(addDays(currentDate, 1), { animate: true, dir: 'next' }));

  /* 点日期回今天 */
  $('dateBtn').addEventListener('click', async () => {
    const t = todayKey();
    if (currentDate === t) { toast('已经在今天了'); return; }
    pinned = false;
    await goTo(t, { animate: true, dir: currentDate > t ? 'prev' : 'next' });
  });

  /* 配色面板 */
  $('themeBtn').addEventListener('click', () => {
    const pick = async (id) => {
      currentDay.theme = id;
      await putDay(currentDay);
      applyTheme(themeForDay(currentDay, settings));
      closeSheet();
      toast(id ? '这一天换好颜色了' : '改回默认色');
    };
    renderSwatches($('swatches'), currentDay.theme, pick);
    openSheet($('themeSheet'));
  });

  /* 小本子（周历 / 习惯 / 备份） */
  $('bookBtn').addEventListener('click', async () => {
    await refreshBook();
    openSheet($('bookSheet'));
  });

  $('bookTabs').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-tab]');
    if (!btn) return;
    bookTab = btn.dataset.tab;
    markBookTab();
  });

  /* 周历滑到底 → 继续补后面的历史（一年 52 周一次全画会卡） */
  $('weekScroll').addEventListener('scroll', () => {
    const el = $('weekScroll');
    if (!hasMoreWeeks()) return;
    if (el.scrollTop + el.clientHeight > el.scrollHeight - 260) {
      appendWeeks($('weekRows'));
      afterAppend();
    }
  });

  /* 便签本 */
  $('notesBtn').addEventListener('click', () => openNotes());
  $('bookClose').addEventListener('click', closeSheet);

  /* 圆环读数：待办完成 / 专注时长 */
  $('stripModes').addEventListener('click', async (e) => {
    const btn = e.target.closest('button[data-mode]');
    if (!btn) return;
    stripMode = btn.dataset.mode;
    await refreshBook();
  });

  /* ── 备份与导出 ────────────────────────────────────── */

  $('exportBtn').addEventListener('click', async () => {
    const btn = $('exportBtn');
    btn.disabled = true;
    btn.textContent = '打包中…';
    try {
      const r = await exportAll();
      toast(`导出好了：${r.days} 天 · ${r.photos} 张照片 · ${fmtBytes(r.bytes)}`, 3600);
    } catch (e) {
      if (e && e.name === 'AbortError') toast('已取消', 1800);
      else toast('导出失败：' + (e.message || e), 4200);
    } finally {
      btn.disabled = false;
      btn.textContent = '导出备份';
    }
  });

  $('importBtn').addEventListener('click', () => $('importFile').click());

  $('importFile').addEventListener('change', async () => {
    const f = $('importFile').files && $('importFile').files[0];
    if (!f) return;
    if (!confirm('导入会覆盖这台设备上现在的全部数据。\n\n建议先「导出备份」留一份底。确定继续吗？')) {
      $('importFile').value = '';
      return;
    }
    const btn = $('importBtn');
    btn.disabled = true;
    btn.textContent = '导入中…';
    try {
      const r = await importAll(f, { replace: true });
      toast(`导入完成：${r.days} 天 · ${r.photos} 张照片，正在重开…`, 3000);
      $('importFile').value = '';
      setTimeout(() => location.reload(), 1200);
    } catch (e) {
      toast('导入失败：' + (e.message || e), 4200);
      $('importFile').value = '';
    } finally {
      btn.disabled = false;
      btn.textContent = '导入备份';
    }
  });

  /* PDF：先收起面板，等动画走完再排版，不然量到的高度是错的 */
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  $('pdfDayBtn').addEventListener('click', async () => {
    closeSheet();
    await sleep(360);
    toast('正在排版这一天…', 3000);
    await sleep(60);
    try { await printDay(currentDate); } catch (e) { toast('排版失败：' + (e.message || e), 4000); }
  });

  $('pdfMonthBtn').addEventListener('click', async () => {
    closeSheet();
    await sleep(360);
    toast('正在排版整月，照片多会慢一点…', 4000);
    await sleep(60);
    try { await printMonth(currentDate); } catch (e) { toast('排版失败：' + (e.message || e), 4000); }
  });

  $('scrim').addEventListener('click', closeSheet);

  /* 左右划：左划进专注，右划看今天的总结 */
  attachSwipe($('day'), {
    onLeft: () => openFocus(),
    onRight: () => openSummary(currentDate, currentDay),
    /* 有面板开着的时候不要再响应一次 */
    disabled: () => isFocusOpen() || isSummaryOpen() || isNotesOpen(),
    /* 待办行上的手势归那条待办自己管（它左划是「只专注这一条」） */
    ignoreFrom: '.todo',
  });

  /* 电脑上预览时用方向键翻页 */
  document.addEventListener('keydown', (e) => {
    if (e.target.closest('input, textarea, [contenteditable]')) return;
    if (e.key === 'ArrowLeft') goTo(addDays(currentDate, -1), { animate: true, dir: 'prev' });
    if (e.key === 'ArrowRight') goTo(addDays(currentDate, 1), { animate: true, dir: 'next' });
    if (e.key === 'Escape') closeSheet();     /* 注意：Escape 故意不关专注面板 */
  });

  /* 回到前台 → 检查是不是跨天了，顺手重算专注 */
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      checkRollover();
      refreshFocus();
    }
  });

  /* 每分钟检查一次，App 一直开着也能跨午夜自动翻页 */
  setInterval(async () => {
    if (document.visibilityState !== 'visible') return;
    const turned = await checkRollover();
    /* 没跨天的话，顺手刷新「进行中」高亮、顶部计数、底部专注条 */
    if (!turned && !pinned) {
      await refreshFocus();
      drawDay();
    }
  }, 60000);
}

/* ── 字号 ──────────────────────────────────────────────── */

function applyFontScale(fs) {
  document.documentElement.style.setProperty('--fs', String(fs));
}

/* ── 致命错误：把原因摆到脸上，别白屏 ─────────────────── */

function showFatal(e) {
  const box = $('errbox');
  if (!box) return;
  box.hidden = false;
  box.textContent =
    '数据打不开：' + (e && e.message ? e.message : e) + '\n\n' +
    (location.protocol === 'file:'
      ? '你现在是双击 index.html 打开的（file:// 协议），\n' +
        '浏览器在这种模式下会禁用数据库。\n\n' +
        '请改用开始菜单里的 start.bat 启动，\n' +
        '然后打开 http://localhost:5173/'
      : '试试：\n' +
        '1. 关掉其他打开着本子的标签页，刷新\n' +
        '2. 如果是 Safari 无痕模式，换成普通模式\n' +
        '3. 还不行就把这段截图发我');
}

/* ── 启动 ──────────────────────────────────────────────── */

async function boot() {
  /* ① 先立刻画一版，不等数据库 —— 点开就有东西看，不用盯着白屏 */
  currentDate = todayKey();
  currentDay = blankDay(currentDate);
  currentFocus = null;
  applyTheme(themeForDay(currentDay, null));
  paintTopbar(currentDate);
  drawDay();

  /* ② 再开数据库，拿到真数据后重画 */
  try {
    await openDB();
  } catch (e) {
    showFatal(e);
    return;
  }

  settings = await loadSettings();
  applyFontScale(settings.fs || 1);

  /* 专注面板和日总结都要先接上 */
  initFocus({
    toast,
    onChange: () => {
      refreshFocus();
      if (isSummaryOpen()) refreshSummary();
    },
    getDate: () => currentDate,
    getStrict: () => !!settings.strict,
  });

  initSummary({
    toast,
    onChange: () => { refreshFocus(); },
  });

  initNotes({ toast });

  const today = todayKey();
  const lastSeen = settings.lastSeen;
  const isNewDay = !!lastSeen && lastSeen !== today;

  await paint(today);       /* 用真实数据重画一次 */

  wire();

  /* 星期表头是固定的，建一次就够 */
  buildWeekHead($('weekHead'));

  if (isNewDay) {
    /* 隔了一天才打开 —— 播一次翻页，让你看到新的一页 */
    const page = $('page');
    page.classList.add('flip-in');
    setTimeout(() => page.classList.remove('flip-in'), 320);
  } else {
    scrollToNow(currentDay);
  }

  await saveSettings({ lastSeen: today });

  /* 要一份持久化存储，免得 iOS 空间紧张时清掉数据 */
  requestPersistence();

  /* ── Service Worker ──────────────────────────────────────
     只在 https 上注册（就是手机上真正用的时候）。
     本地预览（localhost）不注册，而且主动清理已经注册过的 ——
     不然改了代码刷新还看到旧的，白折腾半天。 */
  const isLocal = location.hostname === 'localhost' || location.hostname === '127.0.0.1';

  if ('serviceWorker' in navigator) {
    if (isLocal) {
      navigator.serviceWorker.getRegistrations()
        .then(rs => rs.forEach(r => r.unregister()))
        .catch(() => {});
      if (window.caches) {
        caches.keys().then(ks => ks.forEach(k => caches.delete(k))).catch(() => {});
      }
    } else if (location.protocol === 'https:') {
      navigator.serviceWorker.register('./sw.js').catch(() => {});

      /* 新版本接管时自动刷新一次 —— 不然手机上要手动刷两遍才看到新版 */
      let hadController = !!navigator.serviceWorker.controller;
      let reloading = false;
      navigator.serviceWorker.addEventListener('controllerchange', () => {
        if (!hadController) { hadController = true; return; }
        if (reloading) return;
        reloading = true;
        location.reload();
      });
    }
  }
  /* ③ 点了「我睡了」之后又回来 —— 自动记「我醒了」 */
  try {
    if (await checkWake()) toast('早安', 2400);
  } catch { /* 记不上不影响用 */ }

  /* ④ 上次的专注还没结束？接着算。页面被 iOS 杀掉也不会丢。 */
  try {
    await resumeIfAny();
  } catch { /* 接不上就算了，不影响用 */ }

  if (isNewDay) {
    setTimeout(() => {
      const p = dayProgress(currentDay);
      toast(p.total === 0 ? '翻开新的一页，今天从 6:30 开始' : '新的一天', 2600);
    }, 500);
  }
}

boot();
