/* ═══════════════════════════════════════════════════════════
   server.cjs — 本地预览服务器
   零依赖，只用 Node 自带的模块，不需要 npm install。
   为什么必须用服务器：直接双击 index.html 是 file:// 协议，
   Safari / Chrome 会禁用 IndexedDB 和 Service Worker，数据存不进去。

   用法：双击 start.bat，或者在本目录执行
        node server.cjs
   ═══════════════════════════════════════════════════════════ */

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { exec } = require('child_process');

const ROOT = __dirname;
const PORT = Number(process.env.PORT || 5173);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.cjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
};

const server = http.createServer((req, res) => {
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  } catch {
    res.writeHead(400); res.end('bad request'); return;
  }

  /* 以 / 结尾的地址当作目录，补上 index.html。
     GitHub Pages 就是这么干的（/仓库名/ 会返回 index.html），
     这里必须一致，否则本地能跑、部署上去 404。 */
  if (pathname.endsWith('/')) pathname += 'index.html';

  /* 测试钩子：/_delay/毫秒
     无头浏览器会在 load 事件后才 dump DOM，而 IndexedDB 的回调是异步的，
     所以测试页里挂一张指向这里的图，就能把 load 拖住，等异步跑完。
     正常用不到，留着不碍事。 */
  const dm = /^\/_delay\/(\d{1,5})$/.exec(pathname);
  if (dm) {
    const ms = Math.min(Number(dm[1]) || 1000, 20000);
    setTimeout(() => { res.writeHead(204); res.end(); }, ms);
    return;
  }

  const full = path.resolve(ROOT, '.' + pathname);

  /* 不许跳出项目目录 */
  if (full !== ROOT && !full.startsWith(ROOT + path.sep)) {
    res.writeHead(403); res.end('forbidden'); return;
  }

  fs.readFile(full, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('404  ' + pathname);
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(full).toLowerCase()] || 'application/octet-stream',
      /* 全部不缓存，改完代码刷新就见效 */
      'Cache-Control': 'no-store, must-revalidate',
    });
    res.end(data);
  });
});

function lanIPs() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const i of list || []) {
      if (i.family === 'IPv4' && !i.internal) out.push(i.address);
    }
  }
  return out;
}

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error(`\n  端口 ${PORT} 被占了。\n`);
    console.error(`  可能已经开着一个了 —— 先直接打开 http://localhost:${PORT}/ 看看。`);
    console.error(`  想换个端口： set PORT=5174 && node server.cjs\n`);
  } else {
    console.error('\n  启动失败：', e.message, '\n');
  }
  process.exit(1);
});

server.listen(PORT, () => {
  const url = `http://localhost:${PORT}/`;
  console.log('');
  console.log('  ┌─────────────────────────────────────────────┐');
  console.log('  │  待办本子 · 本地预览                        │');
  console.log('  └─────────────────────────────────────────────┘');
  console.log('');
  console.log(`  电脑上打开：  ${url}`);
  for (const ip of lanIPs()) {
    console.log(`  手机上打开：  http://${ip}:${PORT}/    （同一 WiFi 下）`);
  }
  console.log('');
  console.log('  手机上这个地址是 http，不能「添加到主屏幕」做离线用。');
  console.log('  要在手机上真正用起来，得部署到 https（见 部署说明.md）。');
  console.log('');
  console.log('  按 Ctrl+C 停止。');
  console.log('');

  /* Windows 上自动把浏览器打开 */
  if (process.platform === 'win32' && !process.env.NO_OPEN) {
    exec(`start "" "${url}"`, () => {});
  }
});
