/* ═══════════════════════════════════════════════════════════
   sw.js — 离线缓存

   策略：**先给缓存，后台偷偷更新**（stale-while-revalidate）

   为什么不用「网络优先」：那样每次打开 App 都要等网络把十几个文件
   重新下完，手机上就是**黑屏那几秒**。缓存优先是立刻出画面，
   新版本在后台下好，下次打开就是新的。

   ⚠️ 改了代码要发新版本时，把下面的 VERSION 加一。
   ═══════════════════════════════════════════════════════════ */

const VERSION = 'v7';
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
    const stale = keys.filter(k => k !== CACHE);
    /* 有旧缓存 → 这次是「更新」，不是第一次安装 */
    const isUpdate = stale.length > 0;

    await Promise.all(stale.map(k => caches.delete(k)));
    await self.clients.claim();

    /* 更新完让开着的页面重载一次。
       不然会出现「新 index.html + 旧 app.js」这种半新半旧的状态，
       一堆莫名其妙的毛病（改了没反应、点了没动静）都是这么来的。
       第一次安装不重载，免得白闪一下。 */
    if (isUpdate) {
      try {
        const all = await self.clients.matchAll({ type: 'window' });
        for (const c of all) { try { c.navigate(c.url); } catch { /* 无所谓 */ } }
      } catch { /* 无所谓 */ }
    }
  })());
});

/* ── 页面可以来问「你是哪个版本」 ─────────────────────────
   页面拿到版本号一比对，就知道自己是不是被旧缓存喂着。
   ─────────────────────────────────────────────────────── */
self.addEventListener('message', (e) => {
  const port = e.ports && e.ports[0];
  if (!port) return;
  port.postMessage({ version: VERSION });
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
