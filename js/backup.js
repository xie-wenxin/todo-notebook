/* ═══════════════════════════════════════════════════════════
   backup.js — 导出 / 导入备份

   导出：把所有数据打成一个 .zip
         data.json            日期 / 待办 / 日记文字 / 专注会话 / 设置
         photos/<id>.jpg      大图
         photos/<id>.thumb.jpg 缩略图
         photos/<id>.json     尺寸等元信息
   导入：把 zip 读回来，可覆盖可合并。

   这是唯一的数据安全网 —— 浏览器数据说没就没，定期导一份存到「文件」App。
   ═══════════════════════════════════════════════════════════ */

import { idbAll, openDB } from './db.js';
import { createZip, readZip, saveBlob } from './zip.js';
import { dropCache } from './store.js';

const APP_TAG = 'todo-notebook';
const FORMAT = 1;

/* ── 打包（不下载） ────────────────────────────────────── */

/** 只把备份包拼出来，不触发下载。单独抽出来是为了能测。 */
export async function buildBackupBlob() {
  const [days, settings, sessions, photos, notes] = await Promise.all([
    idbAll('days'),
    idbAll('settings'),
    idbAll('sessions'),
    idbAll('photos'),
    idbAll('notes'),
  ]);

  const meta = {
    app: APP_TAG,
    format: FORMAT,
    exportedAt: new Date().toISOString(),
    counts: {
      days: days.length,
      sessions: sessions.length,
      photos: photos.length,
      notes: notes.length,
    },
  };

  const entries = [{
    name: 'data.json',
    data: JSON.stringify({ meta, days, settings, sessions, notes }),
  }];

  for (const p of photos) {
    if (!p || !p.id) continue;
    if (p.blob) entries.push({ name: `photos/${p.id}.jpg`, data: p.blob });
    if (p.thumb) entries.push({ name: `photos/${p.id}.thumb.jpg`, data: p.thumb });
    entries.push({
      name: `photos/${p.id}.json`,
      data: JSON.stringify({
        id: p.id, day: p.day,
        w: p.w, h: p.h, srcW: p.srcW, srcH: p.srcH,
        bytes: p.bytes, createdAt: p.createdAt,
      }),
    });
  }

  const blob = await createZip(entries);
  return { blob, meta, photoCount: photos.length };
}

/* ── 导出 ──────────────────────────────────────────────── */

export async function exportAll() {
  const { blob, meta } = await buildBackupBlob();

  const d = new Date();
  const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
  const name = `待办本子-备份-${stamp}.zip`;

  const how = await saveBlob(blob, name);

  return { ...meta.counts, bytes: blob.size, filename: name, how };
}

/* ── 导入 ──────────────────────────────────────────────── */

export async function readBackup(file) {
  const entries = await readZip(file);
  const map = new Map(entries.map(e => [e.name, e]));

  const dataEntry = map.get('data.json');
  if (!dataEntry) throw new Error('这个包里没有 data.json，可能选错文件了');

  const data = JSON.parse(new TextDecoder().decode(dataEntry.data));
  if (data.meta && data.meta.app && data.meta.app !== APP_TAG) {
    throw new Error('这不是待办本子的备份');
  }

  const photos = [];
  for (const e of entries) {
    const m = /^photos\/([^/]+)\.json$/.exec(e.name);
    if (!m) continue;
    let meta;
    try { meta = JSON.parse(new TextDecoder().decode(e.data)); } catch { continue; }
    photos.push({ id: m[1], meta });
  }

  return {
    meta: data.meta || {},
    days: Array.isArray(data.days) ? data.days : [],
    settings: Array.isArray(data.settings) ? data.settings : [],
    sessions: Array.isArray(data.sessions) ? data.sessions : [],
    notes: Array.isArray(data.notes) ? data.notes : [],
    photos,
    entries: map,
  };
}

/**
 * @param {File|Blob} file
 * @param {{ replace?: boolean }} opts  replace=true 覆盖，false 合并
 */
export async function importAll(file, { replace = true } = {}) {
  const pack = await readBackup(file);
  const { entries } = pack;

  const db = await openDB();

  const done = await new Promise((resolve, reject) => {
    const t = db.transaction(['days', 'settings', 'sessions', 'photos', 'notes'], 'readwrite');
    t.oncomplete = () => resolve(true);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error('导入被中止'));

    /* 注意：这一整段必须同步执行完，中间不能有 await，
       否则事务会被浏览器自动提交掉。 */
    if (replace) {
      for (const s of ['days', 'settings', 'sessions', 'photos', 'notes']) {
        t.objectStore(s).clear();
      }
    }

    for (const d of pack.days) if (d && d.date) t.objectStore('days').put(d);
    for (const s of pack.settings) if (s && s.key) t.objectStore('settings').put(s);
    for (const s of pack.sessions) if (s && s.id) t.objectStore('sessions').put(s);
    for (const n of pack.notes) if (n && n.id) t.objectStore('notes').put(n);

    for (const { id, meta } of pack.photos) {
      const full = entries.get(`photos/${id}.jpg`);
      if (!full) continue;
      const thumb = entries.get(`photos/${id}.thumb.jpg`);
      t.objectStore('photos').put({
        ...meta,
        id,
        blob: new Blob([full.data], { type: 'image/jpeg' }),
        thumb: thumb ? new Blob([thumb.data], { type: 'image/jpeg' }) : null,
      });
    }
  });

  dropCache();

  return {
    replaced: !!replace,
    days: pack.days.length,
    sessions: pack.sessions.length,
    photos: pack.photos.length,
    notes: pack.notes.length,
    ok: done,
  };
}
