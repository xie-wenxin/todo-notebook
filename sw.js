/* ═══════════════════════════════════════════════════════════
   sw.js — 离线缓存

   策略：**先给缓存，后台偷偷更新**（stale-while-revalidate）

   为什么不用「网络优先」：那样每次打开 App 都要等网络把十几个文件
   重新下完，手机上就是**黑屏那几秒**。缓存优先是立刻出画面，
   新版本在后台下好，下次打开就是新的。

   ⚠️ 改了代码要发新版本时，把下面的 VERSION 加一。
   ═══════════════════════════════════════════════════════════ */

const VERSION = 'v3';
const CACHE = 'notebook-' + VERSION;

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
  './js/habits.js',
  './js/schedule.js',
  './js/schedule-data.js',
  './js/sleep.js',
  './js/goals.js',
  './js/zip.js',
  './js/backup.js',
  './js/print.js',
  './icons/icon.svg',
  './icons/icon-180.png',
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
    const cache = await caches.open(CACHE);
    const hit = await cache.match(req);

    /* 后台更新：不阻塞返回，下次打开就是新的 */
    const fresh = fetch(req).then((res) => {
      if (res && res.status === 200 && res.type === 'basic') {
        cache.put(req, res.clone()).catch(() => {});
      }
      return res;
    }).catch(() => null);

    if (hit) return hit;

    const res = await fresh;
    if (res) return res;

    if (req.mode === 'navigate') {
      const shell = await cache.match('./index.html');
      if (shell) return shell;
    }
    return new Response('离线了，而且这个文件没缓存', {
      status: 503,
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    });
  })());
});
