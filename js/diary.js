/* ═══════════════════════════════════════════════════════════
   diary.js — 日记：文字和照片**一条流**

   以前照片一律堆在最下面，很别扭。
   现在是一个流：写一段字 → 插照片 → 再写一段字 → 再插照片……
   照片紧贴前面的字，照片后面也能接着写。

   数据结构：
     day.diary.blocks = [{ type:'text', text } | { type:'photo', id }]
   老数据（day.diary.text 是一整段字）打开时自动转成第一个文字块，不会丢。
   ═══════════════════════════════════════════════════════════ */

import { putDay, newId, fmtMain } from './store.js';
import { el, autoGrow } from './render.js';
import { idbGet, idbPut, idbDel } from './db.js';

const FULL_MAX = 1280;
const FULL_Q = 0.72;
const THUMB_MAX = 240;
const THUMB_Q = 0.6;

/* ── object URL 缓存 ───────────────────────────────────── */

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
      /* imageOrientation 不加的话，iPhone 竖拍的照片会躺倒 */
      return await createImageBitmap(file, { imageOrientation: 'from-image' });
    } catch { /* 落到兼容路径 */ }
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
      full: full.blob, thumb: thumb.blob,
      w: full.w, h: full.h, srcW, srcH,
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

  const blocks = getBlocks(day);
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
      blocks.push({ type: 'photo', id });
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
  const blocks = getBlocks(day);
  day.diary.blocks = blocks.filter(b => !(b.type === 'photo' && b.id === id));
  day.photos = (day.photos || []).filter(x => x !== id);
  await putDay(day);
  await idbDel('photos', id);
  dropURLs(id);
}

/* ── 数据：拿块列表（顺带把老数据搬过来） ──────────────── */

export function getBlocks(day) {
  if (!day.diary || typeof day.diary !== 'object') day.diary = { text: '' };
  if (!Array.isArray(day.diary.blocks)) {
    const t = String(day.diary.text || '');
    day.diary.blocks = t.trim() ? [{ type: 'text', text: t }] : [];
  }
  return day.diary.blocks;
}

/** 给备份 / PDF 用：把整篇日记取成纯文字 */
export function diaryText(day) {
  return getBlocks(day)
    .filter(b => b.type === 'text')
    .map(b => b.text)
    .filter(Boolean)
    .join('\n');
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

export async function openLightbox(day, id, ctx) {
  const lb = ensureLightbox();
  const url = await photoURL(id, 'full');
  if (!url) return;
  lb.img.src = url;
  lb.box.hidden = false;
  requestAnimationFrame(() => lb.box.classList.add('show'));

  lb.del.onclick = async () => {
    await deletePhoto(day, id);
    closeLightbox();
    ctx.onChange();
    renderDiary(day, ctx);
  };
}

export function closeLightbox() {
  if (!lightboxEl) return;
  const box = lightboxEl.box;
  box.classList.remove('show');
  setTimeout(() => { box.hidden = true; }, 260);
}

/* ── 画日记 ────────────────────────────────────────────── */

export function renderDiary(day, ctx) {
  const host = document.getElementById('diary');
  if (!host) return;
  host.textContent = '';

  const blocks = getBlocks(day);

  /* 隐藏的文件选择框 */
  const picker = el('input', {
    type: 'file', accept: 'image/*', multiple: true, class: 'file-hidden',
  });

  /* 右上角的 ＋ */
  const addBtn = el('button', {
    class: 'add-btn', type: 'button', 'aria-label': '添加内容', text: '+',
  });

  host.appendChild(el('div', { class: 'diary-head' }, [
    el('span', { class: 'diary-date', text: fmtMain(day.date) }),
    addBtn,
  ]));

  const flow = el('div', { class: 'diary-flow' });
  host.appendChild(flow);
  host.appendChild(picker);

  /* 点 ＋ 问一下要加哪种 */
  const menu = el('div', { class: 'df-add', hidden: true });
  const textBtn = el('button', { type: 'button', text: '文字' });
  const photoBtn = el('button', { type: 'button', text: '照片' });
  menu.append(textBtn, photoBtn);
  host.appendChild(menu);

  addBtn.addEventListener('click', () => { menu.hidden = !menu.hidden; });

  textBtn.addEventListener('click', async () => {
    menu.hidden = true;
    blocks.push({ type: 'text', text: '' });
    await putDay(day);
    paint();
    const tas = flow.querySelectorAll('textarea.df-text');
    const last = tas[tas.length - 1];
    if (last) { last.focus(); last.scrollIntoView({ block: 'center', behavior: 'smooth' }); }
  });

  photoBtn.addEventListener('click', () => { menu.hidden = true; picker.click(); });

  picker.addEventListener('change', async () => {
    if (!picker.files || !picker.files.length) return;
    addBtn.style.opacity = '.5';
    try {
      const { added, failed } = await addPhotos(day, picker.files);
      picker.value = '';
      paint();
      ctx.onChange();
      if (failed) ctx.toast(`${failed} 张读不出来`);
    } catch (e) {
      ctx.toast('加照片失败：' + (e.message || e));
    } finally {
      addBtn.style.opacity = '';
    }
  });

  /* ── 画每一块 ──────────────────────────────────────── */

  function paint() {
    flow.textContent = '';

    blocks.forEach((b, idx) => {
      if (b.type === 'photo') {
        const cell = el('button', { class: 'df-photo', type: 'button' });
        photoURL(b.id, 'thumb').then((url) => {
          if (url) cell.appendChild(el('img', { src: url, alt: '', loading: 'lazy' }));
          else { cell.classList.add('missing'); cell.textContent = '?'; }
        });
        cell.addEventListener('click', () => openLightbox(day, b.id, ctx));
        flow.appendChild(cell);
        return;
      }

      /* 文字块 */
      const ta = el('textarea', { class: 'df-text', rows: '1', autocorrect: 'on', autocomplete: 'off' });
      ta.value = b.text || '';

      let timer = null;
      const save = async () => {
        clearTimeout(timer);
        if ((b.text || '') === ta.value) return;
        b.text = ta.value;
        /* 空的文字块不留 */
        if (!b.text.trim() && blocks.length > 1) {
          const at = blocks.indexOf(b);
          if (at >= 0) blocks.splice(at, 1);
        }
        await putDay(day);
      };
      ta.addEventListener('input', () => {
        autoGrow(ta, 1);
        clearTimeout(timer);
        timer = setTimeout(save, 600);
      });
      ta.addEventListener('blur', save);

      flow.appendChild(ta);
    });

    requestAnimationFrame(() => {
      flow.querySelectorAll('textarea.df-text').forEach(t => autoGrow(t, 1));
    });
  }

  paint();

  if (lightboxEl && !lightboxEl.box.hidden) closeLightbox();
}
