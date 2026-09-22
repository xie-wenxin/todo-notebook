/* ═══════════════════════════════════════════════════════════
   diary.js — 时间块下面的日记本

   文字：多行输入，画成信纸的样子（横线跟着行高走），打字停 0.6 秒自动存盘。
   照片：拍照或从相册选 → 当场压缩 → 大图 + 缩略图分别存进 IndexedDB。
        列表里只解码缩略图，所以照片攒到几百张也不会卡。

   压缩很关键：iPhone 原图一张 3–5MB，不压缩的话一年就是 7GB。
   压到长边 1280 / JPEG 0.72，一张约 170KB，每天 15 张一年约 930MB。
   ═══════════════════════════════════════════════════════════ */

import { putDay, newId, fmtMain } from './store.js';
import { el, autoGrow } from './render.js';
import { idbGet, idbPut, idbDel } from './db.js';

const FULL_MAX = 1280;      // 大图长边
const FULL_Q = 0.72;
const THUMB_MAX = 240;      // 缩略图长边
const THUMB_Q = 0.6;

/* ── object URL 缓存：避免同一张图反复解码 ─────────────── */

const urlCache = new Map();
const URL_CAP = 240;

export async function photoURL(id, which = 'thumb') {
  const key = id + ':' + which;
  if (urlCache.has(key)) return urlCache.get(key);

  const rec = await idbGet('photos', id);
  if (!rec) return null;
  const blob = which === 'thumb' ? (rec.thumb || rec.blob) : rec.blob;
  if (!blob) return null;

  const url = URL.createObjectURL(blob);
  urlCache.set(key, url);

  if (urlCache.size > URL_CAP) {
    const oldest = urlCache.keys().next().value;
    const old = urlCache.get(oldest);
    urlCache.delete(oldest);
    try { URL.revokeObjectURL(old); } catch { /* 无所谓 */ }
  }
  return url;
}

function dropURLs(id) {
  for (const which of ['thumb', 'full']) {
    const key = id + ':' + which;
    if (urlCache.has(key)) {
      try { URL.revokeObjectURL(urlCache.get(key)); } catch { /* 无所谓 */ }
      urlCache.delete(key);
    }
  }
}

/* ── 压缩 ──────────────────────────────────────────────── */

async function loadBitmap(file) {
  if (typeof createImageBitmap === 'function') {
    try {
      /* imageOrientation 很重要：不加的话 iPhone 竖拍的照片会躺倒 */
      return await createImageBitmap(file, { imageOrientation: 'from-image' });
    } catch { /* 落到下面的兼容路径 */ }
  }
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    await new Promise((res, rej) => {
      img.onload = res;
      img.onerror = () => rej(new Error('这张图读不出来'));
      img.src = url;
    });
    return img;
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 30000);
  }
}

function drawTo(src, maxEdge, quality) {
  const sw = src.width || src.naturalWidth;
  const sh = src.height || src.naturalHeight;
  const scale = Math.min(1, maxEdge / Math.max(sw, sh));
  const w = Math.max(1, Math.round(sw * scale));
  const h = Math.max(1, Math.round(sh * scale));

  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const g = c.getContext('2d');
  g.imageSmoothingEnabled = true;
  g.imageSmoothingQuality = 'high';
  g.drawImage(src, 0, 0, w, h);

  return new Promise((resolve, reject) => {
    c.toBlob((blob) => {
      if (blob) resolve({ blob, w, h });
      else reject(new Error('压缩失败'));
    }, 'image/jpeg', quality);
  });
}

async function compressFile(file) {
  const bmp = await loadBitmap(file);
  try {
    const srcW = bmp.width || bmp.naturalWidth;
    const srcH = bmp.height || bmp.naturalHeight;
    const full = await drawTo(bmp, FULL_MAX, FULL_Q);
    const thumb = await drawTo(bmp, THUMB_MAX, THUMB_Q);
    return {
      full: full.blob,
      thumb: thumb.blob,
      /* 存的是压缩后的实际尺寸，方便核对有没有超过长边上限 */
      w: full.w,
      h: full.h,
      srcW, srcH,
      bytes: full.blob.size + thumb.blob.size,
    };
  } finally {
    if (bmp && typeof bmp.close === 'function') bmp.close();
  }
}

/* ── 加照片 ────────────────────────────────────────────── */

export async function addPhotos(day, files) {
  const list = [...files].filter(f => f && /^image\//.test(f.type));
  if (!list.length) return { added: [], failed: 0 };

  const added = [];
  let failed = 0;

  for (const f of list) {
    try {
      const c = await compressFile(f);
      const id = 'p' + newId();
      await idbPut('photos', {
        id, day: day.date,
        blob: c.full, thumb: c.thumb,
        w: c.w, h: c.h, bytes: c.bytes,
        createdAt: Date.now(),
      });
      if (!Array.isArray(day.photos)) day.photos = [];
      day.photos.push(id);
      added.push(id);
    } catch {
      failed++;
    }
  }

  if (added.length) await putDay(day);
  return { added, failed };
}

export async function deletePhoto(day, id) {
  day.photos = (day.photos || []).filter(x => x !== id);
  await putDay(day);
  await idbDel('photos', id);
  dropURLs(id);
}

/* ── 大图查看 ──────────────────────────────────────────── */

let lightboxEl = null;

function ensureLightbox() {
  if (lightboxEl) return lightboxEl;
  const box = el('div', { class: 'lightbox', id: 'lightbox', hidden: true });
  const img = el('img', { class: 'lb-img', alt: '' });
  const bar = el('div', { class: 'lb-bar' });
  const close = el('button', { class: 'lb-btn', type: 'button', text: '关闭' });
  const del = el('button', { class: 'lb-btn danger', type: 'button', text: '删除这张' });

  close.addEventListener('click', closeLightbox);
  box.addEventListener('click', (e) => { if (e.target === box) closeLightbox(); });

  bar.append(del, close);
  box.append(img, bar);
  document.body.appendChild(box);
  lightboxEl = { box, img, del };
  return lightboxEl;
}

let lightboxCtx = null;

export async function openLightbox(day, id, ctx) {
  const lb = ensureLightbox();
  const url = await photoURL(id, 'full');
  if (!url) return;
  lb.img.src = url;
  lb.box.hidden = false;
  requestAnimationFrame(() => lb.box.classList.add('show'));

  lightboxCtx = { day, id, ctx };
  lb.del.onclick = async () => {
    await deletePhoto(day, id);
    closeLightbox();
    ctx.onChange();
    ctx.refreshDiary?.();
  };
}

export function closeLightbox() {
  if (!lightboxEl) return;
  lightboxEl.box.classList.remove('show');
  const box = lightboxEl.box;
  setTimeout(() => { box.hidden = true; }, 260);
  lightboxCtx = null;
}

/* ── 画日记区（极简：左边日期，右上加号） ──────────────── */

export function renderDiary(day, ctx) {
  const host = document.getElementById('diary');
  if (!host) return;
  host.textContent = '';

  /* 隐藏的文件选择框 */
  const picker = el('input', {
    type: 'file',
    accept: 'image/*',
    multiple: true,
    class: 'file-hidden',
  });

  /* 右上角的小加号 —— 和待办那个加号是同一个样式 */
  const addBtn = el('button', {
    class: 'add-btn',
    type: 'button',
    'aria-label': '添加照片',
    text: '+',
  });

  host.appendChild(el('div', { class: 'diary-head' }, [
    el('span', { class: 'diary-date', text: fmtMain(day.date) }),
    addBtn,
  ]));

  /* 文字：不放提示语，也不画横线，就一个干净的白框 */
  const ta = el('textarea', {
    class: 'diary-text',
    rows: '3',
    autocorrect: 'on',
    autocomplete: 'off',
  });
  ta.value = (day.diary && day.diary.text) || '';

  let timer = null;
  const save = async () => {
    clearTimeout(timer);
    if (!day.diary) day.diary = { text: '' };
    if (day.diary.text === ta.value) return;
    day.diary.text = ta.value;
    await putDay(day);
  };
  ta.addEventListener('input', () => {
    autoGrow(ta, 3);
    clearTimeout(timer);
    timer = setTimeout(save, 600);
  });
  ta.addEventListener('blur', save);

  host.appendChild(ta);

  const grid = el('div', { class: 'photo-grid' });
  host.appendChild(grid);
  host.appendChild(picker);

  addBtn.addEventListener('click', () => picker.click());

  picker.addEventListener('change', async () => {
    if (!picker.files || !picker.files.length) return;
    addBtn.textContent = '…';
    addBtn.style.opacity = '.55';
    try {
      const { added, failed } = await addPhotos(day, picker.files);
      picker.value = '';
      await paintPhotos();
      ctx.onChange();
      if (added.length) ctx.toast(`加了 ${added.length} 张照片`);
      if (failed) ctx.toast(`${failed} 张读不出来，跳过了`);
    } catch (e) {
      ctx.toast('加照片失败：' + (e.message || e));
    } finally {
      addBtn.textContent = '+';
      addBtn.style.opacity = '';
    }
  });

  async function paintPhotos() {
    grid.textContent = '';
    const ids = day.photos || [];

    for (const id of ids) {
      const url = await photoURL(id, 'thumb');
      const cell = el('button', { class: 'photo-cell', type: 'button' });
      if (url) {
        cell.appendChild(el('img', { src: url, alt: '', loading: 'lazy' }));
      } else {
        cell.classList.add('missing');
        cell.appendChild(el('span', { text: '?' }));
      }
      cell.addEventListener('click', () => openLightbox(day, id, ctx));
      grid.appendChild(cell);
    }
  }

  requestAnimationFrame(() => {
    autoGrow(ta, 3);
    paintPhotos();
  });

  /* 换天的时候把大图收起来，别停在上一张上 */
  if (lightboxEl && !lightboxEl.box.hidden) closeLightbox();
}
