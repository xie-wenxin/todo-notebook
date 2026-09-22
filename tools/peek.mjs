/* ═══════════════════════════════════════════════════════════
   peek.mjs — 快速看一眼页面现在的状态（不做完整测试）
   用法：node tools/peek.mjs "表达式"
   表达式在页面里执行，返回值打印出来。省得每次都跑 4 分钟的完整测试。
   ═══════════════════════════════════════════════════════════ */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CHROME = process.env.CHROME || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const URL = process.argv[2] || 'http://localhost:5173/';
/* 表达式也可以从环境变量 PEEK_EXPR 读 —— 免得被 shell 的引号规则搞死 */
const EXPR = process.env.PEEK_EXPR || process.argv[3] || 'document.querySelectorAll(".block").length';
const PORT = Number(process.env.CDP_PORT || 9444);
const PROFILE = path.join(os.tmpdir(), 'dsh-peek-profile');

fs.rmSync(PROFILE, { recursive: true, force: true });

const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run',
  '--disable-crashpad', '--disable-extensions',
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${PROFILE}`, 'about:blank',
], { stdio: 'ignore' });

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

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
  const errors = [];

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
        errors.push(d.exception?.description || d.text || '?');
      }
    };
  });

  const send = (method, params = {}) => new Promise((res, rej) => {
    const id = ++seq;
    pending.set(id, { res, rej });
    ws.send(JSON.stringify({ id, method, params }));
  });

  await send('Runtime.enable');
  await send('Page.enable');
  await send('Page.navigate', { url: URL });
  await sleep(3200);

  const r = await send('Runtime.evaluate', {
    expression: EXPR, awaitPromise: true, returnByValue: true,
  });

  console.log('');
  if (r.exceptionDetails) {
    console.log('页面里报错了：');
    console.log(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  } else {
    const v = r.result.value;
    console.log(typeof v === 'string' ? v : JSON.stringify(v, null, 2));
  }
  if (errors.length) {
    console.log('');
    console.log('未捕获异常：');
    for (const e of errors) console.log('  ' + e.split('\n')[0]);
  }
  console.log('');
} catch (e) {
  console.error('出错了：' + e.message);
  process.exitCode = 1;
} finally {
  try { ws?.close(); } catch { /* 无所谓 */ }
  try { chrome.kill(); } catch { /* 无所谓 */ }
  setTimeout(() => { fs.rmSync(PROFILE, { recursive: true, force: true }); process.exit(); }, 400);
}
