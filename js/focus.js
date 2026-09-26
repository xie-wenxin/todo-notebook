/* ═══════════════════════════════════════════════════════════
   focus.js — 专注会话引擎

   设计要点（这些决定了「诚实记录」能不能成立）：

   1. 计时靠时间戳，不靠 tick 累加。
      页面被 iOS 冻结、切后台、甚至被系统回收，时间戳都不会错。
      普通番茄钟靠 setInterval 累加，息屏就停了 —— 那个数字是假的。

   2. 息屏/切走**不停表**，只记一段「离开区间」。
      你要的是：查个题、回个微信不用被打断。所以不停表。
      但账要记清楚：离开一次记一次，回来记一次。

   3. 有效专注 = 总时长。**点了开始就一直算。**
      锁屏、切走、换软件、页面被 iOS 回收，一律不扣，全都算数。
      unknownMs 会照实记录，但从不参与计算。

   4. 严格模式：一离开就作废整个会话。适合考前冲刺，能骗自己都骗不了。

   5. 页面被系统杀掉时无法得知中间发生了什么，那一段记成 unknownMs。
      诚实标注，但**照样算进时长** —— 宁可多算，不可少算。

   这个文件不碰 DOM，也不碰数据库，所以能在 Node 里直接单测。
   ═══════════════════════════════════════════════════════════ */

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
    marks: [],         // [{ kind, from, to }] 息屏 / 查题 / 倒计时 的标记段
    note: '',          // 结束时强制写的那一句总结
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
  closeAllMarks(s, at);
  s.endedAt = at;
  return s;
}

/** 页面被系统回收后重开，把无从得知的那段记下来 */
export function addUnknown(s, ms) {
  if (ms > 0) s.unknownMs += ms;
  return s;
}

/* ── 标记段（息屏 / 查题 / 倒计时） ─────────────────────
   这些**不影响时长计算** —— 按你的要求，全都算作专注。
   它们只是在时间线上涂个颜色，让你回看时知道那会儿在干嘛。
   ─────────────────────────────────────────────────────── */

export const MARK_KINDS = ['screenoff', 'lookup', 'countdown'];

/** 这一段是不是开着 */
export function markOpen(s, kind) {
  return (s.marks || []).some(m => m.kind === kind && m.to === null);
}

/** 开一段标记。同一种标记如果已经开着，先关掉。 */
export function startMark(s, kind, at) {
  if (s.endedAt) return s;
  if (!Array.isArray(s.marks)) s.marks = [];
  const open = s.marks.find(m => m.kind === kind && m.to === null);
  if (open) open.to = Math.max(at, open.from);
  s.marks.push({ kind, from: at, to: null });
  return s;
}

/** 关掉某一种标记 */
export function stopMark(s, kind, at) {
  if (!Array.isArray(s.marks)) return s;
  for (const m of s.marks) {
    if (m.kind === kind && m.to === null) m.to = Math.max(at, m.from);
  }
  return s;
}

/** 切换：开着就关，关着就开。返回切换后的状态 */
export function toggleMark(s, kind, at) {
  if (markOpen(s, kind)) { stopMark(s, kind, at); return false; }
  startMark(s, kind, at);
  return true;
}

/** 把还开着的标记都收尾（结束时用） */
export function closeAllMarks(s, at) {
  if (!Array.isArray(s.marks)) return s;
  for (const m of s.marks) {
    if (m.to === null) m.to = Math.max(at, m.from);
  }
  return s;
}

/* ── 页面被杀掉之后重开 ────────────────────────────────────
   这段逻辑太容易出错（丢时间就丢在这儿），所以从 focus-ui.js 抽出来
   做成纯函数，这样能在 Node 里直接测。
   ─────────────────────────────────────────────────────── */

/** 一个计时器最多能跨这么久，超过就当成「忘关了」 */
export const RESUME_MAX_MS = 12 * 3600 * 1000;

/**
 * 页面被 iOS 杀掉之后重开，这个会话该怎么办？
 *
 * @param {object} s
 * @param {number} now
 * @param {string|null} today  今天的日期键，用来判断跨天
 * @returns {{resume:boolean, stopAt?:number, away?:boolean, gapMs?:number}}
 */
export function resumePlan(s, { now = Date.now(), today = null } = {}) {
  const sameDay = today ? s.date === today : true;
  const fresh = now - s.startedAt < RESUME_MAX_MS;

  if (!sameDay || !fresh) {
    /* 跨天了，或者一个计时器挂了大半天 —— 不再接着算。
       结束在「最后一次还活着」的时刻，免得忘关的计时器把时长灌成假的。
       注意 lastTick 最多只会比真实停下的时刻晚 20 秒（每 20 秒存一次盘），
       所以这么收尾几乎不丢时间。 */
    return {
      resume: false,
      stopAt: Math.max(s.lastTick || s.startedAt, s.startedAt),
    };
  }

  const away = isAway(s);
  return {
    resume: true,
    away,
    /* 没记到「离开」就失联的那一段，照实记成 unknownMs 备查。
       只是记下来 —— 不扣时长。 */
    gapMs: away ? 0 : Math.max(0, now - (s.lastTick || s.startedAt)),
  };
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
  let awayCount = 0;

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

    cursor = Math.max(cursor, to);
  }

  if (cursor < end) {
    segments.push({ kind: 'focus', from: cursor, to: end, ms: end - cursor });
  }

  /* 标记段：息屏 / 查题 / 倒计时。
     它们**不扣时长** —— 按你的要求全都算专注，只是给时间线上个色。 */
  const marks = (s.marks || [])
    .map(m => ({ kind: m.kind, from: m.from, to: m.to ?? end }))
    .filter(m => m.to > m.from)
    .map(m => ({ ...m, ms: m.to - m.from }))
    .sort((a, b) => a.from - b.from);

  const markMs = {};
  for (const m of marks) markMs[m.kind] = (markMs[m.kind] || 0) + m.ms;

  /* 定了：**只要点了开始，时间就全算上**。
     离开不扣、息屏不扣、换软件不扣，「页面被系统杀掉、无从得知」的那段
     也不扣。以前这里扣一个 unknownMs，后果就是：你锁屏学习 90 分钟，
     iOS 把页面回收，回来重开时那 90 分钟被当成「未知」扣光 ——
     看着就像根本没计过时。unknownMs 仍然照实记下来备查，
     但**不再参与算命**。 */
  const effectiveMs = totalMs;

  return {
    totalMs,
    awayMs,
    unknownMs: s.unknownMs,
    effectiveMs,
    awayCount,
    marks,
    markMs,
    note: s.note || '',
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
 * 日期键 'YYYY-MM-DD' → 那天 23:59:59.999 的时间戳。
 * 认不出来就给 Infinity（测试里用的是 'D' 这种假日期）。
 */
function endOfDayMs(dateKey) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateKey || ''));
  if (!m) return Infinity;
  return new Date(+m[1], +m[2] - 1, +m[3], 23, 59, 59, 999).getTime();
}

/**
 * 一天里所有会话加起来的真实专注时长。
 *
 * ⚠️ 这里踩过一个很贵的坑，写下来别再犯：
 *
 *   一开始是「把每条会话的 focus 段挑出来相加」。看着合理，其实是错的 ——
 *   `segments` 里的 focus 段是**离开段之间**的缝隙。你锁屏学习的时候，
 *   离开段把整条会话都吃掉了，focus 段只剩开头那几秒：
 *
 *       8:00 开始 → 8:00:05 锁屏 → 9:30 回来 → 停止
 *       单条会话：有效 1h30m ✅
 *       整天汇总：有效 0h00m ❌   ← 底部那行、时间轴、扇形图全读这个
 *
 *   所以改成：**整条会话的时间跨度都算**，只有「页面被系统杀掉、无从得知」
 *   的那段扣掉。锁屏、切走、查题一律算数 —— 这是你要的规则。
 *
 *   跨度先合并去重再求和，免得两条会话时间重叠时把时长算虚。
 */
export function dayFocus(sessions, { now = Date.now() } = {}) {
  const valid = sessions.filter(s => !s.interrupted);

  const spans = [];
  let totalMs = 0;
  let awayCount = 0;
  let awayMs = 0;
  let unknownMs = 0;

  for (const s of valid) {
    const r = summarize(s, now);
    totalMs += r.totalMs;
    awayCount += r.awayCount;
    awayMs += r.awayMs;
    unknownMs += r.unknownMs;

    const end = s.endedAt ?? now;
    /* 还在跑的会话算到此刻，但**不许越出它自己那一天**。
       万一有个僵尸会话跨了好几天还没被收掉（resume 出过错才会发生），
       不设这个上界的话它会把整天撑成几十个小时。 */
    const stop = Math.min(end, endOfDayMs(s.date));
    if (stop > s.startedAt) spans.push({ from: s.startedAt, to: stop });
  }

  const merged = mergeIntervals(spans);
  const spanMs = merged.reduce((sum, iv) => sum + (iv.to - iv.from), 0);
  /* 同 summarize：一分不扣。unknownMs 只记不用。 */
  const effectiveMs = spanMs;

  return {
    effectiveMs,
    spanMs,
    totalMs,
    awayMs,
    unknownMs,
    awayCount,
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

/** 「时+分」，比如 1h31m。适合一整天的量。 */
export function fmtMs(ms) {
  const t = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  return `${h}h${String(m).padStart(2, '0')}m`;
}

/**
 * **给人看的时长** —— 屏幕上一律用这个，别直接用 fmtMs。
 *
 * 为什么非要有这么一个函数：
 *   fmtMs(13 秒) 返回 "0h00m"。计时器上明明走着 00:00:13，
 *   总结页却写 0h00m —— 看着就是「根本没记上」。
 *   这个坑踩过两次（一次在底部那行，一次在扇形图），
 *   所以干脆统一成一个函数，所有地方都走它。
 */
export function fmtDur(ms) {
  const t = Math.max(0, Math.round(ms / 1000));
  if (t <= 0) return '0h00m';      // 一点都没有，保持老样子
  if (t < 60) return `${t}s`;      // 不满一分钟，直接报秒
  if (t < 3600) return `${Math.floor(t / 60)}m`;   // 不满一小时，报分
  return fmtMs(ms);
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
    marks: Array.isArray(o.marks)
      ? o.marks.map(m => ({ kind: m.kind, from: m.from, to: m.to ?? null }))
      : [],
    note: o.note || '',
    unknownMs: Number(o.unknownMs) || 0,
    strict: !!o.strict,
    interrupted: !!o.interrupted,
  };
}
