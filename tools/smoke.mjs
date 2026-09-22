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

  /* 先跑到同源的一个 404 页面上，在那里造一个 v1 的库 */
  await cdp.send('Page.navigate', { url: TARGET_URL + '__blank' });
  await sleep(1000);

  const seeded = await cdp.eval(`(async () => {
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
  check('造好了一个只含 v1 表的数据库', seeded === true);

  /* 刚才那个空白页是故意 404 的，它引发的报错不算 App 的问题，
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
    plan: document.getElementById('dhPlan').textContent,
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
  check('顶部显示「计划 12h」', b.plan === '计划 12h', b.plan);
  check('默认主题是薄荷绿', b.theme === 'mint', b.theme);
  check('没有弹出错误框', b.err === '', b.err.slice(0, 200));
  check('7 个时间块标题正确',
    b.titles.join('|') === '英语|专业课 / 考研|午间|专业课 / 考研|杂事|运动|晚间',
    b.titles.join('|'));
  check('时间刻度正确',
    b.times[0] === '06:30–08:00' && b.times[6] === '20:00–23:00',
    b.times.join('|'));

  /* ── 2. 版式 + 加一条待办 ────────────────────────────── */
  console.log('  ── 版式 ──');

  const design = JSON.parse(await cdp.eval(`JSON.stringify({
    footRight: (() => {
      const b = document.querySelector('.block[data-id="b1"] .add-btn');
      const f = document.querySelector('.block[data-id="b1"] .blk-foot');
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
  check('加号在右下角', design.footRight === true, JSON.stringify(design));
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
  check('顶部计数跟着更新', afterAdd.total === '0/1', afterAdd.total);

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
    name:  document.getElementById('fBlockName').textContent,
    sub:   document.getElementById('fBlockSub').textContent,
    closeBtn: getComputedStyle(document.getElementById('fClose')).display !== 'none',
  })`));
  check('单条待办左划能直接进专注', todoFocus.shown === true, JSON.stringify(todoFocus));
  check('专注面板标题就是这条待办', todoFocus.name === '冒烟测试待办A', todoFocus.name);
  check('副标题显示它属于哪一块', todoFocus.sub === '英语', todoFocus.sub);
  check('没开始计时时左上角有返回按钮', todoFocus.closeBtn === true, JSON.stringify(todoFocus));

  /* 没开始时必须能退出来 —— 这是修掉的一个真 bug */
  await cdp.eval(`document.getElementById('fClose').click()`);
  await sleep(700);
  check('点返回能退出专注面板',
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
  check('计数变成 1/1', afterTick.total === '1/1', afterTick.total);
  /* 底部那条现在只读真实专注计时，勾待办不该再影响它 */
  check('勾待办不再改动底部专注条', afterTick.goalNow === '0h00m', afterTick.goalNow);
  check('专注条保持 0%', /^0(\.0)?%$/.test(afterTick.fill), afterTick.fill);

  /* ── 4.5 日记本 ──────────────────────────────────────── */
  console.log('  ── 日记本 ──');

  const diaryStruct = JSON.parse(await cdp.eval(`JSON.stringify({
    textarea: !!document.querySelector('#diary .diary-text'),
    addBtn:   !!document.querySelector('#diary .diary-head .add-btn'),
    dateLabel: (document.querySelector('#diary .diary-date') || {}).textContent,
    noSubText: !document.querySelector('#diary .diary-sub'),
    noBigAddBtn: !document.querySelector('#diary .photo-add'),
    noCountLine: !document.querySelector('#diary .diary-count'),
    picker:   !!document.querySelector('#diary input[type=file]'),
    grid:     !!document.querySelector('#diary .photo-grid'),
    belowBlocks: (() => {
      const d = document.getElementById('diary');
      const b = document.getElementById('blocks');
      if (!d || !b) return false;
      return (b.compareDocumentPosition(d) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
    })(),
  })`));
  check('日记区排在时间块下面', diaryStruct.belowBlocks === true, JSON.stringify(diaryStruct));
  check('日记有文字输入框', diaryStruct.textarea === true);
  check('日记左上角是日期', /\d+月\d+日/.test(diaryStruct.dateLabel || ''), String(diaryStruct.dateLabel));
  check('日记右上角是小加号', diaryStruct.addBtn === true);
  check('日记没有多余说明文字', diaryStruct.noSubText === true);
  check('日记没有那条大「加照片」按钮', diaryStruct.noBigAddBtn === true);
  check('日记没有「多少字多少张」那行', diaryStruct.noCountLine === true);
  check('日记有隐藏的文件选择框', diaryStruct.picker === true);
  check('日记有照片墙', diaryStruct.grid === true);

  /* 写一段文字 */
  await cdp.eval(`(() => {
    const ta = document.querySelector('#diary .diary-text');
    ta.focus();
    ta.value = '今天测试写了一段日记。';
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    ta.blur();
    return true;
  })()`);
  await sleep(1300);

  /* 造一张 3000×2000 的图塞进文件选择框，验证压缩链路 */
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

  const photoDom = JSON.parse(await cdp.eval(`JSON.stringify({
    cells: document.querySelectorAll('#diary .photo-cell').length,
    imgs:  document.querySelectorAll('#diary .photo-cell img').length,
  })`));
  check('照片出现在墙上', photoDom.cells === 1, JSON.stringify(photoDom));
  check('缩略图真的解码出来了', photoDom.imgs === 1, JSON.stringify(photoDom));

  const stored = JSON.parse(await cdp.eval(`(async () => {
    const m = await import('./js/db.js');
    const all = await m.idbAll('photos');
    const p = all[0] || null;
    return JSON.stringify(p ? {
      n: all.length,
      w: p.w, h: p.h, srcW: p.srcW, srcH: p.srcH,
      fullBytes: p.blob ? p.blob.size : 0,
      thumbBytes: p.thumb ? p.thumb.size : 0,
      fullType: p.blob ? p.blob.type : '',
      thumbType: p.thumb ? p.thumb.type : '',
      day: p.day,
      hasDims: !!(p.w && p.h),
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

  /* 刷新，验证文字和照片都落盘了 */
  await cdp.send('Page.navigate', { url: TARGET_URL });
  await sleep(3400);
  const afterReloadDiary = JSON.parse(await cdp.eval(`JSON.stringify({
    text:  (document.querySelector('#diary .diary-text') || {}).value,
    cells: document.querySelectorAll('#diary .photo-cell').length,
    imgs:  document.querySelectorAll('#diary .photo-cell img').length,
  })`));
  check('刷新后日记文字还在',
    afterReloadDiary.text === '今天测试写了一段日记。', JSON.stringify(afterReloadDiary.text));
  check('刷新后照片还在（含缩略图重解码）',
    afterReloadDiary.cells === 1 && afterReloadDiary.imgs === 1,
    JSON.stringify(afterReloadDiary));

  /* 点开大图 */
  await cdp.eval(`document.querySelector('#diary .photo-cell').click()`);
  await sleep(1000);
  const lb = JSON.parse(await cdp.eval(`JSON.stringify({
    hidden: document.getElementById('lightbox').hidden,
    shown:  document.getElementById('lightbox').classList.contains('show'),
    blobSrc: String((document.querySelector('#lightbox .lb-img') || {}).src || '').startsWith('blob:'),
    btns: document.querySelectorAll('#lightbox .lb-btn').length,
  })`));
  check('点照片能看大图', lb.shown === true && lb.hidden === false, JSON.stringify(lb));
  check('大图是从本地库读的 blob', lb.blobSrc === true, JSON.stringify(lb));
  check('大图界面有关闭和删除', lb.btns === 2, JSON.stringify(lb));

  /* 删掉 */
  await cdp.eval(`document.querySelector('#lightbox .lb-btn.danger').click()`);
  await sleep(1400);
  const afterDel = JSON.parse(await cdp.eval(`JSON.stringify({
    cells: document.querySelectorAll('#diary .photo-cell').length,
    lbHidden: document.getElementById('lightbox').hidden,
  })`));
  check('删除后照片从墙上消失', afterDel.cells === 0, JSON.stringify(afterDel));
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
  check('色块共 17 个（16 色 + 默认）', swatchCount === 17, '实际 ' + swatchCount);

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
    todo:   getComputedStyle(document.querySelector('.todo-input')).fontSize,
    title:  getComputedStyle(document.querySelector('.blk-title')).fontSize,
    time:   getComputedStyle(document.querySelector('.blk-time')).fontSize,
    sub:    getComputedStyle(document.querySelector('.blk-sub')).fontSize,
    date:   getComputedStyle(document.getElementById('dateMain')).fontSize,
    smallest: ${SMALLEST},
  })`));

  check('待办正文 19px（比备忘录 17pt 大）', fonts.todo === '19px', fonts.todo);
  check('时间块标题 21px', fonts.title === '21px', fonts.title);
  check('时间刻度 16px', fonts.time === '16px', fonts.time);
  check('辅助小字 15px', fonts.sub === '15px', fonts.sub);
  check('日期标题 19px', fonts.date === '19px', fonts.date);
  check('全页没有任何小于 15px 的字', parseFloat(fonts.smallest) >= 15, fonts.smallest);

  /* ── 8.5 字号三档 ────────────────────────────────────── */
  console.log('  ── 字号三档 ──');
  await cdp.eval(`document.getElementById('themeBtn').click()`);
  await sleep(700);

  const fsBtns = await cdp.eval(`document.querySelectorAll('#fsBtns button').length`);
  check('字号有 3 档按钮', fsBtns === 3, '实际 ' + fsBtns);

  const fsDefault = await cdp.eval(`(document.querySelector('#fsBtns button.on') || {}).dataset?.fs`);
  check('默认选中「标准」', fsDefault === '1', String(fsDefault));

  const expect = async (fsVal, label) => {
    await cdp.eval(`document.querySelector('#fsBtns button[data-fs="${fsVal}"]').click()`);
    await sleep(650);
    const m = JSON.parse(await cdp.eval(`JSON.stringify({
      root: getComputedStyle(document.documentElement).fontSize,
      todo: parseFloat(getComputedStyle(document.querySelector('.todo-input')).fontSize),
      smallest: ${SMALLEST},
      on: (document.querySelector('#fsBtns button.on') || {}).dataset?.fs,
    })`));
    const wantTodo = 19 * fsVal;            /* 1.1875rem = 19px @fs=1 */
    const wantFloor = 15 * fsVal;           /* 最小字 0.9375rem = 15px @fs=1 */
    check(`选「${label}」→ 待办正文 ${wantTodo.toFixed(2)}px`,
      Math.abs(m.todo - wantTodo) < 0.6, m.todo + 'px');
    check(`选「${label}」→ 全页最小字不小于 ${wantFloor.toFixed(2)}px`,
      parseFloat(m.smallest) >= wantFloor - 0.5, m.smallest);
    check(`选「${label}」→ 按钮高亮正确`, m.on === String(fsVal), String(m.on));
    return m;
  };

  await expect(1.15, '大');
  await expect(1.32, '特大');
  await expect(1, '标准');

  /* 选「大」然后刷新，验证全局字号记住了 */
  await cdp.eval(`document.querySelector('#fsBtns button[data-fs="1.15"]').click()`);
  await sleep(700);
  await cdp.send('Page.navigate', { url: TARGET_URL });
  await sleep(2800);
  const fsKept = await cdp.eval(`parseFloat(getComputedStyle(document.querySelector('.todo-input')).fontSize)`);
  check('刷新后字号还是「大」（21.85px）', Math.abs(fsKept - 21.85) < 0.6, fsKept + 'px');

  /* ── 9. 「进行中」高亮是否指对了 ─────────────────────── */
  console.log('  ── 当前时间块高亮 ──');
  const nowInfo = JSON.parse(await cdp.eval(`JSON.stringify((() => {
    const nowMin = new Date().getHours() * 60 + new Date().getMinutes();
    const toM = (h) => { const [a, b] = h.split(':').map(Number); return a * 60 + b; };
    const blocks = [...document.querySelectorAll('.block')];
    let expected = null;
    for (const b of blocks) {
      const t = b.querySelector('.blk-time').textContent;
      const [s, e] = t.split('–').map(x => x.trim());
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

  /* ── 10. 专注（左划进入 + 长按 15 秒退出） ───────────── */
  console.log('  ── 专注 ──');

  const HOLD_DOWN = `document.getElementById('fHold').dispatchEvent(new PointerEvent('pointerdown', {
    pointerId: 78, pointerType: 'touch', isPrimary: true, bubbles: true, cancelable: true }))`;
  const HOLD_UP = `document.getElementById('fHold').dispatchEvent(new PointerEvent('pointerup', {
    pointerId: 78, pointerType: 'touch', isPrimary: true, bubbles: true, cancelable: true }))`;

  /* 左划 */
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

  const opened = JSON.parse(await cdp.eval(`JSON.stringify({
    hidden: document.getElementById('focusLayer').hidden,
    shown:  document.getElementById('focusLayer').classList.contains('show'),
    block:  document.getElementById('fBlockName').textContent,
    hold:   document.getElementById('fHoldText').textContent,
  })`));
  check('左划打开专注面板', opened.hidden === false && opened.shown === true,
    JSON.stringify(opened));
  check('面板上显示时间块名', !!opened.block && opened.block !== '—', opened.block);
  check('圆环写着「长按开始」', opened.hold === '长按开始', opened.hold);

  /* 换时间块 */
  await cdp.eval(`document.getElementById('fPick').click()`);
  await sleep(400);
  const pickCount = await cdp.eval(`document.querySelectorAll('#fPicker .f-pick-item').length`);
  check('时间块选择器列了 7 项', pickCount === 7, '实际 ' + pickCount);
  await cdp.eval(`document.querySelector('#fPicker .f-pick-item[data-id="b2"]').click()`);
  await sleep(400);
  const picked = await cdp.eval(`document.getElementById('fBlockName').textContent`);
  check('能切成「专业课 / 考研」', picked === '专业课 / 考研', picked);

  /* 长按开始 */
  await cdp.eval(HOLD_DOWN);
  await sleep(600);
  const midHold = await cdp.eval(`document.getElementById('fHoldText').textContent`);
  check('按住时圆环在走', /继续按住/.test(midHold), midHold);

  await sleep(1400);
  const running = JSON.parse(await cdp.eval(`JSON.stringify({
    running: document.getElementById('focusLayer').classList.contains('is-running'),
    hold: document.getElementById('fHoldText').textContent,
    hint: document.getElementById('fHint').textContent,
  })`));
  check('长按 2 秒后开始计时', running.running === true, JSON.stringify(running));
  check('运行中圆环改成「长按 15 秒退出」', /15 秒退出/.test(running.hold), running.hold);
  check('提示写明息屏也会继续记', /息屏/.test(running.hint), running.hint);

  /* 计时器真的在走 */
  const c1 = await cdp.eval(`document.getElementById('fClock').textContent`);
  await sleep(2200);
  const c2 = await cdp.eval(`document.getElementById('fClock').textContent`);
  check('计时器在走', c1 !== c2, c1 + ' → ' + c2);

  /* 模拟息屏 / 切走 —— 「息屏照走 + 离开账本」的核心验证 */
  await cdp.eval(`Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    document.dispatchEvent(new Event('visibilitychange')); true`);
  await sleep(2600);
  await cdp.eval(`Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
    document.dispatchEvent(new Event('visibilitychange')); true`);
  await sleep(900);

  const away = JSON.parse(await cdp.eval(`(async () => {
    const m = await import('./js/store.js');
    const list = await m.sessionsForDate(m.todayKey());
    const s = list.find(x => !x.endedAt) || list[0] || null;
    return JSON.stringify(s ? {
      awayCount: (s.away || []).length,
      allClosed: (s.away || []).every(a => a.to !== null && a.to !== undefined),
      stillRunning: !s.endedAt,
      clock: document.getElementById('fClock').textContent,
    } : { none: true });
  })()`));

  const secs = (() => {
    const p = String(away.clock || '0:0:0').split(':').map(Number);
    return p[0] * 3600 + p[1] * 60 + p[2];
  })();
  check('切走被记了一笔离开', away.awayCount === 1, JSON.stringify(away));
  check('回来之后离开区间已闭合', away.allClosed === true, JSON.stringify(away));
  check('切走期间计时没有停（息屏照走）', away.stillRunning === true, JSON.stringify(away));
  check('切走期间时长照常累加', secs >= 4, away.clock);

  /* 提前松手不该退出 */
  await cdp.eval(HOLD_DOWN);
  await sleep(3000);
  await cdp.eval(HOLD_UP);
  await sleep(400);
  const afterEarly = await cdp.eval(`document.getElementById('focusLayer').classList.contains('is-running')`);
  check('长按 3 秒松手 → 不算退出（必须满 15 秒）', afterEarly === true, String(afterEarly));

  /* 长按满 15 秒 */
  await cdp.eval(HOLD_DOWN);
  await sleep(15600);

  const doneInfo = JSON.parse(await cdp.eval(`JSON.stringify({
    done:    document.getElementById('focusLayer').classList.contains('is-done'),
    running: document.getElementById('focusLayer').classList.contains('is-running'),
    clock:   document.getElementById('fClock').textContent,
    doneBtn: !document.getElementById('fDoneBtn').hidden,
    stats:   [...document.querySelectorAll('.f-stat')].map(e => e.textContent).join(' | '),
    segs:    document.querySelectorAll('#fTimeline rect').length,
  })`));
  check('长按满 15 秒 → 会话结束', doneInfo.done === true && doneInfo.running === false,
    JSON.stringify(doneInfo));
  check('结算卡出现「完成」按钮', doneInfo.doneBtn === true, JSON.stringify(doneInfo));
  check('结算卡显示有效时长', /\d+h\d+m/.test(doneInfo.clock), doneInfo.clock);
  check('时间线画出了分段', doneInfo.segs >= 2, '段数 ' + doneInfo.segs);
  check('统计里有「离开」这一项', /离开/.test(doneInfo.stats), doneInfo.stats);

  /* 落盘验证 */
  const saved = JSON.parse(await cdp.eval(`(async () => {
    const m = await import('./js/store.js');
    const list = await m.sessionsForDate(m.todayKey());
    const s = list[0] || null;
    return JSON.stringify(list.length ? {
      n: list.length,
      ended: !!s.endedAt,
      blockId: s.blockId,
      awayCount: (s.away || []).length,
      span: s.endedAt - s.startedAt,
    } : { n: 0 });
  })()`));
  check('会话写进了数据库', saved.n === 1, JSON.stringify(saved));
  check('会话已结束并封存', saved.ended === true, JSON.stringify(saved));
  check('会话挂在正确的时间块上（b2）', saved.blockId === 'b2', String(saved.blockId));
  check('离开记录一并存下来了', saved.awayCount === 1, JSON.stringify(saved));
  check('会话跨度超过 15 秒', saved.span > 15000, String(saved.span));

  /* 收尾：关面板 + 刷新 */
  await cdp.eval(`document.getElementById('fDoneBtn').click()`);
  await sleep(600);
  check('点「完成」后面板关掉',
    (await cdp.eval(`document.getElementById('focusLayer').hidden`)) === true);

  await cdp.send('Page.navigate', { url: TARGET_URL });
  await sleep(3200);
  const afterReloadFocus = JSON.parse(await cdp.eval(`JSON.stringify({
    focusHidden: document.getElementById('focusLayer').hidden,
    goal: document.getElementById('goalNow').textContent,
    title: document.getElementById('goal').title,
  })`));
  check('刷新后没有残留的进行中会话', afterReloadFocus.focusHidden === true,
    JSON.stringify(afterReloadFocus));
  check('底部条读到了今天的离开记录', /离开/.test(afterReloadFocus.title),
    afterReloadFocus.title);

  /* ── 10.8 日总结（右划） ─────────────────────────────── */
  console.log('  ── 日总结 ──');

  const swipeRightOnDay = `(() => {
    const day = document.getElementById('day');
    const r = day.getBoundingClientRect();
    const y = r.top + 160;
    const mk = (type, x) => new PointerEvent(type, {
      pointerId: 81, pointerType: 'touch', isPrimary: true,
      clientX: x, clientY: y, bubbles: true, cancelable: true,
    });
    day.dispatchEvent(mk('pointerdown', r.left + 120));
    day.dispatchEvent(mk('pointermove', r.left + 200));
    day.dispatchEvent(mk('pointermove', r.left + 300));
    day.dispatchEvent(mk('pointerup',   r.left + 360));
    return true;
  })()`;

  await cdp.eval(swipeRightOnDay);
  await sleep(900);

  const sum = JSON.parse(await cdp.eval(`JSON.stringify({
    hidden:  document.getElementById('summaryLayer').hidden,
    shown:   document.getElementById('summaryLayer').classList.contains('show'),
    title:   document.getElementById('sumTitle').textContent,
    date:    document.getElementById('sumDate').textContent,
    segs:    document.querySelectorAll('#sumDonut .donut-seg').length,
    legend:  document.querySelectorAll('#sumLegend .legend-row').length,
    blocks:  document.querySelectorAll('#sumBlocks .sum-block').length,
    bars:    document.querySelectorAll('#sumBlocks .sum-bar').length,
    habits:  document.querySelectorAll('#sumHabits .habit').length,
    sleep:   document.querySelectorAll('#sumSleep .sleep-btn').length,
    tlRects: document.querySelectorAll('#sumTimeline .day-tl-focus').length,
    tlTicks: document.querySelectorAll('#sumTimeline .day-tl-tick').length,
    axis:    document.querySelectorAll('#sumTimeline .day-tl-axis span').length,
    big:     (document.querySelector('.donut-big') || {}).textContent,
    mid:     (document.querySelector('.donut-mid') || {}).textContent,
  })`));

  check('右划打开日总结', sum.hidden === false && sum.shown === true, JSON.stringify(sum));
  check('标题是「今日总结」', sum.title === '今日总结', sum.title);
  check('日期行有内容', /\d+月\d+日/.test(sum.date), sum.date);
  check('日程列了 7 个时间块', sum.blocks === 7, '实际 ' + sum.blocks);
  check('4 个学习块有进度条', sum.bars === 4, '实际 ' + sum.bars);
  check('习惯有 4 项（英语/背单词/运动/练字）', sum.habits === 4, '实际 ' + sum.habits);
  check('睡眠有 2 个按钮', sum.sleep === 2, '实际 ' + sum.sleep);
  check('环形图按块分了段', sum.segs >= 1, '段数 ' + sum.segs);
  check('图例行数和分段数一致', sum.legend === sum.segs, `${sum.legend} vs ${sum.segs}`);
  check('圆心显示有效专注时长', /\d+h\d+m/.test(sum.big || ''), String(sum.big));
  check('圆心显示占 12h 的百分比', /%/.test(sum.mid || ''), String(sum.mid));
  check('全天时间线画了刻度', sum.tlTicks >= 5, '实际 ' + sum.tlTicks);
  check('全天时间线有专注段', sum.tlRects >= 1, '实际 ' + sum.tlRects);
  check('时间线轴有多个时刻标注', sum.axis >= 5, '实际 ' + sum.axis);

  /* 习惯打卡 */
  await cdp.eval(`document.querySelector('#sumHabits .habit[data-habit="英语"]').click()`);
  await sleep(600);
  check('点习惯能打卡',
    (await cdp.eval(`document.querySelector('#sumHabits .habit[data-habit="英语"]').classList.contains('on')`)) === true);

  /* 睡眠打卡 */
  await cdp.eval(`document.querySelector('#sumSleep .sleep-btn').click()`);
  await sleep(600);
  const sleepState = JSON.parse(await cdp.eval(`JSON.stringify({
    on: document.querySelector('#sumSleep .sleep-btn').classList.contains('on'),
    time: document.querySelector('#sumSleep .sleep-btn .sleep-time').textContent,
  })`));
  check('点月亮记下睡觉时间',
    sleepState.on === true && /^\d{2}:\d{2}$/.test(sleepState.time), JSON.stringify(sleepState));
  check('睡眠说明更新成「还没记起床时间」',
    /还没记起床/.test(await cdp.eval(`document.querySelector('#sumSleep .sum-note').textContent`)));

  /* 关掉面板 */
  await cdp.eval(`document.getElementById('sumClose').click()`);
  await sleep(600);
  check('点 ✕ 能收起日总结',
    (await cdp.eval(`document.getElementById('summaryLayer').hidden`)) === true);

  /* 刷新，验证习惯和睡眠真的落盘了 */
  await cdp.send('Page.navigate', { url: TARGET_URL });
  await sleep(3200);
  await cdp.eval(swipeRightOnDay);
  await sleep(900);

  const persisted = JSON.parse(await cdp.eval(`JSON.stringify({
    habit: document.querySelector('#sumHabits .habit[data-habit="英语"]').classList.contains('on'),
    sleep: document.querySelector('#sumSleep .sleep-btn').classList.contains('on'),
    title: document.getElementById('sumTitle').textContent,
  })`));
  check('刷新后习惯打卡还在', persisted.habit === true, JSON.stringify(persisted));
  check('刷新后睡眠记录还在', persisted.sleep === true, JSON.stringify(persisted));

  await cdp.eval(`document.getElementById('sumClose').click()`);
  await sleep(600);

  /* ── 10.85 便签本 ────────────────────────────────────── */
  console.log('  ── 便签本 ──');

  const notesBtn = JSON.parse(await cdp.eval(`JSON.stringify({
    exists: !!document.getElementById('notesBtn'),
    text: (document.getElementById('notesBtn') || {}).textContent,
  })`));
  check('底部有便签按钮', notesBtn.exists === true, JSON.stringify(notesBtn));
  check('按钮写着「便签」', /便签/.test(notesBtn.text || ''), String(notesBtn.text));

  await cdp.eval(`document.getElementById('notesBtn').click()`);
  await sleep(900);

  const list0 = JSON.parse(await cdp.eval(`JSON.stringify({
    shown: document.getElementById('notesLayer').classList.contains('show'),
    listVisible: !document.getElementById('notesList').hidden,
    cards: document.querySelectorAll('#notesGrid .note-card').length,
    emptyShown: !document.getElementById('notesEmpty').hidden,
  })`));
  check('点便签按钮打开便签本',
    list0.shown === true && list0.listVisible === true, JSON.stringify(list0));
  check('一开始是空列表并给出提示',
    list0.cards === 0 && list0.emptyShown === true, JSON.stringify(list0));

  /* 新建一条 */
  await cdp.eval(`document.getElementById('noteAdd').click()`);
  await sleep(700);
  const editor0 = JSON.parse(await cdp.eval(`JSON.stringify({
    editorVisible: !document.getElementById('notesEditor').hidden,
    listHidden: document.getElementById('notesList').hidden,
    focused: !!(document.activeElement && document.activeElement.id === 'noteText'),
    bg: getComputedStyle(document.getElementById('notesEditor')).backgroundColor,
    dots: document.querySelectorAll('#noteColors .note-dot').length,
  })`));
  check('点 ＋ 进入编辑界面',
    editor0.editorVisible === true && editor0.listHidden === true, JSON.stringify(editor0));
  check('编辑器自动聚焦，打开就能打字', editor0.focused === true, JSON.stringify(editor0));
  check('默认是黄色便签', editor0.bg === 'rgb(255, 241, 168)', editor0.bg);
  check('有 6 个颜色可选', editor0.dots === 6, String(editor0.dots));

  await cdp.eval(`(() => {
    const ta = document.getElementById('noteText');
    ta.value = '第一条便签：\\n周三前把开题报告的大纲列出来。';
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);
  await sleep(1200);

  await cdp.eval(`document.querySelector('#noteColors .note-dot[data-color="blue"]').click()`);
  await sleep(700);
  const colored = await cdp.eval(`getComputedStyle(document.getElementById('notesEditor')).backgroundColor`);
  check('能换成蓝色便签', colored === 'rgb(204, 229, 250)', colored);

  await cdp.eval(`document.getElementById('noteBack').click()`);
  await sleep(900);
  const list1 = JSON.parse(await cdp.eval(`JSON.stringify({
    cards: document.querySelectorAll('#notesGrid .note-card').length,
    text: (document.querySelector('#notesGrid .note-card-text') || {}).textContent,
    bg: getComputedStyle(document.querySelector('#notesGrid .note-card')).backgroundColor,
    date: (document.querySelector('#notesGrid .note-card-date') || {}).textContent,
  })`));
  check('返回后列表里出现一张便签', list1.cards === 1, JSON.stringify(list1));
  check('卡片上能看到内容', /第一条便签/.test(list1.text || ''), String(list1.text));
  check('卡片保留了选的颜色', list1.bg === 'rgb(204, 229, 250)', list1.bg);
  check('卡片上有日期', /\d+月\d+日/.test(list1.date || ''), String(list1.date));

  /* 点了 ＋ 又反悔的情况 */
  await cdp.eval(`document.getElementById('noteAdd').click()`);
  await sleep(600);
  await cdp.eval(`document.getElementById('noteBack').click()`);
  await sleep(900);
  check('新建后一个字没写就返回 —— 不留空白便签',
    (await cdp.eval(`document.querySelectorAll('#notesGrid .note-card').length`)) === 1);

  /* 第二条 + 置顶 */
  await cdp.eval(`document.getElementById('noteAdd').click()`);
  await sleep(600);
  await cdp.eval(`(() => {
    const ta = document.getElementById('noteText');
    ta.value = '第二条便签';
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);
  await sleep(1000);
  await cdp.eval(`document.getElementById('notePin').click()`);
  await sleep(700);
  check('置顶按钮生效',
    (await cdp.eval(`document.getElementById('notePin').classList.contains('on')`)) === true);
  await cdp.eval(`document.getElementById('noteBack').click()`);
  await sleep(900);

  const ordered = JSON.parse(await cdp.eval(`JSON.stringify({
    n: document.querySelectorAll('#notesGrid .note-card').length,
    first: (document.querySelector('#notesGrid .note-card .note-card-text') || {}).textContent,
    pinned: document.querySelectorAll('#notesGrid .note-card.pinned').length,
  })`));
  check('现在有 2 张便签', ordered.n === 2, JSON.stringify(ordered));
  check('置顶的排在最前面', ordered.first === '第二条便签', String(ordered.first));
  check('置顶样式生效', ordered.pinned === 1, String(ordered.pinned));

  /* 刷新验证落盘 */
  await cdp.send('Page.navigate', { url: TARGET_URL });
  await sleep(3200);
  await cdp.eval(`document.getElementById('notesBtn').click()`);
  await sleep(900);
  const notesReloaded = JSON.parse(await cdp.eval(`JSON.stringify({
    n: document.querySelectorAll('#notesGrid .note-card').length,
    texts: [...document.querySelectorAll('#notesGrid .note-card-text')].map(e => e.textContent),
  })`));
  check('刷新后便签还在', notesReloaded.n === 2, JSON.stringify(notesReloaded));
  check('刷新后内容没变',
    notesReloaded.texts.some(t => /第一条便签/.test(t)) && notesReloaded.texts.some(t => t === '第二条便签'),
    JSON.stringify(notesReloaded.texts));

  /* 点开看内容 */
  await cdp.eval(`[...document.querySelectorAll('#notesGrid .note-card')].find(c => /第一条/.test(c.textContent)).click()`);
  await sleep(800);
  const reopened = JSON.parse(await cdp.eval(`JSON.stringify({
    editorVisible: !document.getElementById('notesEditor').hidden,
    text: document.getElementById('noteText').value,
  })`));
  check('点便签能打开看内容', reopened.editorVisible === true, JSON.stringify(reopened));
  check('打开的就是那张便签', /周三前把开题报告/.test(reopened.text || ''), String(reopened.text));

  /* 删除 */
  await cdp.eval(`window.confirm = () => true; document.getElementById('noteDel').click()`);
  await sleep(1100);
  check('删除后少了一张',
    (await cdp.eval(`document.querySelectorAll('#notesGrid .note-card').length`)) === 1);

  await cdp.eval(`document.getElementById('notesClose').click()`);
  await sleep(700);
  check('点 ✕ 能收起便签本',
    (await cdp.eval(`document.getElementById('notesLayer').hidden`)) === true);

  /* ── 10.9 备份导出 + PDF ─────────────────────────────── */
  console.log('  ── 备份导出 ──');

  /* 先给今天塞一张照片，好验证照片有没有被打进包里 */
  await cdp.eval(`(async () => {
    const c = document.createElement('canvas');
    c.width = 1600; c.height = 1200;
    const g = c.getContext('2d');
    g.fillStyle = '#2A4674'; g.fillRect(0, 0, 1600, 1200);
    g.fillStyle = '#E9F6EF'; g.font = 'bold 260px sans-serif'; g.fillText('BK', 560, 700);
    const blob = await new Promise(r => c.toBlob(r, 'image/jpeg', 0.9));
    const dt = new DataTransfer();
    dt.items.add(new File([blob], 'bk.jpg', { type: 'image/jpeg' }));
    const input = document.querySelector('#diary input[type=file]');
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`);
  await sleep(2800);
  check('为备份测试加好了一张照片',
    (await cdp.eval(`document.querySelectorAll('#diary .photo-cell').length`)) === 1);

  const backup = JSON.parse(await cdp.eval(`(async () => {
    const bk = await import('./js/backup.js');
    const zip = await import('./js/zip.js');
    const { blob, meta } = await bk.buildBackupBlob();
    const entries = await zip.readZip(blob);
    const names = entries.map(e => e.name);
    const de = entries.find(e => e.name === 'data.json');
    let data = null;
    try { data = de ? JSON.parse(new TextDecoder().decode(de.data)) : null; } catch (e) { data = { err: e.message }; }
    const photoJson = entries.find(e => e.name.endsWith('.json') && e.name.startsWith('photos/'));
    let pmeta = null;
    try { pmeta = photoJson ? JSON.parse(new TextDecoder().decode(photoJson.data)) : null; } catch (e) { pmeta = null; }
    return JSON.stringify({
      bytes: blob.size,
      type: blob.type,
      meta,
      names,
      jpgCount: names.filter(n => n.endsWith('.jpg')).length,
      dayCount: data && data.days ? data.days.length : -1,
      sessionCount: data && data.sessions ? data.sessions.length : -1,
      noteCount: data && data.notes ? data.notes.length : -1,
      settingKeys: data && data.settings ? data.settings.map(s => s.key) : [],
      photoW: pmeta && pmeta.w, photoH: pmeta && pmeta.h,
      photoDay: pmeta && pmeta.day,
    });
  })()`));

  check('导出包是个真正的 zip', backup.type === 'application/zip' && backup.bytes > 500,
    JSON.stringify({ bytes: backup.bytes, type: backup.type }));
  check('包里带 data.json', backup.names.includes('data.json'), JSON.stringify(backup.names.slice(0, 6)));
  check('包里有大图 + 缩略图两个 jpg', backup.jpgCount === 2, '实际 ' + backup.jpgCount);
  check('data.json 里有日期记录', backup.dayCount >= 1, String(backup.dayCount));
  check('data.json 里带上了专注会话', backup.sessionCount >= 1, String(backup.sessionCount));
  check('data.json 里带上了便签', backup.noteCount >= 1, String(backup.noteCount));
  check('data.json 里带上了设置', backup.settingKeys.includes('app'), JSON.stringify(backup.settingKeys));
  check('照片元信息跟着进来了', backup.photoW === 1280 && backup.photoDay === TODAY,
    JSON.stringify({ w: backup.photoW, day: backup.photoDay }));
  check('包大小合理（没把原图塞进去）', backup.bytes < 600 * 1024, backup.bytes + ' B');

  console.log('  ── PDF 排版 ──');

  /* 把 window.print 换成计数器，免得无头浏览器真弹打印面板 */
  await cdp.eval(`window.__printCount = 0; window.print = () => { window.__printCount++; }; true`);
  await cdp.eval(`(async () => {
    const m = await import('./js/print.js');
    const st = await import('./js/store.js');
    await m.printDay(st.todayKey());
    return true;
  })()`);
  await sleep(1100);

  const pdf = JSON.parse(await cdp.eval(`JSON.stringify({
    called: window.__printCount,
    pages: document.querySelectorAll('#printRoot .pr-page').length,
    date: (document.querySelector('#printRoot .pr-date') || {}).textContent,
    blocks: document.querySelectorAll('#printRoot .pr-block').length,
    todos: document.querySelectorAll('#printRoot .pr-todo').length,
    doneTodos: document.querySelectorAll('#printRoot .pr-todo.done').length,
    photos: document.querySelectorAll('#printRoot .pr-photo').length,
    timeline: document.querySelectorAll('#printRoot .pr-tl-focus').length,
    h2: [...document.querySelectorAll('#printRoot .pr-h2')].map(e => e.textContent),
  })`));

  check('导出 PDF 调用了打印', pdf.called === 1, String(pdf.called));
  check('排出了 1 页', pdf.pages === 1, String(pdf.pages));
  check('PDF 页上有日期', /\d+月\d+日/.test(pdf.date || ''), String(pdf.date));
  check('PDF 页上有 7 个时间块', pdf.blocks === 7, String(pdf.blocks));
  check('PDF 页上有待办', pdf.todos >= 1, String(pdf.todos));
  check('PDF 页上标出了已完成', pdf.doneTodos >= 1, String(pdf.doneTodos));
  check('PDF 页上有照片', pdf.photos === 1, String(pdf.photos));
  check('PDF 页上有时间线', pdf.timeline >= 1, String(pdf.timeline));
  check('PDF 有「日程」小节', pdf.h2.includes('日程'), JSON.stringify(pdf.h2));

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
  check('按钮变成「开灯」', /开灯/.test(lights.btn), lights.btn);

  await cdp.eval(`document.getElementById('fLights').click()`);
  await sleep(350);
  check('再点一下能开回灯',
    (await cdp.eval(`document.getElementById('focusLayer').classList.contains('lights-off')`)) === false);

  /* 开一次专注，然后直接刷新 —— 相当于 iOS 把页面回收了 */
  await cdp.eval(HOLD_DOWN);
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
