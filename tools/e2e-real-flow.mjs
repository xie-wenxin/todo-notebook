/* ═══════════════════════════════════════════════════════════
   e2e-real-flow.mjs — 走一遍和手机上完全一样的流程

   点 ▶ → 计时 → 页面被 iOS 杀掉（这里用刷新模拟）→ 自动接着算
   → 点 ■ → 写一句话 → ✓ → 看底部 / 扇形图 / 时间轴

   每一步都把数字打出来。用法：node tools/e2e-real-flow.mjs
   ═══════════════════════════════════════════════════════════ */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CHROME = process.env.CHROME || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const URL = process.argv[2] || 'http://localhost:5173/';
const PORT = Number(process.env.CDP_PORT || 9455);
const PROFILE = path.join(os.tmpdir(), 'dsh-reflow-profile');

try { fs.rmSync(PROFILE, { recursive: true, force: true }); } catch { /* 无所谓 */ }

const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run',
  '--disable-crashpad', '--disable-extensions',
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${PROFILE}`, 'about:blank',
], { stdio: 'ignore' });

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

let pass = 0, fail = 0;
function ok(name, cond, detail = '') {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (detail ? '  → ' + detail : '')); }
}

async function waitFor(fn, timeout = 20000) {
  const t0 = Date.now();
  for (;;) {
    try { const v = await fn(); if (v) return v; } catch { /* 还没好 */ }
    if (Date.now() - t0 > timeout) throw new Error('等超时了');
    await sleep(200);
  }
}

let ws;
try {
  const target = await waitFor(async () => {
    const r = await fetch(`http://127.0.0.1:${PORT}/json/list`);
    const list = await r.json();
    return list.find(t => t.type === 'page' && t.webSocketDebuggerUrl) || null;
  });

  ws = new WebSocket(target.webSocketDebuggerUrl);
  let seq = 0;
  const pending = new Map();
  const pageErrors = [];

  await new Promise((res, rej) => {
    ws.onopen = res;
    ws.onerror = () => rej(new Error('连不上 Chrome'));
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && pending.has(m.id)) {
        const { res: r, rej: j } = pending.get(m.id);
        pending.delete(m.id);
        if (m.error) j(new Error(m.error.message)); else r(m.result);
        return;
      }
      if (m.method === 'Runtime.exceptionThrown') {
        const d = m.params.exceptionDetails || {};
        pageErrors.push(d.exception?.description || d.text || '?');
      }
    };
  });

  const send = (method, params = {}) => new Promise((res, rej) => {
    const id = ++seq;
    pending.set(id, { res, rej });
    ws.send(JSON.stringify({ id, method, params }));
  });

  const ev = async (expr) => {
    const r = await send('Runtime.evaluate', {
      expression: expr, awaitPromise: true, returnByValue: true,
    });
    if (r.exceptionDetails) {
      throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    }
    return r.result.value;
  };

  const nav = async (u = URL, settle = 3400) => {
    await send('Page.navigate', { url: u });
    await sleep(settle);
  };

  await send('Runtime.enable');
  await send('Page.enable');

  /* ── 1. 开局 ─────────────────────────────────────────── */
  console.log('\n  ── 1. 打开，底部应该是 0h00m ──');
  await nav();
  const bar0 = await ev(`document.getElementById('goalNow').textContent`);
  console.log('     底部：' + bar0);
  ok('开局底部是 0h00m', bar0 === '0h00m', bar0);

  /* ── 2. 左划打开专注页 ───────────────────────────────── */
  console.log('\n  ── 2. 进专注页，点 ▶ 开始 ──');
  await ev(`import('./js/focus-ui.js').then(m => m.openFocus('b2', null, '专业课'))`);
  await sleep(700);
  const shown = await ev(`document.getElementById('focusLayer').classList.contains('show')`);
  ok('专注页打开了', shown === true);

  await ev(`document.getElementById('fStart').click()`);
  await sleep(1200);
  const btnText = await ev(`document.getElementById('fStart').textContent`);
  ok('大按钮变成 ■', btnText === '■', btnText);

  /* ── 3. 跑 8 秒 ──────────────────────────────────────── */
  console.log('\n  ── 3. 计时 8 秒 ──');
  await sleep(8000);
  const clock1 = await ev(`document.getElementById('fClock').textContent`);
  console.log('     计时器：' + clock1);
  const sec1 = (() => { const p = clock1.split(':').map(Number); return p[0] * 3600 + p[1] * 60 + p[2]; })();
  ok('计时器在走', sec1 >= 8, clock1);

  /* ── 4. 页面被 iOS 杀掉（刷新） ──────────────────────── */
  console.log('\n  ── 4. 页面被系统回收，重新打开 ──');
  await nav();
  await sleep(1200);
  const resumed = JSON.parse(await ev(`JSON.stringify({
    shown: document.getElementById('focusLayer').classList.contains('show'),
    running: document.getElementById('focusLayer').classList.contains('is-running'),
    clock: document.getElementById('fClock').textContent,
  })`));
  console.log('     恢复后计时器：' + resumed.clock);
  ok('自动接着算，专注页还开着', resumed.shown === true && resumed.running === true,
    JSON.stringify(resumed));

  /* ── 5. 点 ■ 停止，写一句话 ─────────────────────────── */
  console.log('\n  ── 5. 点 ■ 停止，写一句话 ──');
  const clockBeforeStop = resumed.clock;
  await ev(`document.getElementById('fStart').click()`);
  await sleep(700);
  const noteShown = await ev(`!document.getElementById('fNote').hidden`);
  ok('跳出写总结的框', noteShown === true);

  await ev(`document.getElementById('fNoteText').value = '今天状态不错'`);
  await ev(`document.getElementById('fNoteOk').click()`);
  await sleep(1800);

  const bar1 = await ev(`document.getElementById('goalNow').textContent`);
  console.log('     停止前计时器：' + clockBeforeStop);
  console.log('     底部专注：   ' + bar1);
  ok('底部不再是 0h00m', !/^0h0?0m$/.test(bar1), bar1);
  ok('底部显示的就是刚刚那段（秒数）', /^\d+s$/.test(bar1) || /^0h0[0-9]m$/.test(bar1), bar1);

  /* ── 6. 总结页：扇形图 + 时间轴 ─────────────────────── */
  console.log('\n  ── 6. 总结页 ──');
  const sum = JSON.parse(await ev(`(async () => {
    const store = await import('./js/store.js');
    const s = await import('./js/summary.js');
    await s.openSummary(store.todayKey(), await store.getDay(store.todayKey()));
    await new Promise(r => setTimeout(r, 800));
    const d = document.querySelector('.donut-big');
    const out = {
      donut: d ? d.textContent : '(无)',
      segs: document.querySelectorAll('.vtl-seg').length,
      sessions: (await store.sessionsForDate(store.todayKey())).length,
    };
    s.closeSummary();
    return JSON.stringify(out);
  })()`));
  console.log('     扇形图：' + sum.donut + '   时间轴段数：' + sum.segs + '   库里的会话：' + sum.sessions);
  ok('扇形图不是 0h00m', sum.donut !== '0h00m' && sum.donut !== '', sum.donut);
  ok('时间轴画出来了', sum.segs >= 1, String(sum.segs));

  /* ── 7. 长时间专注：锁屏 90 分钟再回来 ──────────────── */
  console.log('\n  ── 7. 长会话：锁屏 1.5 小时再回来 ──');

  /* 7a. 真的让它「隐藏」——走页面上真正的 visibilitychange 处理器 */
  await ev(`import('./js/focus-ui.js').then(m => m.openFocus('b4', null, '数学'))`);
  await sleep(600);
  await ev(`document.getElementById('fStart').click()`);
  await sleep(1500);

  const hiddenMark = JSON.parse(await ev(`(async () => {
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
    await new Promise(r => setTimeout(r, 400));
    const store = await import('./js/store.js');
    const F = await import('./js/focus.js');
    const rec = (await store.sessionsForDate(store.todayKey()))
      .filter(s => !s.endedAt).pop();
    return JSON.stringify({
      found: !!rec,
      awayOpen: rec ? F.isAway(F.fromRecord(rec)) : false,
    });
  })()`));
  console.log('     锁屏后：记到离开区间了吗 → ' + JSON.stringify(hiddenMark));
  ok('页面上真的记为「离开中」', hiddenMark.found === true && hiddenMark.awayOpen === true,
    JSON.stringify(hiddenMark));

  /* 7b. 把这次会话的开始时间往前挪 90 分钟 —— 等价于真的过了 1.5 小时 */
  await ev(`(async () => {
    const store = await import('./js/store.js');
    const F = await import('./js/focus.js');
    const rec = (await store.sessionsForDate(store.todayKey())).filter(s => !s.endedAt).pop();
    rec.startedAt -= 90 * 60000;
    rec.lastTick = rec.startedAt + 2000;
    await store.putSession(rec);
  })()`);

  /* 7c. 页面被回收 → 重开 → 应该接着算足 90 分钟 */
  await nav();
  await sleep(1600);
  const longResume = JSON.parse(await ev(`JSON.stringify({
    running: document.getElementById('focusLayer').classList.contains('is-running'),
    clock: document.getElementById('fClock').textContent,
  })`));
  console.log('     重开后计时器：' + longResume.clock);
  const secLong = (() => { const p = String(longResume.clock).split(':').map(Number); return p[0] * 3600 + p[1] * 60 + p[2]; })();
  ok('长会话自动接着算', longResume.running === true, JSON.stringify(longResume));
  ok('计时器读到了 90 分钟，不是从 0 开始', secLong >= 89 * 60, longResume.clock + '（' + secLong + ' 秒）');

  /* 7d. 停止 → 底部 / 扇形图 都要显示出来 */
  await ev(`document.getElementById('fStart').click()`);
  await sleep(700);
  await ev(`document.getElementById('fNoteText').value = '长会话测试'`);
  await ev(`document.getElementById('fNoteOk').click()`);
  await sleep(1800);

  const longBar = await ev(`document.getElementById('goalNow').textContent`);
  const longSum = JSON.parse(await ev(`(async () => {
    const store = await import('./js/store.js');
    const F = await import('./js/focus.js');
    const list = await store.sessionsForDate(store.todayKey());
    return JSON.stringify({
      minutes: Math.round(F.dayFocus(list.map(s => ({ ...s, away: s.away || [] }))).effectiveMs / 60000),
      donut: (() => {
        const d = document.querySelector('.donut-big');
        return d ? d.textContent : '';
      })(),
    });
  })()`));
  console.log('     底部专注：' + longBar);
  console.log('     当天合计：' + longSum.minutes + ' 分钟');

  ok('底部显示 1.5 小时左右', /^1h(2[5-9]|3[0-5])m$/.test(longBar), longBar);
  ok('当天合计正好 90 分钟出头', longSum.minutes >= 90 && longSum.minutes <= 92,
    longSum.minutes + ' 分钟');

  /* ── 8. 页面上没有报错 ──────────────────────────────── */
  console.log('\n  ── 8. 控制台 ──');
  ok('没有未捕获异常', pageErrors.length === 0, pageErrors.join(' | '));

  console.log('');
  console.log(`  结果：${pass} 通过，${fail} 失败`);
  console.log('');
} catch (e) {
  console.error('');
  console.error('  出错了：' + e.message);
  console.error(e.stack);
  fail++;
} finally {
  try { ws?.close(); } catch { /* 无所谓 */ }
  try { chrome.kill(); } catch { /* 无所谓 */ }
  for (let i = 0; i < 5; i++) {
    try { fs.rmSync(PROFILE, { recursive: true, force: true }); break; } catch { /* 下轮再试 */ }
  }
  process.exit(fail ? 1 : 0);
}
