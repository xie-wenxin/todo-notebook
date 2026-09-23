/* ═══════════════════════════════════════════════════════════
   smoke.mjs — 端到端冒烟测试
   用 Chrome DevTools Protocol 真的把页面打开、真的点、真的刷新，
   验证渲染、持久化、手势外的交互是不是都对。

   为什么不用 --dump-dom：那个在 load 事件后就 dump，
   而 IndexedDB 回调是异步的，会测不到。
   为什么不用 --virtual-time-budget：它快进时钟，IndexedDB 回调永远不触发。

   用法：
     node tools/smoke.mjs
     node tools/smoke.mjs http://localhost:5173/
   ═══════════════════════════════════════════════════════════ */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CHROME = process.env.CHROME
  || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const TARGET_URL = process.argv[2] || 'http://localhost:5173/';
const PORT = Number(process.env.CDP_PORT || 9222);
const PROFILE = path.join(os.tmpdir(), 'dsh-smoke-profile');

fs.rmSync(PROFILE, { recursive: true, force: true });

if (!fs.existsSync(CHROME)) {
  console.error('找不到 Chrome：' + CHROME);
  process.exit(2);
}

const chrome = spawn(CHROME, [
  '--headless=new',
  '--disable-gpu',
  '--no-sandbox',
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-crashpad',
  '--disable-extensions',
  '--disable-background-networking',
  '--disable-features=Translate,BackForwardCache',
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${PROFILE}`,
  'about:blank',
], { stdio: 'ignore' });

/* ── CDP 小客户端 ──────────────────────────────────────── */

class CDP {
  constructor(url) {
    this.url = url;
    this.seq = 0;
    this.pending = new Map();
    this.consoleErrors = [];
    this.exceptions = [];
    this.badResponses = [];
  }

  connect() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.url);
      this.ws.onopen = () => resolve();
      this.ws.onerror = () => reject(new Error('WebSocket 连接失败'));
      this.ws.onmessage = (ev) => {
        let m;
        try { m = JSON.parse(ev.data); } catch { return; }

        if (m.id && this.pending.has(m.id)) {
          const { res, rej } = this.pending.get(m.id);
          this.pending.delete(m.id);
          if (m.error) rej(new Error(m.error.message)); else res(m.result);
          return;
        }

        if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
          this.consoleErrors.push((m.params.args || [])
            .map(a => a.value ?? a.description ?? a.type).join(' '));
        }
        if (m.method === 'Runtime.exceptionThrown') {
          const d = m.params.exceptionDetails || {};
          this.exceptions.push(d.exception?.description || d.text || 'unknown');
        }
        if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') {
          this.consoleErrors.push('[log] ' + m.params.entry.text);
        }
        if (m.method === 'Network.responseReceived') {
          const r = m.params.response || {};
          if (r.status >= 400) this.badResponses.push(r.status + ' ' + r.url);
        }
        if (m.method === 'Network.loadingFailed') {
          this.badResponses.push('FAILED ' + (m.params.errorText || '') + ' ' + (m.params.requestId || ''));
        }
      };
    });
  }

  send(method, params = {}) {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { res: resolve, rej: reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async eval(expression) {
    const r = await this.send('Runtime.evaluate', {
      expression, awaitPromise: true, returnByValue: true,
    });
    if (r.exceptionDetails) {
      throw new Error(r.exceptionDetails.exception?.description
        || r.exceptionDetails.text || '页面里抛异常了');
    }
    return r.result.value;
  }

  close() { try { this.ws.close(); } catch {} }
}

/* ── 工具 ──────────────────────────────────────────────── */

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function waitFor(fn, timeout = 20000, step = 250) {
  const t0 = Date.now();
  for (;;) {
    try { const v = await fn(); if (v) return v; } catch {}
    if (Date.now() - t0 > timeout) throw new Error('等待超时');
    await sleep(step);
  }
}

let pass = 0, fail = 0;
const failures = [];

function check(name, ok, detail = '') {
  if (ok) { pass++; console.log('  PASS  ' + name); }
  else {
    fail++;
    failures.push(name + (detail ? '  → ' + detail : ''));
    console.log('  FAIL  ' + name + (detail ? '  → ' + detail : ''));
  }
}

/* 找出当前可见文字里最小的那个字号 —— 用来保证「全页没有小字」 */
const SMALLEST = `(() => {
  let min = 999, where = '';
  const walk = (n) => {
    for (const el of n.children) {
      const r = el.getBoundingClientRect();
      const own = [...el.childNodes]
        .filter(c => c.nodeType === 3).map(c => c.textContent).join('').trim();
      if (r.width > 0 && r.height > 0 && own) {
        const s = parseFloat(getComputedStyle(el).fontSize);
        if (s && s < min) { min = s; where = (el.className || el.tagName) + ' :: ' + own.slice(0, 14); }
      }
      walk(el);
    }
  };
  walk(document.body);
  return min + 'px @ ' + where;
})()`;

/* ── 主流程 ────────────────────────────────────────────── */

let cdp;

async function main() {
  console.log('');
  console.log('  待办本子 · 冒烟测试');
  console.log('  目标：' + TARGET_URL);
  console.log('');

  const target = await waitFor(async () => {
    const r = await fetch(`http://127.0.0.1:${PORT}/json/list`);
    const list = await r.json();
    const page = list.find(t => t.type === 'page' && t.webSocketDebuggerUrl);
    return page || null;
  }, 20000);

  cdp = new CDP(target.webSocketDebuggerUrl);
  await cdp.connect();
  await cdp.send('Runtime.enable');
  await cdp.send('Log.enable');
  await cdp.send('Page.enable');
  await cdp.send('Network.enable');

  /* ── 0. v1 → v2 数据库升级：绝不能弄丢老数据 ─────────────
     真实情况是：你手机里已经存了 v1 的待办和日记，现在代码升到 v2
     （多了 notes 表）。这里就照着这个情况造一遍。 */
  console.log('  ── 数据库升级 v1 → v2 ──');

  /* 先跑到同源的一个空 HTML 页面上，在那里造一个 v1 的库。
     注意不能用 404 页面 —— Chrome 在那种页面上会禁用 IndexedDB。 */
  await cdp.send('Page.navigate', { url: TARGET_URL + '_blank' });
  await sleep(1000);

  const seeded = await cdp.eval(`(async () => {
    if (!self.indexedDB) return 'no-idb';
    /* 先删干净，免得受别的测试影响 */
    await new Promise((resolve) => {
      let done = false;
      const finish = () => { if (!done) { done = true; resolve(true); } };
      const del = indexedDB.deleteDatabase('notebook');
      del.onsuccess = finish; del.onerror = finish; del.onblocked = finish;
      setTimeout(finish, 1500);
    });

    return await new Promise((resolve, reject) => {
      const req = indexedDB.open('notebook', 1);   /* 注意是版本 1 */
      req.onupgradeneeded = () => {
        const db = req.result;
        db.createObjectStore('days', { keyPath: 'date' });
        db.createObjectStore('settings', { keyPath: 'key' });
        const s = db.createObjectStore('sessions', { keyPath: 'id' });
        s.createIndex('date', 'date', { unique: false });
        db.createObjectStore('photos', { keyPath: 'id' });
        /* 故意不建 notes —— 那是 v2 才有的 */
      };
      req.onerror = () => reject(req.error);
      req.onsuccess = () => {
        const db = req.result;
        const t = db.transaction('days', 'readwrite');
        t.objectStore('days').put({
          date: '2026-01-05', theme: 'sky',
          todos: { b1: [{ id: 'old1', text: '升级前就写好的待办', done: true, createdAt: 1, doneAt: 2 }] },
          habits: { '运动': true },
          diary: { text: '升级前的日记文字' },
          photos: [],
        });
        t.oncomplete = () => { db.close(); resolve(true); };
        t.onerror = () => reject(t.error);
      };
    });
  })()`);
  check('造好了一个只含 v1 表的数据库', seeded === true, String(seeded));

  /* 刚才那个空白页是测试脚手架，它引发的报错不算 App 的问题，
     从这里开始重新计账 */
  cdp.consoleErrors.length = 0;
  cdp.badResponses.length = 0;

  /* 现在打开 App —— 它会以 v2 打开并自动升级 */
  await cdp.send('Page.navigate', { url: TARGET_URL });
  await sleep(3400);

  const migrated = JSON.parse(await cdp.eval(`(async () => {
    const m = await import('./js/store.js');
    const d = await m.getDay('2026-01-05');
    const notes = await m.allNotes();
    const probe = await new Promise((res) => {
      const r = indexedDB.open('notebook');
      r.onsuccess = () => {
        const db = r.result;
        const out = { version: db.version, stores: [...db.objectStoreNames].sort() };
        db.close();
        res(out);
      };
      r.onerror = () => res({ version: 0, stores: [] });
    });
    return JSON.stringify({
      todoText: d.todos && d.todos.b1 && d.todos.b1[0] && d.todos.b1[0].text,
      todoDone: d.todos && d.todos.b1 && d.todos.b1[0] && d.todos.b1[0].done,
      theme: d.theme,
      habit: d.habits && d.habits['运动'],
      diary: d.diary && d.diary.text,
      notesWork: Array.isArray(notes),
      version: probe.version,
      stores: probe.stores,
    });
  })()`));

  check('升级后老的待办还在', migrated.todoText === '升级前就写好的待办', String(migrated.todoText));
  check('升级后完成状态没丢', migrated.todoDone === true, String(migrated.todoDone));
  check('升级后这一天的颜色没丢', migrated.theme === 'sky', String(migrated.theme));
  check('升级后习惯打卡没丢', migrated.habit === true, String(migrated.habit));
  check('升级后日记文字没丢', migrated.diary === '升级前的日记文字', String(migrated.diary));
  check('数据库升到了 v2', migrated.version === 2, String(migrated.version));
  check('5 张表全都在',
    migrated.stores.join(',') === 'days,notes,photos,sessions,settings',
    JSON.stringify(migrated.stores));
  check('新的 notes 表读写正常', migrated.notesWork === true);

  /* ── 1. 首次加载 ─────────────────────────────────────── */
  await cdp.send('Page.navigate', { url: TARGET_URL });
  await sleep(3000);

  const boot = await cdp.eval(`JSON.stringify({
    blocks: document.querySelectorAll('.block').length,
    addBtns: document.querySelectorAll('.block .add-btn').length,
    titles: [...document.querySelectorAll('.blk-title')].map(e => e.textContent),
    times:  [...document.querySelectorAll('.blk-time')].map(e => e.textContent),
    dateMain: document.getElementById('dateMain').textContent,
    dateSub: document.getElementById('dateSub').textContent,
    hasPlanLabel: !!document.getElementById('dhPlan'),
    hasTail: !!document.querySelector('.day-tail'),
    titleInTop: document.querySelectorAll('.blk-top .blk-title').length,
    addInTopRow: document.querySelectorAll('.blk-top .add-btn').length,
    subGone: document.querySelectorAll('.blk-sub, .blk-subline').length,
    theme: document.documentElement.getAttribute('data-theme'),
    err: document.getElementById('errbox').hidden ? '' : document.getElementById('errbox').textContent,
    goalNow: document.getElementById('goalNow').textContent,
  })`);
  const b = JSON.parse(boot);

  console.log('  ── 渲染 ──');
  check('时间块渲染出 7 块', b.blocks === 7, '实际 ' + b.blocks);
  check('每块右下角都有实心加号', b.addBtns === 7, '实际 ' + b.addBtns);
  check('日期标题不是占位符', b.dateMain !== '—' && b.dateMain.length > 0, b.dateMain);
  check('副标题显示今天/周几', /今天|周/.test(b.dateSub), b.dateSub);
  check('「今日计划 / 计划 12h」那行已经删掉', b.hasPlanLabel === false);
  check('最下面「到底了」那堆也删掉了', b.hasTail === false);
  check('时间块名称和时间段在同一行', b.titleInTop === 7, String(b.titleInTop));
  check('加号在块名那一行的最右边', b.addInTopRow === 7, String(b.addInTopRow));
  check('时间块下面的解释文字全删了', b.subGone === 0, String(b.subGone));
  check('默认主题是薄荷绿', b.theme === 'mint', b.theme);
  check('没有弹出错误框', b.err === '', b.err.slice(0, 200));
  check('7 个时间块标题正确',
    b.titles.join('|') === '英语|专业课 / 考研|午间|专业课 / 考研|杂事|运动|晚间',
    b.titles.join('|'));
  check('时间段简写正确（6:30-8 / 8-12 / 20-23）',
    b.times[0] === '6:30-8' && b.times[1] === '8-12' && b.times[6] === '20-23',
    b.times.join('|'));

  /* ── 1.5 课表预填 ────────────────────────────────────── */
  console.log('  ── 课表预填 ──');

  const sched = JSON.parse(await cdp.eval(`(async () => {
    const sch = await import('./js/schedule.js');
    const st = await import('./js/store.js');
    const t = st.todayKey();
    const day = await st.getDay(t);
    const all = Object.values(day.todos || {}).flat();
    const courses = all.filter(x => x.from === 'course');
    const blocks = Object.entries(day.todos || {})
      .filter(([, l]) => l.some(x => x.from === 'course'))
      .map(([k]) => k).sort();
    return JSON.stringify({
      week: sch.weekOf(t),
      weekday: sch.weekdayOf(t),
      expect: sch.coursesOn(t).length,
      expectTexts: sch.coursesOn(t).map(c => sch.courseText(c)),
      seeded: courses.length,
      texts: courses.map(x => x.text),
      blocks,
      totalTodos: all.length,
    });
  })()`));

  check('算得出今天是第几周', sched.week >= 1, `第 ${sched.week} 周`);
  check('按课表把今天的课填成了待办',
    sched.seeded === sched.expect && sched.expect > 0,
    `填了 ${sched.seeded}，课表说今天 ${sched.expect} 节`);
  check('课的文字和课表一致',
    JSON.stringify(sched.texts) === JSON.stringify(sched.expectTexts),
    JSON.stringify(sched.texts));
  check('课只落在上午(b2)和下午(b4)块里',
    sched.blocks.every(x => x === 'b2' || x === 'b4' || x === 'b6'),
    JSON.stringify(sched.blocks));
  check('每节课都带 📚 和教室',
    sched.texts.every(t => /^📚 /.test(t) && /·/.test(t)),
    JSON.stringify(sched.texts));

  /* 记下此刻的总数，后面「加一条」要拿它做基准 */
  const baseTotal = sched.totalTodos;

  /* ── 2. 版式 + 加一条待办 ────────────────────────────── */
  console.log('  ── 版式 ──');

  const design = JSON.parse(await cdp.eval(`JSON.stringify({
    footRight: (() => {
      const b = document.querySelector('.block[data-id="b1"] .add-btn');
      const f = document.querySelector('.block[data-id="b1"] .blk-top');
      if (!b || !f) return false;
      const br = f.getBoundingClientRect(), bb = b.getBoundingClientRect();
      return bb.right > br.left + br.width * 0.75;
    })(),
    addBtnText: (document.querySelector('.block[data-id="b1"] .add-btn') || {}).textContent,
    addBtnRadius: getComputedStyle(document.querySelector('.block[data-id="b1"] .add-btn')).borderTopLeftRadius,
    blockRadius: getComputedStyle(document.querySelector('.block[data-id="b1"]')).borderTopLeftRadius,
    blockBorderTop: parseFloat(getComputedStyle(document.querySelector('.block[data-id="b2"]')).borderTopWidth),
    oldAddRow: document.querySelectorAll('.todo.add-row').length,
  })`));
  check('加号在块名那一行的最右边', design.footRight === true, JSON.stringify(design));
  check('加号内容是 +', design.addBtnText === '+', String(design.addBtnText));
  check('加号是实心圆', parseFloat(design.addBtnRadius) > 10, design.addBtnRadius);
  check('时间块不再是圆角厚方框', design.blockRadius === '0px', design.blockRadius);
  check('时间块之间用横线分隔', design.blockBorderTop >= 1, String(design.blockBorderTop));
  check('旧的「+ 添加待办」输入行已经拿掉了', design.oldAddRow === 0, String(design.oldAddRow));

  console.log('  ── 待办 ──');
  await cdp.eval(`document.querySelector('.block[data-id="b1"] .add-btn').click()`);
  await sleep(450);

  const afterClick = JSON.parse(await cdp.eval(`JSON.stringify({
    count: document.querySelectorAll('.block[data-id="b1"] .todo').length,
    focused: !!(document.activeElement && document.activeElement.classList.contains('todo-input')),
  })`));
  check('点加号出现一条空待办', afterClick.count === 1, JSON.stringify(afterClick));
  check('新待办自动获得焦点（可以直接打字）', afterClick.focused === true, JSON.stringify(afterClick));

  await cdp.eval(`(() => {
    const ta = document.querySelector('.block[data-id="b1"] .todo .todo-input');
    ta.value = '冒烟测试待办A';
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    ta.blur();
    return true;
  })()`);
  await sleep(1200);

  const afterAdd = JSON.parse(await cdp.eval(`JSON.stringify({
    count: document.querySelectorAll('.block[data-id="b1"] .todo').length,
    text: (document.querySelector('.block[data-id="b1"] .todo .todo-input') || {}).value,
    total: document.getElementById('dhRight').textContent,
    hairline: parseFloat(getComputedStyle(document.querySelector('.block[data-id="b1"] .todo')).borderBottomWidth),
  })`));
  check('待办加进列表了', afterAdd.count === 1, '数量 ' + afterAdd.count);
  check('待办文字正确', afterAdd.text === '冒烟测试待办A', String(afterAdd.text));
  check('每条待办底下有横线', afterAdd.hairline >= 1, String(afterAdd.hairline));
  /* 注意：今天会预先填进当天的课，所以总数不是 1 —— 只验「比刚才多了一条」 */
  check('顶部计数跟着更新（比刚才多 1 条）',
    (() => {
      const m = /^0\/(\d+)$/.exec(afterAdd.total || '');
      return !!m && Number(m[1]) === baseTotal + 1;
    })(),
    `${afterAdd.total}，加之前总数 ${baseTotal}`);

  /* 每条待办单独左划 → 只专注这一条 */
  await cdp.eval(`(() => {
    const li = document.querySelector('.block[data-id="b1"] .todo');
    const r = li.getBoundingClientRect();
    const y = r.top + r.height / 2;
    const mk = (type, x) => new PointerEvent(type, {
      pointerId: 91, pointerType: 'touch', isPrimary: true,
      clientX: x, clientY: y, bubbles: true, cancelable: true,
    });
    li.dispatchEvent(mk('pointerdown', r.left + 230));
    li.dispatchEvent(mk('pointermove', r.left + 180));
    li.dispatchEvent(mk('pointermove', r.left + 120));
    li.dispatchEvent(mk('pointerup',   r.left + 85));
    return true;
  })()`);
  await sleep(900);

  const todoFocus = JSON.parse(await cdp.eval(`JSON.stringify({
    shown: document.getElementById('focusLayer').classList.contains('show'),
    name:  document.getElementById('fTodoName').textContent,
    block: document.getElementById('fBlockName').textContent,
  })`));
  check('单条待办左划能直接进专注', todoFocus.shown === true, JSON.stringify(todoFocus));
  check('页面中间显示的就是这条待办', todoFocus.name === '冒烟测试待办A', todoFocus.name);
  check('最上面一行还是它所属的时间块', todoFocus.block === '英语', todoFocus.block);

  /* 还没开始时往右划就能退出去 */
  await cdp.eval(`(() => {
    const layer = document.getElementById('focusLayer');
    const r = layer.getBoundingClientRect();
    const y = r.top + r.height / 2;
    const mk = (type, x) => new PointerEvent(type, {
      pointerId: 93, pointerType: 'touch', isPrimary: true,
      clientX: x, clientY: y, bubbles: true, cancelable: true,
    });
    layer.dispatchEvent(mk('pointerdown', r.left + 120));
    layer.dispatchEvent(mk('pointermove', r.left + 200));
    layer.dispatchEvent(mk('pointermove', r.left + 300));
    layer.dispatchEvent(mk('pointerup',   r.left + 360));
    return true;
  })()`);
  await sleep(800);
  check('还没开始时右划能退出去',
    (await cdp.eval(`document.getElementById('focusLayer').hidden`)) === true);

  /* ── 3. 刷新，验证持久化 ─────────────────────────────── */
  console.log('  ── 持久化（刷新页面） ──');
  await cdp.send('Page.navigate', { url: TARGET_URL });
  await sleep(3000);

  const afterReload = JSON.parse(await cdp.eval(`JSON.stringify({
    count: document.querySelectorAll('.block[data-id="b1"] .todo').length,
    text: (document.querySelector('.block[data-id="b1"] .todo .todo-input') || {}).value,
    total: document.getElementById('dhRight').textContent,
  })`));
  check('刷新后待办还在（IndexedDB 存住了）', afterReload.count === 1, '数量 ' + afterReload.count);
  check('刷新后文字没变', afterReload.text === '冒烟测试待办A', String(afterReload.text));

  /* ── 4. 勾选，验证进度条 ─────────────────────────────── */
  console.log('  ── 勾选与进度 ──');
  await cdp.eval(`(() => {
    document.querySelector('.block[data-id="b1"] .todo .tick').click();
    return true;
  })()`);
  await sleep(900);

  const afterTick = JSON.parse(await cdp.eval(`JSON.stringify({
    done: document.querySelectorAll('.block[data-id="b1"] .todo.done').length,
    goalNow: document.getElementById('goalNow').textContent,
    fill: document.getElementById('goalFill').style.width,
    total: document.getElementById('dhRight').textContent,
  })`));
  check('待办变成已完成', afterTick.done === 1, '数量 ' + afterTick.done);
  check('计数变成 1/N（勾了一条）',
    (() => {
      const m = /^1\/(\d+)$/.exec(afterTick.total || '');
      return !!m && Number(m[1]) === baseTotal + 1;
    })(),
    `${afterTick.total}，基准 ${baseTotal}`);
  /* 底部那条现在只读真实专注计时，勾待办不该再影响它 */
  check('勾待办不再改动底部专注条', afterTick.goalNow === '0h00m', afterTick.goalNow);
  check('专注条保持 0%', /^0(\.0)?%$/.test(afterTick.fill), afterTick.fill);

  /* ── 4.5 日记本（图文一条流） ────────────────────────── */
  console.log('  ── 日记本 ──');

  const diaryStruct = JSON.parse(await cdp.eval(`JSON.stringify({
    addBtn:   !!document.querySelector('#diary .diary-head .add-btn'),
    dateLabel: (document.querySelector('#diary .diary-date') || {}).textContent,
    flow:     !!document.querySelector('#diary .diary-flow'),
    picker:   !!document.querySelector('#diary input[type=file]'),
    noSubText: !document.querySelector('#diary .diary-sub'),
    noBigAddBtn: !document.querySelector('#diary .photo-add'),
    noCountLine: !document.querySelector('#diary .diary-count'),
    belowBlocks: (() => {
      const d = document.getElementById('diary');
      const b = document.getElementById('blocks');
      if (!d || !b) return false;
      return (b.compareDocumentPosition(d) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
    })(),
  })`));
  check('日记区排在时间块下面', diaryStruct.belowBlocks === true, JSON.stringify(diaryStruct));
  check('日记是一条流（不是文字框 + 图墙两张皮）', diaryStruct.flow === true, JSON.stringify(diaryStruct));
  check('日记左上角是日期', /\d+月\d+日/.test(diaryStruct.dateLabel || ''), String(diaryStruct.dateLabel));
  check('日记右上角是小加号', diaryStruct.addBtn === true);
  check('日记没有多余说明文字', diaryStruct.noSubText === true);
  check('日记没有那条大「加照片」按钮', diaryStruct.noBigAddBtn === true);
  check('日记没有「多少字多少张」那行', diaryStruct.noCountLine === true);
  check('日记有隐藏的文件选择框', diaryStruct.picker === true);

  /* 点 ＋ → 出「文字 / 照片」两个选项 */
  await cdp.eval(`document.querySelector('#diary .diary-head .add-btn').click()`);
  await sleep(500);
  const menu = JSON.parse(await cdp.eval(`JSON.stringify({
    visible: !document.querySelector('#diary .df-add').hidden,
    items: [...document.querySelectorAll('#diary .df-add button')].map(b => b.textContent),
  })`));
  check('点 ＋ 出现「文字 / 照片」两个选项',
    menu.visible === true && menu.items.join('/') === '文字/照片', JSON.stringify(menu));

  /* 加第一段文字 */
  await cdp.eval(`document.querySelectorAll('#diary .df-add button')[0].click()`);
  await sleep(800);
  const firstBlock = JSON.parse(await cdp.eval(`JSON.stringify({
    texts: document.querySelectorAll('#diary .df-text').length,
    focused: !!(document.activeElement && document.activeElement.classList.contains('df-text')),
  })`));
  check('点「文字」出现一个文字块', firstBlock.texts === 1, JSON.stringify(firstBlock));
  check('新文字块自动聚焦', firstBlock.focused === true, JSON.stringify(firstBlock));

  await cdp.eval(`(() => {
    const ta = document.querySelector('#diary .df-text');
    ta.value = '今天测试写了一段日记。';
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    ta.blur();
    return true;
  })()`);
  await sleep(1300);

  /* 加照片 */
  await cdp.eval(`(async () => {
    const c = document.createElement('canvas');
    c.width = 3000; c.height = 2000;
    const g = c.getContext('2d');
    g.fillStyle = '#3E8F71'; g.fillRect(0, 0, 3000, 2000);
    g.fillStyle = '#E9F6EF';
    g.font = 'bold 420px sans-serif';
    g.fillText('TEST', 700, 1160);
    const blob = await new Promise(r => c.toBlob(r, 'image/jpeg', 0.92));

    const dt = new DataTransfer();
    dt.items.add(new File([blob], 'test.jpg', { type: 'image/jpeg' }));
    const input = document.querySelector('#diary input[type=file]');
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`);
  await sleep(3000);

  const TODAY = await cdp.eval(`(async () => {
    const m = await import('./js/store.js');
    return m.todayKey();
  })()`);

  const afterPhoto = JSON.parse(await cdp.eval(`JSON.stringify({
    photos: document.querySelectorAll('#diary .df-photo').length,
    imgs:   document.querySelectorAll('#diary .df-photo img').length,
    order:  [...document.querySelector('#diary .diary-flow').children]
              .map(n => n.tagName === 'TEXTAREA' ? 'text' : 'photo'),
  })`));
  check('照片插进了日记流', afterPhoto.photos === 1, JSON.stringify(afterPhoto));
  check('缩略图真的解码出来了', afterPhoto.imgs === 1, JSON.stringify(afterPhoto));
  check('顺序是「文字 → 照片」（照片紧跟在字后面）',
    afterPhoto.order.join(',') === 'text,photo', JSON.stringify(afterPhoto.order));

  const stored = JSON.parse(await cdp.eval(`(async () => {
    const m = await import('./js/db.js');
    const all = await m.idbAll('photos');
    const p = all[0] || null;
    return JSON.stringify(p ? {
      n: all.length, w: p.w, h: p.h,
      fullBytes: p.blob ? p.blob.size : 0,
      thumbBytes: p.thumb ? p.thumb.size : 0,
      fullType: p.blob ? p.blob.type : '',
      day: p.day,
    } : { n: 0 });
  })()`));
  check('照片写进了 photos 表', stored.n === 1, JSON.stringify(stored));
  check('原图 3000×2000 被压到长边 1280',
    Math.max(stored.w || 0, stored.h || 0) === 1280, `${stored.w}×${stored.h}`);
  check('压缩后是 JPEG', stored.fullType === 'image/jpeg', stored.fullType);
  check('大图控制在 300KB 以内', stored.fullBytes > 0 && stored.fullBytes < 300 * 1024,
    stored.fullBytes + ' B');
  check('缩略图比大图小很多',
    stored.thumbBytes > 0 && stored.thumbBytes < stored.fullBytes / 3,
    `${stored.thumbBytes} B vs ${stored.fullBytes} B`);
  check('照片挂在今天的日期上', stored.day === TODAY, `${stored.day} vs ${TODAY}`);

  /* 照片**后面**再加一段文字 —— 这是你专门要求的 */
  await cdp.eval(`document.querySelector('#diary .diary-head .add-btn').click()`);
  await sleep(400);
  await cdp.eval(`document.querySelectorAll('#diary .df-add button')[0].click()`);
  await sleep(800);
  await cdp.eval(`(() => {
    const tas = document.querySelectorAll('#diary .df-text');
    const ta = tas[tas.length - 1];
    ta.value = '照片后面写的第二段。';
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    ta.blur();
    return true;
  })()`);
  await sleep(1300);

  const order2 = JSON.parse(await cdp.eval(`JSON.stringify({
    order: [...document.querySelector('#diary .diary-flow').children]
             .map(n => n.tagName === 'TEXTAREA' ? 'text' : 'photo'),
    texts: [...document.querySelectorAll('#diary .df-text')].map(t => t.value),
  })`));
  check('照片后面能接着写字（顺序 文字→照片→文字）',
    order2.order.join(',') === 'text,photo,text', JSON.stringify(order2.order));
  check('第二段文字内容对',
    order2.texts[1] === '照片后面写的第二段。', JSON.stringify(order2.texts));

  /* 刷新，验证都落盘了 */
  await cdp.send('Page.navigate', { url: TARGET_URL });
  await sleep(3400);
  const afterReloadDiary = JSON.parse(await cdp.eval(`JSON.stringify({
    order: [...document.querySelector('#diary .diary-flow').children]
             .map(n => n.tagName === 'TEXTAREA' ? 'text' : 'photo'),
    texts: [...document.querySelectorAll('#diary .df-text')].map(t => t.value),
    imgs: document.querySelectorAll('#diary .df-photo img').length,
  })`));
  check('刷新后顺序没变（文字→照片→文字）',
    afterReloadDiary.order.join(',') === 'text,photo,text', JSON.stringify(afterReloadDiary.order));
  check('刷新后两段文字都在',
    afterReloadDiary.texts[0] === '今天测试写了一段日记。'
    && afterReloadDiary.texts[1] === '照片后面写的第二段。',
    JSON.stringify(afterReloadDiary.texts));
  check('刷新后照片还在（缩略图重解码）', afterReloadDiary.imgs === 1, JSON.stringify(afterReloadDiary));

  /* 点开大图 + 删掉 */
  await cdp.eval(`document.querySelector('#diary .df-photo').click()`);
  await sleep(1000);
  const lb = JSON.parse(await cdp.eval(`JSON.stringify({
    shown: document.getElementById('lightbox').classList.contains('show'),
    blobSrc: String((document.querySelector('#lightbox .lb-img') || {}).src || '').startsWith('blob:'),
    btns: document.querySelectorAll('#lightbox .lb-btn').length,
  })`));
  check('点照片能看大图', lb.shown === true, JSON.stringify(lb));
  check('大图是从本地库读的 blob', lb.blobSrc === true, JSON.stringify(lb));
  check('大图界面有关闭和删除', lb.btns === 2, JSON.stringify(lb));

  await cdp.eval(`document.querySelector('#lightbox .lb-btn.danger').click()`);
  await sleep(1400);
  const afterDel = JSON.parse(await cdp.eval(`JSON.stringify({
    photos: document.querySelectorAll('#diary .df-photo').length,
    order: [...document.querySelector('#diary .diary-flow').children]
             .map(n => n.tagName === 'TEXTAREA' ? 'text' : 'photo'),
    lbHidden: document.getElementById('lightbox').hidden,
  })`));
  check('删除后照片从流里消失', afterDel.photos === 0, JSON.stringify(afterDel));
  check('删除后剩下的还是两段文字', afterDel.order.join(',') === 'text,text', JSON.stringify(afterDel.order));
  check('删除后大图界面收起', afterDel.lbHidden === true, JSON.stringify(afterDel));

  const photoGone = await cdp.eval(`(async () => {
    const m = await import('./js/db.js');
    return (await m.idbAll('photos')).length;
  })()`);
  check('删除后 photos 表也清干净了', photoGone === 0, '实际 ' + photoGone);

  /* ── 5. 切换颜色 ─────────────────────────────────────── */
  console.log('  ── 配色 ──');
  await cdp.eval(`document.getElementById('themeBtn').click()`);
  await sleep(700);
  const swatchCount = await cdp.eval(`document.querySelectorAll('.swatches .swatch').length`);
  check('色块共 20 个（19 色 + 默认）', swatchCount === 20, '实际 ' + swatchCount);

  await cdp.eval(`document.querySelector('.swatches .swatch[data-id="wine"]').click()`);
  await sleep(900);
  const afterTheme = JSON.parse(await cdp.eval(`JSON.stringify({
    theme: document.documentElement.getAttribute('data-theme'),
    meta: (document.querySelector('meta[name="theme-color"]') || {}).content,
  })`));
  check('整页换成酒红', afterTheme.theme === 'wine', afterTheme.theme);
  check('状态栏颜色跟着变', afterTheme.meta === '#813748', String(afterTheme.meta));

  /* 刷新后这一天应该记住酒红 */
  await cdp.send('Page.navigate', { url: TARGET_URL });
  await sleep(2800);
  const themeKept = await cdp.eval(`document.documentElement.getAttribute('data-theme')`);
  check('刷新后这天的颜色还是酒红（按天记住）', themeKept === 'wine', themeKept);

  /* ── 6. 小本子：周历 / 习惯 / 备份 ──────────────────── */
  console.log('  ── 小本子 ──');
  await cdp.eval(`document.getElementById('bookBtn').click()`);
  await sleep(1500);

  const bk = JSON.parse(await cdp.eval(`JSON.stringify({
    shown: !document.getElementById('bookSheet').hidden,
    tabs: [...document.querySelectorAll('#bookTabs button')].map(b => b.dataset.tab),
    tabOn: (document.querySelector('#bookTabs button.on') || {}).dataset?.tab,
    weeksVisible: !document.getElementById('tabWeeks').hidden,
    habitsHidden: document.getElementById('tabHabits').hidden,
    ioHidden: document.getElementById('tabIo').hidden,
    dows: [...document.querySelectorAll('#weekHead .wk-dow')].map(e => e.textContent),
    rows: document.querySelectorAll('#weekRows .wk-row').length,
    firstRowCells: document.querySelectorAll('#weekRows .wk-row:first-child .cell').length,
    firstRowLabels: document.querySelectorAll('#weekRows .wk-row:first-child .wk-label').length,
    rings: document.querySelectorAll('#weekRows .cell-ring').length,
    todayCells: document.querySelectorAll('#weekRows .cell.today').length,
    thisWeek: document.querySelectorAll('#weekRows .wk-row.this-week').length,
    modes: document.querySelectorAll('#stripModes button').length,
    modeOn: (document.querySelector('#stripModes button.on') || {}).dataset?.mode,
    note: document.getElementById('stripNote').textContent,
    scrollTop: document.getElementById('weekScroll').scrollTop,
  })`));

  check('小本子面板打开了', bk.shown === true, JSON.stringify(bk));
  check('有三个标签页（周历/习惯/备份）',
    bk.tabs.join(',') === 'weeks,habits,io', JSON.stringify(bk.tabs));
  check('默认停在周历页', bk.tabOn === 'weeks' && bk.weeksVisible === true, JSON.stringify(bk));
  check('星期表头是「一二三四五六日」', bk.dows.join('') === '一二三四五六日', bk.dows.join(''));
  check('一行正好 7 天（一周一循环）', bk.firstRowCells === 7, '实际 ' + bk.firstRowCells);
  check('每行左边有周标签', bk.firstRowLabels === 1, '实际 ' + bk.firstRowLabels);
  check('今天只被标出一次', bk.todayCells === 1, '实际 ' + bk.todayCells);
  check('本周那一行被标出来', bk.thisWeek === 1, '实际 ' + bk.thisWeek);
  check('圆环有两种读数可切', bk.modes === 2, '实际 ' + bk.modes);
  check('默认是待办模式', bk.modeOn === 'todo', String(bk.modeOn));
  check('打开时停在最上面（最近那一周）', bk.scrollTop === 0, String(bk.scrollTop));

  const weekTotal = (() => {
    const m = /共 (\d+) 周/.exec(bk.note || '');
    return m ? Number(m[1]) : 0;
  })();
  check('说明里报了总周数', weekTotal >= 20, String(weekTotal));
  check('首屏只画一批，不是把几十周一次画完',
    bk.rows === Math.min(14, weekTotal), `${bk.rows} / ${weekTotal}`);

  /* 往下滑 —— 应该补出更早的周 */
  await cdp.eval(`(() => {
    const el = document.getElementById('weekScroll');
    el.scrollTop = el.scrollHeight;
    el.dispatchEvent(new Event('scroll'));
    return true;
  })()`);
  await sleep(900);
  const afterScroll = JSON.parse(await cdp.eval(`JSON.stringify({
    rows: document.querySelectorAll('#weekRows .wk-row').length,
  })`));
  check('往下滑会补出更早的周（能一路看完所有历史）',
    afterScroll.rows > bk.rows, `${bk.rows} → ${afterScroll.rows}`);

  /* 小本子面板里也不许有小字 */
  const bookMin = await cdp.eval(`(() => {
    let min = 999, where = '';
    const walk = (n) => {
      for (const el of n.children) {
        const r = el.getBoundingClientRect();
        const own = [...el.childNodes].filter(c => c.nodeType === 3)
          .map(c => c.textContent).join('').trim();
        if (r.width > 0 && r.height > 0 && own) {
          const s = parseFloat(getComputedStyle(el).fontSize);
          if (s && s < min) { min = s; where = (el.className || el.tagName) + ' :: ' + own.slice(0, 12); }
        }
        walk(el);
      }
    };
    walk(document.getElementById('bookSheet'));
    return min + 'px @ ' + where;
  })()`);
  check('小本子面板里也没有小于 15px 的字', parseFloat(bookMin) >= 15, bookMin);

  /* 切专注时长模式 */
  await cdp.eval(`document.querySelector('#stripModes button[data-mode="focus"]').click()`);
  await sleep(1500);
  const focusMode = JSON.parse(await cdp.eval(`JSON.stringify({
    on:   (document.querySelector('#stripModes button.on') || {}).dataset?.mode,
    note: document.getElementById('stripNote').textContent,
  })`));
  check('能切到「专注时长」模式', focusMode.on === 'focus', JSON.stringify(focusMode));
  check('说明文字跟着改', /专注/.test(focusMode.note), focusMode.note);

  await cdp.eval(`document.querySelector('#stripModes button[data-mode="todo"]').click()`);
  await sleep(1300);
  check('能切回待办模式',
    (await cdp.eval(`(document.querySelector('#stripModes button.on')||{}).dataset?.mode`)) === 'todo');

  /* 习惯页 */
  await cdp.eval(`document.querySelector('#bookTabs button[data-tab="habits"]').click()`);
  await sleep(800);
  const hx = JSON.parse(await cdp.eval(`JSON.stringify({
    visible: !document.getElementById('tabHabits').hidden,
    weeksHidden: document.getElementById('tabWeeks').hidden,
    names: [...document.querySelectorAll('#matrix .hx-name')].map(e => e.textContent),
    heads: document.querySelectorAll('#matrix .hx-head').length,
    cells: document.querySelectorAll('#matrix .hx-cell').length,
    totals: document.getElementById('matrixTotals').textContent,
  })`));
  check('能切到习惯页', hx.visible === true && hx.weeksHidden === true, JSON.stringify(hx));
  check('习惯 4 行', hx.names.join(',') === '英语,背单词,运动,练字', JSON.stringify(hx.names));
  check('习惯表按周分列，列数等于周数', hx.heads === weekTotal, `${hx.heads} vs ${weekTotal}`);
  check('格子数 = 4 行 × 周数',
    hx.cells === hx.names.length * hx.heads,
    `${hx.cells} vs ${hx.names.length * hx.heads}`);
  check('小计报了每个习惯坚持多少天', /英语 \d+ 天/.test(hx.totals), hx.totals);

  /* 备份页 */
  await cdp.eval(`document.querySelector('#bookTabs button[data-tab="io"]').click()`);
  await sleep(700);
  const ioTab = JSON.parse(await cdp.eval(`JSON.stringify({
    visible: !document.getElementById('tabIo').hidden,
    btns: document.querySelectorAll('#tabIo .io-btn').length,
  })`));
  check('能切到备份页', ioTab.visible === true, JSON.stringify(ioTab));
  check('备份页有 4 个按钮', ioTab.btns === 4, String(ioTab.btns));

  await cdp.eval(`document.querySelector('#bookTabs button[data-tab="weeks"]').click()`);
  await sleep(700);
  check('能切回周历页',
    (await cdp.eval(`!document.getElementById('tabWeeks').hidden`)) === true);

  /* ── 7. 切到前一天再回来 ─────────────────────────────── */
  console.log('  ── 切天 ──');
  await cdp.eval(`document.getElementById('bookClose').click()`);
  await sleep(500);
  const d0 = await cdp.eval(`document.getElementById('dateMain').textContent`);
  await cdp.eval(`document.getElementById('prevDay').click()`);
  await sleep(900);
  const d1 = await cdp.eval(`document.getElementById('dateMain').textContent`);
  check('点左箭头能翻到前一天', d1 !== d0, d0 + ' → ' + d1);
  await cdp.eval(`document.getElementById('dateBtn').click()`);
  await sleep(900);
  const d2 = await cdp.eval(`document.getElementById('dateMain').textContent`);
  check('点日期能回到今天', d2 === d0, d2);

  /* ── 8. iPhone 尺寸下的真实字号 ──────────────────────── */
  console.log('  ── 字号（模拟 iPhone 393×852） ──');
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 393, height: 852, deviceScaleFactor: 3, mobile: true,
  });
  await sleep(600);

  const fonts = JSON.parse(await cdp.eval(`JSON.stringify({
    todo:   getComputedStyle(document.querySelector('.todo:not(.from-course) .todo-input')).fontSize,
    title:  getComputedStyle(document.querySelector('.blk-title')).fontSize,
    time:   getComputedStyle(document.querySelector('.blk-time')).fontSize,
    course: document.querySelector('.todo.from-course .todo-input') ? getComputedStyle(document.querySelector('.todo.from-course .todo-input')).fontSize : 'none',
    date:   getComputedStyle(document.getElementById('dateMain')).fontSize,
    smallest: ${SMALLEST},
  })`));

  check('待办正文 19px（比备忘录 17pt 大）', fonts.todo === '19px', fonts.todo);
  check('时间块标题 20px（压缩过）', fonts.title === '20px', fonts.title);

  check('课程待办字号 17px（比普通待办小一档）', fonts.course === '17px', fonts.course);
  check('时间刻度 15px', fonts.time === '15px', fonts.time);
  check('日期标题 19px', fonts.date === '19px', fonts.date);
  check('全页没有任何小于 15px 的字', parseFloat(fonts.smallest) >= 15, fonts.smallest);

  /* 字号三档已经按你的要求删掉了 —— 只保留一个确认 */
  await cdp.eval(`document.getElementById('themeBtn').click()`);
  await sleep(700);
  const fsGone = JSON.parse(await cdp.eval(`JSON.stringify({
    fsBtns: document.querySelectorAll('#fsBtns button').length,
    strictBtns: document.querySelectorAll('#strictBtns button').length,
    swatches: document.querySelectorAll('.swatches .swatch').length,
    explainers: (() => { const t = document.getElementById('themeSheet'); const bad = t.querySelector('.sheet-title') || t.querySelector('.sheet-note') || t.querySelector('.fs-row'); return bad ? bad.className : ''; })(),
  })`));
  check('字号三档已经删掉', fsGone.fsBtns === 0, String(fsGone.fsBtns));
  check('宽松/严格已经删掉', fsGone.strictBtns === 0, String(fsGone.strictBtns));
  check('颜色排满（19 色 + 默认 = 20 格）', fsGone.swatches === 20, String(fsGone.swatches));
  check('外观面板里没有标题/说明/字号行', fsGone.explainers === '', JSON.stringify(fsGone.explainers));
  await cdp.eval(`document.getElementById('scrim').click()`);
  await sleep(600);
  /* ── 9. 「进行中」高亮是否指对了 ─────────────────────── */
  console.log('  ── 当前时间块高亮 ──');
  const nowInfo = JSON.parse(await cdp.eval(`JSON.stringify((() => {
    const nowMin = new Date().getHours() * 60 + new Date().getMinutes();
    const toM = (h) => { const p = h.split(':'); return Number(p[0]) * 60 + (p[1] ? Number(p[1]) : 0); };
    const blocks = [...document.querySelectorAll('.block')];
    let expected = null;
    for (const b of blocks) {
      const t = b.querySelector('.blk-time').textContent;
      const [s, e] = t.split('-').map(x => x.trim());
      if (nowMin >= toM(s) && nowMin < toM(e)) { expected = b.dataset.id; break; }
    }
    const marked = blocks.filter(b => b.classList.contains('is-now')).map(b => b.dataset.id);
    return { nowMin, expected, marked };
  })())`));
  if (nowInfo.expected) {
    check('「进行中」正好标在当前那一块上',
      nowInfo.marked.length === 1 && nowInfo.marked[0] === nowInfo.expected,
      `应该 ${nowInfo.expected}，实际 [${nowInfo.marked}]`);
  } else {
    check('当前时间不在任何时间段内，那就一块都不该高亮',
      nowInfo.marked.length === 0,
      `实际 [${nowInfo.marked}]`);
  }

  /* ── 10. 专注页（点一下开始 / 点一下停止） ──────────── */
  console.log('  ── 专注 ──');

  await cdp.eval(`(() => {
    const day = document.getElementById('day');
    const r = day.getBoundingClientRect();
    const y = r.top + 160;
    const mk = (type, x) => new PointerEvent(type, {
      pointerId: 77, pointerType: 'touch', isPrimary: true,
      clientX: x, clientY: y, bubbles: true, cancelable: true,
    });
    day.dispatchEvent(mk('pointerdown', r.left + 300));
    day.dispatchEvent(mk('pointermove', r.left + 250));
    day.dispatchEvent(mk('pointermove', r.left + 160));
    day.dispatchEvent(mk('pointerup',   r.left + 120));
    return true;
  })()`);
  await sleep(800);

  const p1 = JSON.parse(await cdp.eval(`JSON.stringify({
    shown: document.getElementById('focusLayer').classList.contains('show'),
    block: document.getElementById('fBlockName').textContent,
    time:  document.getElementById('fBlockTime').textContent,
    startText: document.getElementById('fStart').textContent,
    circles: document.querySelectorAll('#fBar .f-circle').length,
    labels: [...document.querySelectorAll('#fBar .f-circle')].map(b => b.textContent),
    hasStats: !!document.querySelector('#focusLayer .f-stat'),
    hasHold:  !!document.getElementById('fHold'),
    hasLookup: !!document.getElementById('fLookup'),
    hasScreen: !!document.getElementById('fScreen'),
    hasExit:   !!document.getElementById('fExit'),
    hasPick:   !!document.getElementById('fPick'),
  })`));

  check('左划打开专注页', p1.shown === true, JSON.stringify(p1));
  check('最上面一行是「块名 + 时间段」',
    !!p1.block && p1.block !== '—' && /\d{2}:\d{2}[–-]\d{2}:\d{2}/.test(p1.time),
    `${p1.block} ／ ${p1.time}`);
  check('开始按钮写着 ▶', p1.startText === '▶', p1.startText);
  check('底部只剩 熄灯 + 倒计时 两个圆', p1.circles === 2, String(p1.circles));
  check('两个圆是 🌙 和 ⏱', p1.labels.join('') === '🌙⏱', JSON.stringify(p1.labels));
  check('🫘 查题已经删掉', p1.hasLookup === false);
  check('📴 息屏已经删掉', p1.hasScreen === false);
  check('那个 ✕ 退出也删掉了', p1.hasExit === false);
  check('页面上没有统计格子', p1.hasStats === false);
  check('那个大圆环也拿掉了', p1.hasHold === false);
  check('「换时间块」已经拿掉了', p1.hasPick === false);

  /* 点一下开始 */
  await cdp.eval(`document.getElementById('fStart').click()`);
  await sleep(900);
  const running = JSON.parse(await cdp.eval(`JSON.stringify({
    running: document.getElementById('focusLayer').classList.contains('is-running'),
    btn: document.getElementById('fStart').textContent,
  })`));
  check('点一下就开始计时', running.running === true, JSON.stringify(running));
  check('按钮变成 ■', running.btn === '■', running.btn);

  const c1 = await cdp.eval(`document.getElementById('fClock').textContent`);
  await sleep(2200);
  const c2 = await cdp.eval(`document.getElementById('fClock').textContent`);
  check('计时器在走', c1 !== c2, c1 + ' → ' + c2);
  check('计时器格式是 时:分:秒', /^\d{2}:\d{2}:\d{2}$/.test(c2), c2);

  /* ⏱ 倒计时：5 的倍数，到点不退出专注 */
  await cdp.eval(`document.getElementById('fCd').click()`);
  await sleep(600);
  const picker = JSON.parse(await cdp.eval(`JSON.stringify({
    visible: !document.getElementById('fCdPicker').hidden,
    options: [...document.querySelectorAll('#fCdPicker .cd-item')].map(b => Number(b.dataset.min)),
  })`));
  check('点 ⏱ 弹出倒计时选项', picker.visible === true, JSON.stringify(picker));
  check('选项都是 5 的倍数',
    picker.options.length >= 4 && picker.options.every(n => n % 5 === 0),
    JSON.stringify(picker.options));

  await cdp.eval(`document.querySelector('#fCdPicker .cd-item[data-min="5"]').click()`);
  await sleep(900);
  const cd = JSON.parse(await cdp.eval(`(async () => {
    const m = await import('./js/store.js');
    const list = await m.sessionsForDate(m.todayKey());
    const s = list.find(x => !x.endedAt) || list[0] || null;
    return JSON.stringify({
      lineShown: !document.getElementById('fCdLine').hidden,
      lineText: document.getElementById('fCdLine').textContent,
      open: s ? (s.marks || []).filter(x => x.kind === 'countdown' && x.to === null).length : -1,
      running: s ? !s.endedAt : false,
    });
  })()`));
  check('倒计时开始了', cd.lineShown === true && /⏱/.test(cd.lineText), JSON.stringify(cd));
  check('倒计时记进了会话', cd.open === 1, JSON.stringify(cd));
  check('倒计时开始后没有退出专注', cd.running === true, JSON.stringify(cd));

  /* 切走再回来 —— 计时不停，时长不扣 */
  await cdp.eval(`Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    document.dispatchEvent(new Event('visibilitychange')); true`);
  await sleep(1600);
  await cdp.eval(`Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
    document.dispatchEvent(new Event('visibilitychange')); true`);
  await sleep(900);
  check('切走再回来计时没有停',
    (await cdp.eval(`document.getElementById('focusLayer').classList.contains('is-running')`)) === true);

  /* 点一下 ■ 停止 → 弹出写一句话的框 */
  await cdp.eval(`document.getElementById('fStart').click()`);
  await sleep(1000);
  const noteState = JSON.parse(await cdp.eval(`JSON.stringify({
    noteVisible: !document.getElementById('fNote').hidden,
    noteValue: document.getElementById('fNoteText').value,
    wordsInNote: (() => { const n = document.getElementById('fNote'); return n.textContent.replace(/\\s/g, '').replace(/✓/g, '').length; })(),
    barHidden: document.getElementById('fBar').hidden,
    focused: !!(document.activeElement && document.activeElement.id === 'fNoteText'),
  })`));
  check('点一下 ■ 就停止并弹出写一句话的框', noteState.noteVisible === true, JSON.stringify(noteState));
  check('这个框里一个字都没写', noteState.wordsInNote === 0, `框里有 ${noteState.wordsInNote} 个字`);
  check('框是空的而且已经聚焦', noteState.noteValue === '' && noteState.focused === true,
    JSON.stringify(noteState));
  check('弹框时底部圆圈收起来了', noteState.barHidden === true, JSON.stringify(noteState));

  await cdp.eval(`(() => {
    const ta = document.getElementById('fNoteText');
    ta.value = '今天状态不错，明天继续保持';
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    document.getElementById('fNoteOk').click();
    return true;
  })()`);
  await sleep(1400);

  const saved = JSON.parse(await cdp.eval(`(async () => {
    const m = await import('./js/store.js');
    const f = await import('./js/focus.js');
    const list = await m.sessionsForDate(m.todayKey());
    const s = list[list.length - 1] || null;
    const r = s ? f.summarize(s) : null;
    return JSON.stringify({
      n: list.length,
      ended: s ? !!s.endedAt : false,
      note: s ? s.note : null,
      total: r ? r.totalMs : -1,
      effective: r ? r.effectiveMs : -1,
      layerHidden: document.getElementById('focusLayer').hidden,
      goalNow: document.getElementById('goalNow').textContent,
    });
  })()`));

  check('会话写进数据库并结束', saved.n >= 1 && saved.ended === true, JSON.stringify(saved));
  check('那句话存下来了', saved.note === '今天状态不错，明天继续保持', JSON.stringify(saved.note));
  check('有效时长 = 总时长（切走一律不扣）',
    saved.effective === saved.total && saved.total > 0,
    `有效 ${saved.effective} / 总 ${saved.total}`);
  check('写完后专注页自动收起', saved.layerHidden === true, JSON.stringify(saved));

  /* 最关键的一条：结束后底部要真的显示出来，不能是 0 */
  check('结束后底部目标条显示了本次时长（不是 0）',
    saved.goalNow !== '0h00m' && saved.goalNow !== '0s' && /[1-9]/.test(saved.goalNow),
    `底部显示 "${saved.goalNow}"`);

  /* ── 10.7 目标栏 ─────────────────────────────────────── */
  console.log('  ── 目标栏 ──');

  /* 先把日总结打开 */
  await cdp.eval(`(() => {
    const day = document.getElementById('day');
    const r = day.getBoundingClientRect();
    const y = r.top + 160;
    const mk = (type, x) => new PointerEvent(type, {
      pointerId: 85, pointerType: 'touch', isPrimary: true,
      clientX: x, clientY: y, bubbles: true, cancelable: true,
    });
    day.dispatchEvent(mk('pointerdown', r.left + 120));
    day.dispatchEvent(mk('pointermove', r.left + 200));
    day.dispatchEvent(mk('pointermove', r.left + 300));
    day.dispatchEvent(mk('pointerup',   r.left + 360));
    return true;
  })()`);
  await sleep(1200);

  const g0 = JSON.parse(await cdp.eval(`JSON.stringify({
    summaryShown: document.getElementById('summaryLayer').classList.contains('show'),
    hasGoals: !!document.getElementById('sumGoals'),
    hasAdd: !!document.querySelector('#sumGoals .goal-add'),
    doneCardHidden: document.getElementById('goalsDoneCard').hidden,
    aboveTimeline: (() => {
      const g = document.querySelector('.goals-card');
      const t = document.querySelector('.sum-main');
      if (!g || !t) return false;
      return (g.compareDocumentPosition(t) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
    })(),
  })`));

  check('日总结页打开了', g0.summaryShown === true, JSON.stringify(g0));
  check('最上面有目标栏', g0.hasGoals === true, JSON.stringify(g0));
  check('目标栏在时间轴/扇形图上面', g0.aboveTimeline === true, JSON.stringify(g0));
  check('目标栏有一个加号', g0.hasAdd === true, JSON.stringify(g0));
  check('还没有完成的目标时，底下那块是收起的', g0.doneCardHidden === true, JSON.stringify(g0));

  /* 加两个目标 */
  await cdp.eval(`window.prompt = () => '考研上岸'`);
  await cdp.eval(`document.querySelector('#sumGoals .goal-add').click()`);
  await sleep(700);
  await cdp.eval(`window.prompt = () => '每天背 50 个单词'`);
  await cdp.eval(`document.querySelector('#sumGoals .goal-add').click()`);
  await sleep(700);

  const g1 = JSON.parse(await cdp.eval(`JSON.stringify({
    items: document.querySelectorAll('#sumGoals .goal-item').length,
    texts: [...document.querySelectorAll('#sumGoals .goal-text')].map(t => t.value),
    ticks: document.querySelectorAll('#sumGoals .goal-tick').length,
  })`));
  check('加了两条目标', g1.items === 2, JSON.stringify(g1));
  check('目标文字对',
    g1.texts.join('|') === '考研上岸|每天背 50 个单词', JSON.stringify(g1.texts));
  check('每条目标都有一个圆圈（待办的样子）', g1.ticks === 2, String(g1.ticks));

  /* 勾掉第一条 */
  await cdp.eval(`document.querySelector('#sumGoals .goal-tick').click()`);
  await sleep(900);

  const g2 = JSON.parse(await cdp.eval(`JSON.stringify({
    openItems: document.querySelectorAll('#sumGoals .goal-item').length,
    openTexts: [...document.querySelectorAll('#sumGoals .goal-text')].map(t => t.value),
    doneCardHidden: document.getElementById('goalsDoneCard').hidden,
    doneItems: document.querySelectorAll('#sumGoalsDone .goal-item').length,
    doneText: (document.querySelector('#sumGoalsDone .goal-text') || {}).textContent,
    doneDate: (document.querySelector('#sumGoalsDone .goal-date') || {}).textContent,
    belowSleep: (() => {
      const s = document.getElementById('sumSleep');
      const d = document.getElementById('goalsDoneCard');
      if (!s || !d) return false;
      return (s.compareDocumentPosition(d) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
    })(),
  })`));

  check('勾掉后从上面消失了', g2.openItems === 1, JSON.stringify(g2));
  check('上面剩下没勾的那条', g2.openTexts[0] === '每天背 50 个单词', JSON.stringify(g2.openTexts));
  check('底下那块展开了', g2.doneCardHidden === false, JSON.stringify(g2));
  check('勾掉的那条沉到了底下', g2.doneItems === 1 && g2.doneText === '考研上岸', JSON.stringify(g2));
  check('沉到底下时带了完成日期', /\d+月\d+日/.test(g2.doneDate || ''), String(g2.doneDate));
  check('它就在月亮太阳下面', g2.belowSleep === true, JSON.stringify(g2));

  /* 刷新 → 每天都看得到 */
  await cdp.send('Page.navigate', { url: TARGET_URL });
  await sleep(3400);
  await cdp.eval(`(() => {
    const day = document.getElementById('day');
    const r = day.getBoundingClientRect();
    const y = r.top + 160;
    const mk = (type, x) => new PointerEvent(type, {
      pointerId: 86, pointerType: 'touch', isPrimary: true,
      clientX: x, clientY: y, bubbles: true, cancelable: true,
    });
    day.dispatchEvent(mk('pointerdown', r.left + 120));
    day.dispatchEvent(mk('pointermove', r.left + 200));
    day.dispatchEvent(mk('pointermove', r.left + 300));
    day.dispatchEvent(mk('pointerup',   r.left + 360));
    return true;
  })()`);
  await sleep(1300);

  const g3 = JSON.parse(await cdp.eval(`JSON.stringify({
    openItems: document.querySelectorAll('#sumGoals .goal-item').length,
    doneItems: document.querySelectorAll('#sumGoalsDone .goal-item').length,
  })`));
  check('刷新后没勾的还在', g3.openItems === 1, JSON.stringify(g3));
  check('刷新后完成的还在底下', g3.doneItems === 1, JSON.stringify(g3));

  /* 翻到别的日子，目标依然在（它是全局的） */
  await cdp.eval(`document.getElementById('sumClose').click()`);
  await sleep(600);
  await cdp.eval(`document.getElementById('prevDay').click()`);
  await sleep(1200);
  await cdp.eval(`(() => {
    const day = document.getElementById('day');
    const r = day.getBoundingClientRect();
    const y = r.top + 160;
    const mk = (type, x) => new PointerEvent(type, {
      pointerId: 87, pointerType: 'touch', isPrimary: true,
      clientX: x, clientY: y, bubbles: true, cancelable: true,
    });
    day.dispatchEvent(mk('pointerdown', r.left + 120));
    day.dispatchEvent(mk('pointermove', r.left + 200));
    day.dispatchEvent(mk('pointermove', r.left + 300));
    day.dispatchEvent(mk('pointerup',   r.left + 360));
    return true;
  })()`);
  await sleep(1300);

  const g4 = JSON.parse(await cdp.eval(`JSON.stringify({
    date: document.getElementById('sumDate').textContent,
    openItems: document.querySelectorAll('#sumGoals .goal-item').length,
    doneItems: document.querySelectorAll('#sumGoalsDone .goal-item').length,
  })`));
  check('换到前一天，目标照样在（目标是全局的）',
    g4.openItems === 1 && g4.doneItems === 1, JSON.stringify(g4));

  /* 长按隐藏 */
  await cdp.eval(`window.confirm = () => true`);
  await cdp.eval(`(() => {
    const row = document.querySelector('#sumGoals .goal-item');
    if (!row) return true;
    const r = row.getBoundingClientRect();
    row.dispatchEvent(new PointerEvent('pointerdown', {
      pointerId: 88, pointerType: 'touch', isPrimary: true,
      clientX: r.left + 20, clientY: r.top + 10, bubbles: true, cancelable: true,
    }));
    return true;
  })()`);
  await sleep(1000);
  await cdp.eval(`(() => {
    const row = document.querySelector('#sumGoals .goal-item');
    if (!row) return true;
    const r = row.getBoundingClientRect();
    row.dispatchEvent(new PointerEvent('pointerup', {
      pointerId: 88, pointerType: 'touch', isPrimary: true,
      clientX: r.left + 20, clientY: r.top + 10, bubbles: true, cancelable: true,
    }));
    return true;
  })()`);
  await sleep(900);

  const g5 = JSON.parse(await cdp.eval(`JSON.stringify({
    openItems: document.querySelectorAll('#sumGoals .goal-item').length,
    hiddenBtn: (document.querySelector('#sumGoalsHidden .goal-hidden') || {}).textContent,
  })`));
  check('长按能把目标隐藏掉', g5.openItems === 0, JSON.stringify(g5));
  check('隐藏后底下有「已隐藏 N 条」可以找回来',
    /已隐藏 1 条/.test(g5.hiddenBtn || ''), String(g5.hiddenBtn));

  await cdp.eval(`document.querySelector('#sumGoalsHidden .goal-hidden').click()`);
  await sleep(600);
  await cdp.eval(`document.querySelector('#sumGoalsHidden .goal-restore').click()`);
  await sleep(900);
  check('点「全部恢复」能找回来',
    (await cdp.eval(`document.querySelectorAll('#sumGoals .goal-item').length`)) === 1);

  await cdp.eval(`document.getElementById('sumClose').click()`);
  await sleep(700);

  /* 目标栏测试翻到了前一天，这里必须回到今天 ——
     不然后面开的专注会话会记到昨天去 */
  await cdp.eval(`document.getElementById('dateBtn').click()`);
  await sleep(1200);
  check('测试收尾：回到今天',
    /今天/.test(await cdp.eval(`document.getElementById('dateSub').textContent`)));

  /* ── 10.5 熄灯模式 + 页面被杀掉后接着算 ──────────────── */
  console.log('  ── 熄灯 & 断点续算 ──');

  /* 再左划开一次面板 */
  await cdp.eval(`(() => {
    const day = document.getElementById('day');
    const r = day.getBoundingClientRect();
    const y = r.top + 160;
    const mk = (type, x) => new PointerEvent(type, {
      pointerId: 79, pointerType: 'touch', isPrimary: true,
      clientX: x, clientY: y, bubbles: true, cancelable: true,
    });
    day.dispatchEvent(mk('pointerdown', r.left + 300));
    day.dispatchEvent(mk('pointermove', r.left + 250));
    day.dispatchEvent(mk('pointermove', r.left + 160));
    day.dispatchEvent(mk('pointerup',   r.left + 120));
    return true;
  })()`);
  await sleep(800);

  await cdp.eval(`document.getElementById('fLights').click()`);
  await sleep(450);
  const lights = JSON.parse(await cdp.eval(`JSON.stringify({
    off: document.getElementById('focusLayer').classList.contains('lights-off'),
    bg:  getComputedStyle(document.getElementById('focusLayer')).backgroundColor,
    btn: document.getElementById('fLights').textContent,
  })`));
  check('熄灯模式打开', lights.off === true, JSON.stringify(lights));
  check('熄灯后背景是纯黑（OLED 真省电）', lights.bg === 'rgb(0, 0, 0)', lights.bg);
  check('熄灯圆圈变成亮起状态', /🌙/.test(lights.btn), lights.btn);

  await cdp.eval(`document.getElementById('fLights').click()`);
  await sleep(350);
  check('再点一下能开回灯',
    (await cdp.eval(`document.getElementById('focusLayer').classList.contains('lights-off')`)) === false);

  /* 开一次专注，然后直接刷新 —— 相当于 iOS 把页面回收了 */
  await cdp.eval('document.getElementById("fStart").click()');
  await sleep(1900);
  check('又开了一次专注',
    (await cdp.eval(`document.getElementById('focusLayer').classList.contains('is-running')`)) === true);

  await cdp.send('Page.navigate', { url: TARGET_URL });
  await sleep(3400);

  const resumed = JSON.parse(await cdp.eval(`JSON.stringify({
    shown:   document.getElementById('focusLayer').classList.contains('show'),
    running: document.getElementById('focusLayer').classList.contains('is-running'),
    clock:   document.getElementById('fClock').textContent,
  })`));
  const resumedSecs = (() => {
    const p = String(resumed.clock || '0:0:0').split(':').map(Number);
    return p[0] * 3600 + p[1] * 60 + p[2];
  })();
  check('页面被回收后，专注自动接着算',
    resumed.running === true && resumed.shown === true, JSON.stringify(resumed));
  check('续算的计时不是从 0 开始', resumedSecs >= 2, resumed.clock);

  const twoSessions = await cdp.eval(`(async () => {
    const m = await import('./js/store.js');
    return (await m.sessionsForDate(m.todayKey())).length;
  })()`);
  check('数据库里现在有 2 条会话', twoSessions === 2, '实际 ' + twoSessions);

  /* ── 10.95 备份导入往返（会清库，所以放最后） ────────── */
  console.log('  ── 备份导入 ──');

  const imported = JSON.parse(await cdp.eval(`(async () => {
    const zipMod = await import('./js/zip.js');
    const bk = await import('./js/backup.js');
    const db = await import('./js/db.js');

    const day = {
      date: '2020-01-01', theme: 'sky',
      todos: { b1: [{ id: 't9', text: '导入进来的待办', done: true, createdAt: 1, doneAt: 2 }] },
      habits: { '英语': true },
      diary: { text: '这是从备份导入的日记' },
      photos: ['ptest1'],
      sleepAt: null, wakeAt: null,
    };
    /* 造一段假 JPEG 字节，验证二进制能原样往返 */
    const px = new Uint8Array([255, 216, 255, 224, 0, 16, 74, 70, 73, 70, 0, 1]);

    const blob = await zipMod.createZip([
      { name: 'data.json', data: JSON.stringify({
        meta: { app: 'todo-notebook', format: 1 },
        days: [day],
        settings: [{ key: 'app', theme: 'sky', fs: 1 }],
        sessions: [{ id: 'zz', date: '2020-01-01', startedAt: 1, endedAt: 2, away: [] }],
        notes: [{ id: 'n1', text: '备份里的便签', color: 'green', pinned: true, createdAt: 5, updatedAt: 6 }],
      }) },
      { name: 'photos/ptest1.jpg', data: px },
      { name: 'photos/ptest1.thumb.jpg', data: px },
      { name: 'photos/ptest1.json', data: JSON.stringify({ id: 'ptest1', day: '2020-01-01', w: 10, h: 10 }) },
    ]);

    const r = await bk.importAll(new File([blob], 'b.zip', { type: 'application/zip' }), { replace: true });

    const days = await db.idbAll('days');
    const photos = await db.idbAll('photos');
    const sessions = await db.idbAll('sessions');
    const notes = await db.idbAll('notes');
    const d0 = days[0] || {};
    return JSON.stringify({
      r,
      dayCount: days.length,
      dayDate: d0.date,
      dayTheme: d0.theme,
      todoText: d0.todos && d0.todos.b1 && d0.todos.b1[0] && d0.todos.b1[0].text,
      todoDone: d0.todos && d0.todos.b1 && d0.todos.b1[0] && d0.todos.b1[0].done,
      habit: d0.habits && d0.habits['英语'],
      diary: d0.diary && d0.diary.text,
      photoCount: photos.length,
      photoType: photos[0] && photos[0].blob && photos[0].blob.type,
      photoSize: photos[0] && photos[0].blob && photos[0].blob.size,
      thumbSize: photos[0] && photos[0].thumb && photos[0].thumb.size,
      photoW: photos[0] && photos[0].w,
      sessionCount: sessions.length,
      noteCount: notes.length,
      noteText: notes[0] && notes[0].text,
      noteColor: notes[0] && notes[0].color,
      notePinned: notes[0] && notes[0].pinned,
    });
  })()`));

  check('导入返回了统计', imported.r && imported.r.days === 1 && imported.r.replaced === true,
    JSON.stringify(imported.r));
  check('导入把库替换成备份内容', imported.dayCount === 1, String(imported.dayCount));
  check('导入的日期正确', imported.dayDate === '2020-01-01', String(imported.dayDate));
  check('导入的颜色正确', imported.dayTheme === 'sky', String(imported.dayTheme));
  check('导入的待办文字正确', imported.todoText === '导入进来的待办', String(imported.todoText));
  check('导入的待办勾选状态正确', imported.todoDone === true, String(imported.todoDone));
  check('导入的习惯打卡正确', imported.habit === true, String(imported.habit));
  check('导入的日记文字正确', imported.diary === '这是从备份导入的日记', String(imported.diary));
  check('导入的照片还原成 Blob', imported.photoCount === 1 && imported.photoType === 'image/jpeg',
    JSON.stringify(imported));
  check('照片字节数一个不多一个不少', imported.photoSize === 12, String(imported.photoSize));
  check('缩略图也还原了', imported.thumbSize === 12, String(imported.thumbSize));
  check('照片元信息回来了', imported.photoW === 10, String(imported.photoW));
  check('专注会话也导进来了', imported.sessionCount === 1, String(imported.sessionCount));
  check('便签也导进来了', imported.noteCount === 1, String(imported.noteCount));
  check('便签内容和颜色都对',
    imported.noteText === '备份里的便签' && imported.noteColor === 'green' && imported.notePinned === true,
    JSON.stringify({ t: imported.noteText, c: imported.noteColor, p: imported.notePinned }));

  /* ── 11. 控制台与网络 ────────────────────────────────── */
  console.log('  ── 控制台与网络 ──');
  /* 过滤掉测试脚手架故意造成的那两条 */
  const noise = /__blank|favicon\.ico/;
  const realErrs = cdp.consoleErrors.filter(e => !noise.test(e));
  const realBad = [...new Set(cdp.badResponses)].filter(u => !noise.test(u));

  check('没有未捕获异常', cdp.exceptions.length === 0, cdp.exceptions.join(' | ').slice(0, 300));
  check('没有 console.error', realErrs.length === 0, realErrs.join(' | ').slice(0, 300));
  check('没有 404／加载失败', realBad.length === 0, realBad.join(' | ').slice(0, 400));

  /* ── 收尾 ────────────────────────────────────────────── */
  console.log('');
  console.log(`  结果：${pass} 通过，${fail} 失败`);
  if (fail) {
    console.log('');
    console.log('  失败项：');
    for (const f of failures) console.log('    · ' + f);
  }
  console.log('');
}

main()
  .catch((e) => {
    console.error('');
    console.error('  测试自身出错：' + e.message);
    console.error(e.stack);
    fail++;
  })
  .finally(() => {
    if (cdp) cdp.close();
    try { chrome.kill(); } catch {}
    setTimeout(() => {
      fs.rmSync(PROFILE, { recursive: true, force: true });
      process.exit(fail ? 1 : 0);
    }, 400);
  });
