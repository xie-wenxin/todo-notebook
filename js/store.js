/* ═══════════════════════════════════════════════════════════
   store.js — 数据层：时间块模板、配色表、日期工具、读写一天
   ═══════════════════════════════════════════════════════════ */

import { idbGet, idbPut, idbDel, idbAll, openDB } from './db.js';

/* ── 时间块模板（按你的日程表） ─────────────────────────
   study: true 的块累加起来 = 1 + 4 + 4 + 3 = 12h，正好是目标
   habit: 有值表示这是一个习惯项，第 4 步会拿去做打卡矩阵
   ─────────────────────────────────────────────────────── */

export const TEMPLATE = [
  {
    id: 'b1', start: '06:30', end: '08:00',
    title: '英语', sub: '单词 · 听力 · 作文（醒来即开始跟读）',
    hours: 1, study: true, habit: '英语',
  },
  {
    id: 'b2', start: '08:00', end: '12:00',
    title: '专业课 / 考研', sub: '上午整块，不切碎',
    hours: 4, study: true, habit: null,
  },
  {
    id: 'b3', start: '12:00', end: '14:00',
    title: '午间', sub: '上午总结 · 午休 30min · 饭后站 30min · 背单词',
    hours: 0, study: false, habit: '背单词',
  },
  {
    id: 'b4', start: '14:00', end: '18:00',
    title: '专业课 / 考研', sub: '下午整块，不切碎',
    hours: 4, study: true, habit: null,
  },
  {
    id: 'b5', start: '18:00', end: '19:00',
    title: '杂事', sub: '回消息、处理杂事 —— 不许外溢到其他时段',
    hours: 0, study: false, habit: null,
  },
  {
    id: 'b6', start: '19:00', end: '20:00',
    title: '运动', sub: '必要项，不可跳过',
    hours: 0, study: false, habit: '运动',
  },
  {
    id: 'b7', start: '20:00', end: '23:00',
    title: '晚间', sub: '总结所学 · 练习 · 练字 · 复习单词',
    hours: 3, study: true, habit: '练字',
  },
];

export const TARGET_HOURS = TEMPLATE.reduce((s, b) => s + b.hours, 0); // = 12
export const DAY_START = '06:30';
export const DAY_END = '23:30';

/**
 * 当前构建版本号。改了代码要发新版时，**这里和 sw.js 的 VERSION 一起改**。
 * 页面上会显示出来（总结页底部 + 小本子→备份），用来一眼确认
 * 「手机上跑的是不是我刚传上去的那一版」。这两个字符串必须一致，
 * 对不上时 app.js 会清缓存重载。
 */
export const APP_BUILD = 'v7';

/** 从模板自动抽出的初始习惯 —— 只在第一次初始化时用一次，之后就以数据为准 */
export const DEFAULT_HABITS = [...new Set(TEMPLATE.map(b => b.habit).filter(Boolean))];

/* 兼容别名：还有几处在用，下一批会全部改成读 allHabitDefs() */
export const HABITS = DEFAULT_HABITS;

/** 习惯名 → 它最初挂在哪一块上（只对模板里那几个有效） */
export function habitBlock(name) {
  return TEMPLATE.find(b => b.habit === name) || null;
}

/* ── 配色表（必须和 theme.css 里的 id 一一对应） ────────── */

export const THEMES = [
  { id: 'mint',      name: '薄荷',   paper: '#E9F6EF', ink: '#1E3A31', accent: '#3E8F71', dark: false },
  { id: 'cream',     name: '奶油',   paper: '#FDF6E3', ink: '#3D3520', accent: '#B98D1B', dark: false },
  { id: 'sky',       name: '天空',   paper: '#EAF3FB', ink: '#1F3346', accent: '#3D80B4', dark: false },
  { id: 'sakura',    name: '樱花',   paper: '#FDF0F3', ink: '#43272F', accent: '#B85C78', dark: false },
  { id: 'lavender',  name: '薰衣草', paper: '#F2EFFB', ink: '#2C2745', accent: '#6E5CB8', dark: false },
  { id: 'apricot',   name: '暖杏',   paper: '#FDF1E7', ink: '#402C1C', accent: '#BE6F2E', dark: false },
  { id: 'oat',       name: '燕麦',   paper: '#F7F3EC', ink: '#38312A', accent: '#8F7A55', dark: false },
  { id: 'turquoise', name: '松石',   paper: '#E6F4F1', ink: '#1B3833', accent: '#2F8478', dark: false },
  { id: 'mist',      name: '雾霾',   paper: '#EDF1F5', ink: '#2A333C', accent: '#587089', dark: false },
  { id: 'tea',       name: '茶绿',   paper: '#EEF4EC', ink: '#33422F', accent: '#6E8F63', dark: false },
  { id: 'coral',     name: '珊瑚',   paper: '#FDF0EC', ink: '#4A2A22', accent: '#C9603F', dark: false },
  { id: 'sage',      name: '鼠尾草', paper: '#EEF2EA', ink: '#333D31', accent: '#7C9473', dark: false },
  { id: 'sand',      name: '沙',     paper: '#FAF3E8', ink: '#413528', accent: '#BFA070', dark: false },
  { id: 'plum',      name: '梅子',   paper: '#F7EEF2', ink: '#3F2833', accent: '#9E6B84', dark: false },
  { id: 'deepblue',  name: '深蓝',   paper: '#2A4674', ink: '#F1F6FC', accent: '#9CC4EE', dark: true },
  { id: 'forest',    name: '墨绿',   paper: '#2C5749', ink: '#F0F7F4', accent: '#9AD2BB', dark: true },
  { id: 'wine',      name: '酒红',   paper: '#813748', ink: '#FBF2F4', accent: '#F0A9B8', dark: true },
  { id: 'caramel',   name: '焦糖',   paper: '#A85D1C', ink: '#FDF6EE', accent: '#F5C592', dark: true },
  { id: 'berry',     name: '莓果',   paper: '#634784', ink: '#F8F4FC', accent: '#C8AEE4', dark: true },
];

export const DEFAULT_THEME = 'mint';

export function themeById(id) {
  return THEMES.find(t => t.id === id) || THEMES[0];
}

/* ── 设置 ──────────────────────────────────────────────── */

const DEFAULT_SETTINGS = {
  key: 'app',
  theme: DEFAULT_THEME,
  fs: 1,
  lastSeen: null,       // 上次打开时看到的日期，用来判断要不要自动翻页
  onboarded: false,
};

let _settings = null;

export async function loadSettings() {
  if (_settings) return _settings;
  const s = await idbGet('settings', 'app');
  _settings = { ...DEFAULT_SETTINGS, ...(s || {}) };
  return _settings;
}

export async function saveSettings(patch) {
  const s = await loadSettings();
  Object.assign(s, patch);
  if ('habits' in patch) _habitCache = null;
  await idbPut('settings', s);
  return s;
}

/* ── 习惯（可增删的数据，不再是写死的常量） ──────────────
   每项带起止日期：
     { name, start:'YYYY-MM-DD', end:null|'YYYY-MM-DD' }
   删掉不抹历史 —— 只给它一个 end 日期，那一行就停在那儿不往后长。
   ─────────────────────────────────────────────────────── */

let _habitCache = null;

export async function allHabitDefs() {
  if (_habitCache) return _habitCache;
  const s = await loadSettings();
  if (!Array.isArray(s.habits) || !s.habits.length) {
    /* 第一次：拿模板里那几个初始化，之后就以数据为准。
       注意先把值存进局部变量 —— saveSettings 会把 _habitCache 置空，
       直接 return _habitCache 会返回 null（这个坑踩过一次）。 */
    const init = DEFAULT_HABITS.map(name => ({ name, start: todayKey(), end: null }));
    _habitCache = init;
    await saveSettings({ habits: init });
    return init;
  }
  _habitCache = s.habits;
  return _habitCache;
}

/** 现在还在用的习惯名 */
export async function activeHabits() {
  const list = await allHabitDefs();
  return list.filter(h => !h.end).map(h => h.name);
}

/** 某个日期那天生效的习惯名 —— 历史按当时的清单算，不会因为今天改了而变 */
export function habitsOn(defs, date) {
  return defs.filter(h => h.start <= date && (!h.end || date <= h.end)).map(h => h.name);
}

export async function addHabit(name) {
  const list = await allHabitDefs();
  const n = String(name || '').trim();
  if (!n) return list;
  const exist = list.find(h => h.name === n);
  if (exist) {
    if (exist.end) { exist.end = null; await saveSettings({ habits: list }); }
    return list;
  }
  list.push({ name: n, start: todayKey(), end: null });
  await saveSettings({ habits: list });
  return list;
}

export async function renameHabit(from, to) {
  const list = await allHabitDefs();
  const n = String(to || '').trim();
  if (!n) return list;
  const h = list.find(x => x.name === from);
  if (!h || n === from) return list;
  /* 改名 = 停用旧的 + 新开一个，这样老数据仍然挂在老名字下（可追溯） */
  h.end = todayKey();
  if (!list.some(x => x.name === n && !x.end)) {
    list.push({ name: n, start: todayKey(), end: null });
  }
  await saveSettings({ habits: list });
  return list;
}

export async function removeHabit(name) {
  const list = await allHabitDefs();
  const h = list.find(x => x.name === name);
  if (h && !h.end) {
    h.end = todayKey();
    await saveSettings({ habits: list });
  }
  return list;
}

/* ── 一天 ──────────────────────────────────────────────── */

export function blankDay(date) {
  return {
    date,
    theme: null,          // null = 跟随全局默认色
    todos: {},            // { 块id: [ {id,text,done,createdAt,doneAt} ] }
    habits: {},           // { 习惯名: true } —— 手动打卡
    diary: { text: '' },  // 第 5 步用
    photos: [],           // 第 5 步用
    sleepAt: null,        // 点月亮记下时间
    wakeAt: null,         // 点太阳记下时间
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

const _cache = new Map();

export async function getDay(date) {
  if (_cache.has(date)) return _cache.get(date);
  const rec = await idbGet('days', date);
  const day = rec ? normalizeDay(rec) : blankDay(date);
  _cache.set(date, day);
  return day;
}

function normalizeDay(rec) {
  const base = blankDay(rec.date);
  const day = { ...base, ...rec };
  day.todos = rec.todos && typeof rec.todos === 'object' ? rec.todos : {};
  day.habits = rec.habits && typeof rec.habits === 'object' ? rec.habits : {};
  day.diary = rec.diary && typeof rec.diary === 'object' ? rec.diary : { text: '' };
  if (!Array.isArray(day.photos)) day.photos = [];

  /* 空待办不留：点了 ⊕ 又没写字的，重开时自动清掉 */
  for (const k of Object.keys(day.todos)) {
    const list = Array.isArray(day.todos[k]) ? day.todos[k] : [];
    const kept = list.filter(t => t && String(t.text || '').trim() !== '');
    if (kept.length) day.todos[k] = kept;
    else delete day.todos[k];
  }

  return day;
}

export async function putDay(day) {
  day.updatedAt = Date.now();
  _cache.set(day.date, day);
  await idbPut('days', day);
  return day;
}

export function dropCache(date) {
  if (date) _cache.delete(date); else _cache.clear();
}

/* ── 日期工具（全部按本地时区，不用 UTC，免得跨时区错一天） ── */

const DOW = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

export function dateKey(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
}

export function todayKey() { return dateKey(new Date()); }

export function fromKey(k) {
  const [y, m, d] = String(k).split('-').map(Number);
  return new Date(y, m - 1, d);
}

export function addDays(k, n) {
  const d = fromKey(k);
  d.setDate(d.getDate() + n);
  return dateKey(d);
}

export function diffDays(a, b) {
  const ms = fromKey(b).getTime() - fromKey(a).getTime();
  return Math.round(ms / 86400000);
}

export function fmtMain(k) {
  const d = fromKey(k);
  return `${d.getMonth() + 1}月${d.getDate()}日`;
}

export function fmtSub(k) {
  const d = fromKey(k);
  const t = todayKey();
  const n = diffDays(t, k);
  if (n === 0) return `今天 · ${DOW[d.getDay()]}`;
  if (n === -1) return `昨天 · ${DOW[d.getDay()]}`;
  if (n === 1) return `明天 · ${DOW[d.getDay()]}`;
  if (n === -2) return `前天 · ${DOW[d.getDay()]}`;
  return `${DOW[d.getDay()]} · ${d.getFullYear()}`;
}

export function dowShort(k) { return DOW[fromKey(k).getDay()].replace('周', ''); }
export function dayNum(k) { return fromKey(k).getDate(); }
export function dowLong(k) { return DOW[fromKey(k).getDay()]; }

/* ── 时间工具 ──────────────────────────────────────────── */

export function toMin(hhmm) {
  const [h, m] = String(hhmm).split(':').map(Number);
  return h * 60 + m;
}

export function nowMin(d = new Date()) {
  return d.getHours() * 60 + d.getMinutes();
}

/** 这个块现在是不是正在进行；返回 0=已过去 1=进行中 2=还没到 */
export function blockPhase(block, d = new Date()) {
  const n = nowMin(d);
  if (n < toMin(block.start)) return 2;
  if (n >= toMin(block.end)) return 0;
  return 1;
}

/* 时长的格式化统一在 focus.js 的 fmtDur() —— 别在这里另起一份，
   同一个格式算两遍，就会出现「一处显示 13s、另一处显示 0h00m」。 */

/* ── 一天的完成情况（给九日小本子用） ──────────────────── */

export function dayProgress(day) {
  let total = 0, done = 0, studyDone = 0;
  for (const b of TEMPLATE) {
    const list = day.todos?.[b.id] || [];
    total += list.length;
    const d = list.filter(t => t.done).length;
    done += d;
    // 学习块的进度按"勾选比例 × 该块小时数"折算
    if (b.study && list.length > 0) studyDone += b.hours * (d / list.length);
  }
  return {
    total, done,
    ratio: total ? done / total : 0,
    studyHours: studyDone,
  };
}

/* ── 待办 id ───────────────────────────────────────────── */

export function newId() {
  return 't' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

/* ── 专注会话 ──────────────────────────────────────────── */

/** 某一天的全部专注会话 */
export async function sessionsForDate(date) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const t = db.transaction('sessions', 'readonly');
    const req = t.objectStore('sessions').index('date').getAll(IDBKeyRange.only(date));
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}

export async function putSession(session) {
  await idbPut('sessions', session);
  return session;
}

/** 找一个还没结束的会话 —— 用来在页面被杀掉后接着上次继续 */
export async function findRunningSession() {
  const all = await idbAll('sessions');
  return all.find(s => !s.endedAt) || null;
}

export async function allSessions() {
  return idbAll('sessions');
}

export async function deleteSession(id) {
  return idbDel('sessions', id);
}

/* ── 便签 ──────────────────────────────────────────────── */

/**
 * 便签用固定的浅色，不跟主题走 —— 因为真实世界的便签就是那几个颜色，
 * 而且不管本子换成什么色，便签都该一眼认出来。
 */
export const NOTE_COLORS = [
  { id: 'yellow', name: '黄', bg: '#FFF1A8', ink: '#4A3F14', line: 'rgba(74,63,20,.16)' },
  { id: 'pink',   name: '粉', bg: '#FFD6E0', ink: '#4A2430', line: 'rgba(74,36,48,.16)' },
  { id: 'blue',   name: '蓝', bg: '#CCE5FA', ink: '#1D3A50', line: 'rgba(29,58,80,.16)' },
  { id: 'green',  name: '绿', bg: '#C9EAD3', ink: '#1E3D2A', line: 'rgba(30,61,42,.16)' },
  { id: 'purple', name: '紫', bg: '#E0D7F7', ink: '#302348', line: 'rgba(48,35,72,.16)' },
  { id: 'orange', name: '橙', bg: '#FFDFBE', ink: '#4A2E10', line: 'rgba(74,46,16,.16)' },
];

export function noteColor(id) {
  return NOTE_COLORS.find(c => c.id === id) || NOTE_COLORS[0];
}

export function blankNote() {
  const at = Date.now();
  return {
    id: 'n' + at.toString(36) + Math.random().toString(36).slice(2, 6),
    text: '',
    color: 'yellow',
    pinned: false,
    createdAt: at,
    updatedAt: at,
  };
}

export async function allNotes() {
  const list = await idbAll('notes');
  /* 置顶的排前面，其余按最近改的排 */
  return list.sort((a, b) => {
    if (!!a.pinned !== !!b.pinned) return a.pinned ? -1 : 1;
    return (b.updatedAt || 0) - (a.updatedAt || 0);
  });
}

export async function putNote(note) {
  note.updatedAt = Date.now();
  await idbPut('notes', note);
  return note;
}

export async function deleteNote(id) {
  return idbDel('notes', id);
}
