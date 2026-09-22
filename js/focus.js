/* ═══════════════════════════════════════════════════════════
   focus.js — 专注会话引擎

   设计要点（这些决定了「诚实记录」能不能成立）：

   1. 计时靠时间戳，不靠 tick 累加。
      页面被 iOS 冻结、切后台、甚至被系统回收，时间戳都不会错。
      普通番茄钟靠 setInterval 累加，息屏就停了 —— 那个数字是假的。

   2. 息屏/切走**不停表**，只记一段「离开区间」。
      你要的是：查个题、回个微信不用被打断。所以不停表。
      但账要记清楚：离开一次记一次，回来记一次。

   3. 有效专注 = 总时长 − 长离开 − 未知时长
      短离开（< 2 分钟）不计入扣减 —— 查题、上厕所、倒水都算正常范围。

   4. 严格模式：一离开就作废整个会话。适合考前冲刺，能骗自己都骗不了。

   5. 页面被系统杀掉时无法得知中间发生了什么，那一段记成 unknownMs，
      诚实标注，不假装。

   这个文件不碰 DOM，也不碰数据库，所以能在 Node 里直接单测。
   ═══════════════════════════════════════════════════════════ */

/** 单次离开短于这个时长，不扣有效专注 */
export const GRACE_MS = 2 * 60 * 1000;

/* ── 建会话 ────────────────────────────────────────────── */

let _seq = 0;
export function newSessionId(at = Date.now()) {
  _seq = (_seq + 1) % 100000;
  return 's' + at.toString(36) + _seq.toString(36);
}

export function createSession({
  id, date, blockId = null, todoId = null, label = '',
  startedAt, strict = false,
}) {
  return {
    id: id || newSessionId(startedAt),
    date,
    blockId,
    todoId,
    label,
    startedAt,
    endedAt: null,
    away: [],          // [{ from, to }]，to === null 表示此刻还在离开中
    unknownMs: 0,      // 页面被系统回收后无法得知的那段
    strict: !!strict,
    interrupted: false,
  };
}

/* ── 离开 / 回来 ───────────────────────────────────────── */

export function isAway(s) {
  return s.away.some(a => a.to === null);
}

export function isRunning(s) {
  return !s.endedAt;
}

/** 页面切走 / 息屏 */
export function markAway(s, at) {
  if (s.endedAt) return s;

  if (s.strict) {
    /* 严格模式：离开即作废 */
    s.interrupted = true;
    s.endedAt = at;
    return s;
  }

  if (isAway(s)) return s;        // 已经在离开状态了，别重复记
  s.away.push({ from: at, to: null });
  return s;
}

/** 回到前台 */
export function markBack(s, at) {
  if (s.endedAt) return s;
  const open = s.away.find(a => a.to === null);
  if (open) open.to = Math.max(at, open.from);
  return s;
}

/** 主动结束 */
export function endSession(s, at) {
  if (s.endedAt) return s;
  const open = s.away.find(a => a.to === null);
  if (open) open.to = Math.max(at, open.from);
  s.endedAt = at;
  return s;
}

/** 页面被系统回收后重开，把无从得知的那段记下来 */
export function addUnknown(s, ms) {
  if (ms > 0) s.unknownMs += ms;
  return s;
}

/* ── 结算 ──────────────────────────────────────────────── */

/**
 * 把这个会话算清楚。
 * @param {object} s   会话
 * @param {number} now 当前时间（运行中的会话用它当结束点）
 */
export function summarize(s, now = Date.now()) {
  const end = s.endedAt ?? now;
  const totalMs = Math.max(0, end - s.startedAt);

  const away = s.away
    .map(a => ({ from: a.from, to: a.to ?? end }))
    .filter(a => a.to > a.from)
    .sort((a, b) => a.from - b.from);

  const segments = [];
  let cursor = s.startedAt;
  let awayMs = 0;
  let deductedMs = 0;
  let awayCount = 0;
  let longAwayCount = 0;

  for (const raw of away) {
    const from = Math.max(raw.from, s.startedAt);
    const to = Math.min(raw.to, end);
    if (to <= from) continue;

    if (from > cursor) {
      segments.push({ kind: 'focus', from: cursor, to: from, ms: from - cursor });
    }

    const ms = to - from;
    segments.push({ kind: 'away', from, to, ms });

    awayMs += ms;
    awayCount++;
    if (ms >= GRACE_MS) { deductedMs += ms; longAwayCount++; }

    cursor = Math.max(cursor, to);
  }

  if (cursor < end) {
    segments.push({ kind: 'focus', from: cursor, to: end, ms: end - cursor });
  }

  const effectiveMs = Math.max(0, totalMs - deductedMs - s.unknownMs);

  return {
    totalMs,
    awayMs,
    deductedMs,
    unknownMs: s.unknownMs,
    effectiveMs,
    awayCount,
    longAwayCount,
    ratio: totalMs > 0 ? effectiveMs / totalMs : 0,
    segments,
    interrupted: !!s.interrupted,
    running: !s.endedAt,
    startedAt: s.startedAt,
    endedAt: s.endedAt,
  };
}

/* ── 汇总一天 ──────────────────────────────────────────── */

function mergeIntervals(list) {
  const sorted = [...list].sort((a, b) => a.from - b.from);
  const out = [];
  for (const iv of sorted) {
    const last = out[out.length - 1];
    if (last && iv.from <= last.to) last.to = Math.max(last.to, iv.to);
    else out.push({ from: iv.from, to: iv.to });
  }
  return out;
}

/**
 * 一天里所有会话加起来的真实专注时长。
 *
 * 关键：先把各会话的「专注段」拿出来合并去重，再求和。
 * 直接相加的话，万一两条会话时间有重叠（手抖、多标签页），
 * 时长就被重复计算了，那个数字就是虚的。
 */
export function dayFocus(sessions, { now = Date.now() } = {}) {
  const valid = sessions.filter(s => !s.interrupted);

  const focusIvs = [];
  let totalMs = 0;
  let awayCount = 0;
  let longAwayCount = 0;
  let awayMs = 0;

  for (const s of valid) {
    const r = summarize(s, now);
    totalMs += r.totalMs;
    awayCount += r.awayCount;
    longAwayCount += r.longAwayCount;
    awayMs += r.awayMs;
    for (const seg of r.segments) {
      if (seg.kind === 'focus') focusIvs.push({ from: seg.from, to: seg.to });
    }
  }

  const merged = mergeIntervals(focusIvs);
  const effectiveMs = merged.reduce((sum, iv) => sum + (iv.to - iv.from), 0);

  return {
    effectiveMs,
    totalMs,
    awayMs,
    awayCount,
    longAwayCount,
    intervalCount: merged.length,
    sessionCount: valid.length,
    interruptedCount: sessions.length - valid.length,
    segments: merged.map(iv => ({ kind: 'focus', from: iv.from, to: iv.to, ms: iv.to - iv.from })),
  };
}

/* ── 归到某个时间块上 ──────────────────────────────────── */

/** 按块汇总，给第 3 步的扇形图用 */
export function byBlock(sessions, { now = Date.now() } = {}) {
  const map = new Map();
  for (const s of sessions) {
    const key = s.blockId || '__none__';
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(s);
  }
  const out = {};
  for (const [k, list] of map) out[k] = dayFocus(list, { now });
  return out;
}

/* ── 小工具 ────────────────────────────────────────────── */

export function fmtMs(ms) {
  const t = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  return `${h}h${String(m).padStart(2, '0')}m`;
}

export function pct(ratio) {
  return Math.round(Math.max(0, Math.min(1, ratio)) * 100) + '%';
}

/* ── 存盘用：保证是能结构化克隆的纯对象 ────────────────── */

export function toRecord(s) {
  return JSON.parse(JSON.stringify(s));
}

export function fromRecord(o) {
  return {
    ...createSession({ id: o.id, date: o.date, startedAt: o.startedAt }),
    ...o,
    away: Array.isArray(o.away) ? o.away.map(a => ({ from: a.from, to: a.to ?? null })) : [],
    unknownMs: Number(o.unknownMs) || 0,
    strict: !!o.strict,
    interrupted: !!o.interrupted,
  };
}
