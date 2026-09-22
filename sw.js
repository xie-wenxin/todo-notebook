/* ═══════════════════════════════════════════════════════════
   sw.js — 离线缓存
   策略：网络优先，失败回落缓存。
   为什么不用「缓存优先」：现在我们还在频繁改代码，缓存优先会让你
   改了代码刷新还是旧的，很折磨人。等第 6 步定稿了再换成缓存优先提速。
   ═══════════════════════════════════════════════════════════ */

const CACHE = 'notebook-v1';

const SHELL = [
  './',
  './index.html',
  './manifest.webmanifest',
  './css/theme.css',
  './css/base.css',
  './css/print.css',
  './js/app.js',
  './js/db.js',
  './js/store.js',
  './js/render.js',
  './js/theme.js',
  './js/daystrip.js',
  './js/gestures.js',
  './js/focus.js',
  './js/focus-ui.js',
  './js/summary.js',
  './js/diary.js',
  './js/notes.js',
  './js/schedule.js',
  './js/schedule-data.js',
  './js/sleep.js',
  './js/habits.js',
  './js/zip.js',
  './js/backup.js',
  './js/print.js',
  './icons/icon.svg',
];

self.addEventListener('install', (e) => {
  e.waitUntil((async () => {
    const c = await caches.open(CACHE);
    /* 逐个加，某个文件 404 不至于让整个安装失败 */
    await Promise.all(SHELL.map(u => c.add(u).catch(() => {})));
    self.skipWaiting();
  })());
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== location.origin) return;

  e.respondWith((async () => {
    try {
      const res = await fetch(req);
      if (res && res.status === 200 && res.type === 'basic') {
        const copy = res.clone();
        caches.open(CACHE).then(c => c.put(req, copy)).catch(() => {});
      }
      return res;
    } catch {
      const hit = await caches.match(req);
      if (hit) return hit;
      if (req.mode === 'navigate') {
        const shell = await caches.match('./index.html');
        if (shell) return shell;
      }
      return new Response('离线了，而且这个文件没缓存', {
        status: 503,
        headers: { 'Content-Type': 'text/plain; charset=utf-8' },
      });
    }
  })());
});
