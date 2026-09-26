/* ═══════════════════════════════════════════════════════════
   test-focus.mjs — 专注引擎的单元测试
   纯逻辑，不开浏览器，跑得飞快。用法：node tools/test-focus.mjs
   ═══════════════════════════════════════════════════════════ */

import {
  createSession, markAway, markBack, endSession, addUnknown, summarize,
  dayFocus, byBlock, toRecord, fromRecord, fmtMs, fmtDur, pct,
  resumePlan, RESUME_MAX_MS,
} from '../js/focus.js';

/* ── 迷你断言 ──────────────────────────────────────────── */

let pass = 0, fail = 0;
const fails = [];

function ok(name, cond, detail = '') {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else {
    fail++;
    fails.push(name + (detail ? '  → ' + detail : ''));
    console.log('  FAIL  ' + name + (detail ? '  → ' + detail : ''));
  }
}

function eq(name, got, want) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  ok(name, g === w, `得到 ${g}，期望 ${w}`);
}

const M = 60 * 1000;             // 一分钟
const H = 60 * M;                // 一小时
const T0 = 1_700_000_000_000;    // 固定起点，测试结果不随时间变

/* ── 1. 干干净净的会话 ─────────────────────────────────── */

console.log('\n  ── 基本：没有离开 ──');
{
  const s = createSession({ date: 'D', blockId: 'b2', startedAt: T0 });
  endSession(s, T0 + 4 * H);
  const r = summarize(s, T0 + 9 * H);

  eq('总时长 4 小时', r.totalMs, 4 * H);
  eq('有效 = 总时长', r.effectiveMs, 4 * H);
  eq('离开 0 次', r.awayCount, 0);
  eq('比例 100%', pct(r.ratio), '100%');
  eq('已经结束了', r.running, false);
}

/* ── 2. 离开一律不扣（这是定死的规矩） ─────────────────
   查个题、回个微信、锁屏学习 —— 全都算数。
   只有「页面被系统杀掉、无从得知」的那段才扣。
   ─────────────────────────────────────────────────────── */

console.log('\n  ── 离开不扣时长 ──');
{
  const s = createSession({ startedAt: T0 });
  markAway(s, T0 + 60 * M);
  markBack(s, T0 + 61 * M);            // 离开 1 分钟
  endSession(s, T0 + 120 * M);
  const r = summarize(s);

  eq('离开次数记了 1 次', r.awayCount, 1);
  eq('离开的时长照样记在案', r.awayMs, 1 * M);
  eq('有效 = 总时长 120 分钟', r.effectiveMs, 120 * M);
}
{
  const s = createSession({ startedAt: T0 });
  markAway(s, T0 + 30 * M);
  markBack(s, T0 + 35 * M);            // 离开 5 分钟
  endSession(s, T0 + 60 * M);
  const r = summarize(s);

  eq('离开 5 分钟也一分不扣', r.effectiveMs, 60 * M);
  eq('离开时长仍然记录在案', r.awayMs, 5 * M);
  eq('比例仍然是 100%', pct(r.ratio), '100%');
}
{
  /* 各种长度都一样：1 秒、2 分钟、3 小时 —— 一分不扣 */
  for (const left of [1000, 2 * M, 3 * H]) {
    const s = createSession({ startedAt: T0 });
    endSession(markBack(markAway(s, T0), T0 + left), T0 + 3 * H);
    eq(`离开 ${fmtMs(left)}：照记不扣`, summarize(s).effectiveMs, 3 * H);
  }
}

/* ── 3. 还没回来就结算 ─────────────────────────────────── */

console.log('\n  ── 还在离开中 ──');
{
  const s = createSession({ startedAt: T0 });
  markAway(s, T0 + 10 * M);
  const r = summarize(s, T0 + 20 * M);   // 到 now 为止还在离开

  eq('总时长算到 now：20 分钟', r.totalMs, 20 * M);
  eq('离开算到 now：10 分钟', r.awayMs, 10 * M);
  eq('还在跑', r.running, true);
  eq('有效跟着总时长走：20 分钟', r.effectiveMs, 20 * M);
}

/* ── 4. 严格模式 ───────────────────────────────────────── */

console.log('\n  ── 严格模式 ──');
{
  const s = createSession({ startedAt: T0, strict: true });
  markAway(s, T0 + 5 * M);
  const r = summarize(s, T0 + 30 * M);

  eq('一离开就作废', r.interrupted, true);
  eq('结束时间 = 离开那一刻', s.endedAt, T0 + 5 * M);
  eq('有效就是那 5 分钟', r.effectiveMs, 5 * M);
  eq('之后不会再加时长', summarize(s, T0 + 90 * M).totalMs, 5 * M);
}

/* ── 5. 页面被系统杀掉 ─────────────────────────────────── */

console.log('\n  ── 未知时长 ──');
{
  const s = createSession({ startedAt: T0 });
  addUnknown(s, 12 * M);
  endSession(s, T0 + 60 * M);
  const r = summarize(s);

  eq('未知时长单独记着，备查', r.unknownMs, 12 * M);
  eq('但照样算进时长：整整 60 分钟', r.effectiveMs, 60 * M);
  eq('不因为「不知道」就少算', pct(r.ratio), '100%');
}

/* ── 6. 时间线要无缝拼满 ───────────────────────────────── */

console.log('\n  ── 时间线 ──');
{
  const s = createSession({ startedAt: T0 });
  markAway(s, T0 + 10 * M); markBack(s, T0 + 11 * M);
  markAway(s, T0 + 30 * M); markBack(s, T0 + 40 * M);
  endSession(s, T0 + 60 * M);
  const r = summarize(s);

  const sum = r.segments.reduce((a, b) => a + b.ms, 0);
  eq('各段加起来正好等于总时长', sum, r.totalMs);
  eq('起点对齐会话开始', r.segments[0].from, T0);
  eq('终点对齐会话结束', r.segments[r.segments.length - 1].to, T0 + 60 * M);

  let gap = 0;
  for (let i = 1; i < r.segments.length; i++) {
    gap += r.segments[i].from - r.segments[i - 1].to;
  }
  eq('段与段之间没有空隙', gap, 0);

  eq('段顺序是 专注-离开-专注-离开-专注',
    r.segments.map(x => x.kind).join(','),
    'focus,away,focus,away,focus');
  eq('离开的 10 分钟不扣，有效仍是 60 分钟', r.effectiveMs, 60 * M);
  eq('离开段单独标了出来', r.segments.filter(x => x.kind === 'away').length, 2);
}

/* ── 7. 重复操作要幂等 ─────────────────────────────────── */

console.log('\n  ── 幂等 ──');
{
  const s = createSession({ startedAt: T0 });
  markAway(s, T0 + 5 * M);
  markAway(s, T0 + 6 * M);              // 重复标记离开
  eq('重复标记离开只记一条', s.away.length, 1);

  markBack(s, T0 + 9 * M);
  markBack(s, T0 + 12 * M);             // 重复标记回来
  eq('重复标记回来不会改掉回来的时间', s.away[0].to, T0 + 9 * M);

  endSession(s, T0 + 30 * M);
  endSession(s, T0 + 50 * M);           // 重复结束
  eq('重复结束不会改掉结束时间', s.endedAt, T0 + 30 * M);

  markAway(s, T0 + 40 * M);             // 结束之后再标记离开
  eq('结束之后不再接受离开', s.away.length, 1);
}

/* ── 8. 一天的汇总不能重复计时 ─────────────────────────── */

console.log('\n  ── 一天的汇总 ──');
{
  const a = createSession({ id: 'a', date: 'D', blockId: 'b2', startedAt: T0 });
  endSession(a, T0 + 60 * M);

  const b = createSession({ id: 'b', date: 'D', blockId: 'b2', startedAt: T0 + 30 * M });
  endSession(b, T0 + 90 * M);

  const df = dayFocus([a, b]);
  eq('两条重叠的会话，合并后是 90 分钟（不是 120）', df.effectiveMs, 90 * M);
  eq('原始总时长仍是 120 分钟', df.totalMs, 120 * M);
  eq('合并成 1 段', df.intervalCount, 1);
}
{
  const a = createSession({ id: 'a', date: 'D', startedAt: T0 });
  endSession(a, T0 + 60 * M);

  const c = createSession({ id: 'c', date: 'D', startedAt: T0 + 2 * H, strict: true });
  markAway(c, T0 + 2 * H + 20 * M);     // 严格模式，作废

  const df = dayFocus([a, c]);
  eq('作废的会话不计入时长', df.effectiveMs, 60 * M);
  eq('作废的会话不计入条数', df.sessionCount, 1);
  eq('作废条数单独统计', df.interruptedCount, 1);
}
{
  const a = createSession({ id: 'a', date: 'D', blockId: 'b2', startedAt: T0 });
  endSession(a, T0 + 60 * M);
  const b = createSession({ id: 'b', date: 'D', blockId: 'b4', startedAt: T0 + 90 * M });
  endSession(b, T0 + 150 * M);

  const bb = byBlock([a, b]);
  eq('b2 块 60 分钟', bb.b2.effectiveMs, 60 * M);
  eq('b4 块 60 分钟', bb.b4.effectiveMs, 60 * M);
}

/* ── 8b. 锁屏学习 —— 踩过的坑，必须守住 ─────────────────
   出事时的样子：8:00 点开始 → 5 秒后手机锁屏 → 9:30 回来 → 点停止。
   单条会话算出来 90 分钟是对的，但「底部那行 / 左边时间轴 / 扇形图」
   全都读 dayFocus()，而它当时只累加「专注段」，把锁屏那一大段扔了，
   算出来整整 0 分钟 —— 看着就像「计时记不上」。
   ─────────────────────────────────────────────────────── */

console.log('\n  ── 锁屏学习：待在后台也算时间 ──');
{
  const s = createSession({ id: 'n1', date: 'D', blockId: 'b2', startedAt: T0 });
  markAway(s, T0 + 5000);              // 点了开始，5 秒后锁屏
  markBack(s, T0 + 90 * M);            // 学习结束才回来
  endSession(s, T0 + 90 * M + 1000);

  const one = summarize(s).effectiveMs;
  eq('单条会话：90 分钟', one, 90 * M + 1000);

  const df = dayFocus([s]);
  eq('整天汇总也必须是 90 分钟，不能变 0', df.effectiveMs, 90 * M + 1000);

  const span = df.segments[0].to - df.segments[0].from;
  eq('时间轴拿到完整的一整段', span, 90 * M + 1000);
  eq('时间轴就一段，没被锁屏切断', df.segments.length, 1);

  eq('扇形图那一块也要有 90 分钟', byBlock([s]).b2.effectiveMs, 90 * M + 1000);
}
{
  /* 手机被系统回收，中间那段无从得知 —— 记下来，但照样算 */
  const s = createSession({ id: 'n2', date: 'D', blockId: 'b2', startedAt: T0 });
  addUnknown(s, 10 * M);
  markAway(s, T0 + 20 * M);
  markBack(s, T0 + 50 * M);
  endSession(s, T0 + 60 * M);

  eq('未知的 10 分钟也照算，整整 60 分钟', dayFocus([s]).effectiveMs, 60 * M);
}
{
  /* 还在跑的会话也得算进去，不然边学边看数字永远是 0 */
  const s = createSession({ id: 'n3', date: 'D', blockId: 'b4', startedAt: T0 });
  markAway(s, T0 + 1000);
  eq('还在跑的会话把时间算到此刻', dayFocus([s], { now: T0 + 45 * M }).effectiveMs, 45 * M);
}
{
  /* 僵尸会话：好几天前开的、一直没被收掉。不许越出它自己那一天。 */
  const start = new Date(2026, 8, 22, 9, 0, 0).getTime();     /* 9/22 09:00 */
  const s = createSession({ id: 'z1', date: '2026-09-22', blockId: 'b2', startedAt: start });
  const now = new Date(2026, 8, 24, 15, 0, 0).getTime();      /* 两天后 */

  const df = dayFocus([s], { now });
  eq('僵尸会话封顶在它那天的 23:59',
    df.effectiveMs, new Date(2026, 8, 22, 23, 59, 59, 999).getTime() - start);
  ok('不会涨成几十个小时', df.effectiveMs < 16 * H);
}

/* ── 9. 手机上的真实流程 —— 一条都不许丢时间 ─────────────
   这是这个 App 存在的全部意义。下面的每一条都对应一种「用户觉得
   自己明明在学，App 却没记上」的真实场景。全部必须 PASS。
   ─────────────────────────────────────────────────────── */

/** 模拟「页面被 iOS 杀掉，过一会儿重开」——就是 app.js 开机跑的那套 */
function killAndReopen(s, now, today) {
  const plan = resumePlan(s, { now, today });
  if (!plan.resume) { endSession(s, plan.stopAt); return false; }
  if (plan.away) markBack(s, now);
  else if (plan.gapMs > 5000) addUnknown(s, plan.gapMs);
  s.lastTick = now;
  return true;
}

console.log('\n  ── 手机上的真实流程 ──');

/* ① 换软件：切走 29 分钟又切回来 */
{
  const s = createSession({ id: 'p1', date: 'D', blockId: 'b2', startedAt: T0 });
  markAway(s, T0 + 1 * M);
  markBack(s, T0 + 30 * M);
  endSession(s, T0 + 45 * M);
  eq('① 换软件 29 分钟：全算，共 45 分钟', dayFocus([s]).effectiveMs, 45 * M);
}

/* ② 黑屏：iOS 触发了 visibilitychange，然后页面被回收，90 分钟后重开 */
{
  const s = createSession({ id: 'p2', date: 'D', blockId: 'b2', startedAt: T0 });
  markAway(s, T0 + 1 * M);
  s.lastTick = T0 + 1 * M;
  killAndReopen(s, T0 + 90 * M, 'D');
  endSession(s, T0 + 91 * M);
  eq('② 黑屏被回收后重开：全算，共 91 分钟', dayFocus([s]).effectiveMs, 91 * M);
}

/* ③ 黑屏：iOS **没**触发 visibilitychange，页面还被回收了。
      这条就是之前把时间吃光的元凶 —— 失联的那段被当成「未知」扣掉了。 */
{
  const s = createSession({ id: 'p3', date: 'D', blockId: 'b2', startedAt: T0 });
  s.lastTick = T0 + 1 * M;             // 只来得及存了一次盘就没了
  const resumed = killAndReopen(s, T0 + 90 * M, 'D');
  endSession(s, T0 + 91 * M);

  ok('③ 没触发 visibilitychange 也能接着算', resumed === true);
  ok('③ 失联那段照实记成 unknownMs', s.unknownMs > 0);
  eq('③ 但一分钱都不扣：91 分钟', dayFocus([s]).effectiveMs, 91 * M);
}

/* ④ 开始之后立刻黑屏，中间一直没回来，最后点停止 */
{
  const s = createSession({ id: 'p4', date: 'D', blockId: 'b4', startedAt: T0 });
  markAway(s, T0 + 3000);              // 3 秒后就黑屏了
  endSession(s, T0 + 3 * H);           // 3 小时后直接点停止
  eq('④ 一路黑屏 3 小时：全算', dayFocus([s]).effectiveMs, 3 * H);
  eq('④ 时间轴也是一整段', dayFocus([s]).segments.length, 1);
}

/* ⑤ 页面被回收，重开后一直没点停止，第二天才想起来 */
{
  const s = createSession({ id: 'p5', date: 'D', blockId: 'b2', startedAt: T0 });
  markAway(s, T0 + 30 * 1000);
  s.lastTick = T0 + 30 * 1000;
  const resumed = killAndReopen(s, T0 + 20 * H, 'D2');

  ok('⑤ 跨天的会话不再接着算（免得灌成假的）', resumed === false);
  eq('⑤ 但已经记下的那 30 秒保住', summarize(s).effectiveMs, 30 * 1000);
}

/* ⑥ 忘关的计时器，同一天内想起来 */
{
  const s = createSession({ id: 'p6', date: 'D', blockId: 'b2', startedAt: T0 });
  s.lastTick = T0;
  killAndReopen(s, T0 + 5 * H, 'D');
  endSession(s, T0 + 5 * H);
  eq('⑥ 同一天内忘关：按你说的，还是算上', dayFocus([s]).effectiveMs, 5 * H);
  ok('⑥ 12 小时是这个宽容度的上限', RESUME_MAX_MS === 12 * 3600 * 1000);
}

/* ⑦ 一整天的连续学习：中间锁屏好几次，加起来不能少一分钟 */
{
  const list = [];
  for (let i = 0; i < 3; i++) {
    const s = createSession({ id: 'q' + i, date: 'D', blockId: 'b2', startedAt: T0 + i * 3 * H });
    markAway(s, T0 + i * 3 * H + 2 * M);          // 学两分钟就锁屏
    addUnknown(s, 3 * M);                          // 中间还被回收了一次
    endSession(s, T0 + (i + 1) * 3 * H);
    list.push(s);
  }
  const df = dayFocus(list);
  eq('⑦ 三段各 3 小时，合计 9 小时，一分钟不少', df.effectiveMs, 9 * H);
  eq('⑦ 首尾相接的三段并成一条连续的时间轴', df.segments.length, 1);
  eq('⑦ 并起来还是 9 小时', df.segments[0].to - df.segments[0].from, 9 * H);
}
{
  /* 中间有休息的，时间轴上就该看出是三段 */
  const list = [];
  for (let i = 0; i < 3; i++) {
    const s = createSession({ id: 'r' + i, date: 'D', blockId: 'b2', startedAt: T0 + i * 4 * H });
    markAway(s, T0 + i * 4 * H + 2 * M);
    endSession(s, T0 + i * 4 * H + 3 * H);
    list.push(s);
  }
  const df = dayFocus(list);
  eq('⑦ 中间有休息：时间轴上是三段', df.segments.length, 3);
  eq('⑦ 合计仍是 9 小时', df.effectiveMs, 9 * H);
}

/* ── 10. 「计时器上多少，显示的就得是多少」 ─────────────
   这是用户亲口定的规矩，也是出过两次的毛病：
     · 底部那行  —— 曾经 13 秒显示成 0h00m
     · 扇形图    —— 同样的问题，漏改了
   屏幕上一律走 fmtDur()，这条测试把它钉死。
   ─────────────────────────────────────────────────────── */

console.log('\n  ── 计时器上多少，显示的就得是多少 ──');
{
  const cases = [1, 13, 59, 61, 90, 600, 3599, 3600, 5400, 7200];
  const bad = [];
  for (const secs of cases) {
    const ms = secs * 1000;
    const s = createSession({ id: 'd' + secs, date: 'D', blockId: 'b2', startedAt: T0 });
    endSession(s, T0 + ms);

    const got = dayFocus([s]).effectiveMs;
    const txt = fmtDur(got);

    if (got !== ms) bad.push(`${secs}s：算出来 ${got}ms，该是 ${ms}ms`);
    if (!/[1-9]/.test(txt)) bad.push(`${secs}s：显示成了 "${txt}"`);
  }
  ok('从 1 秒到 2 小时，时长和显示全都对得上', bad.length === 0, bad.join('；'));

  eq('不满 1 分钟直接报秒', fmtDur(13000), '13s');
  eq('59 秒也是秒', fmtDur(59000), '59s');
  eq('正好 1 分钟', fmtDur(60000), '1m');
  eq('不满 1 小时报分', fmtDur(23 * 60000), '23m');
  eq('1 小时 30 分', fmtDur(90 * 60000), '1h30m');
  eq('一点都没有的时候仍然是 0h00m', fmtDur(0), '0h00m');
  eq('负数当零', fmtDur(-5000), '0h00m');
  ok('不会出现「有时长却全是 0」',
    fmtDur(1000) !== '0h00m' && fmtDur(30000) !== '0h00m' && fmtDur(59000) !== '0h00m');
  {
    /* 扫一遍：1 秒到 2 小时，只要真有时间，显示的就得有非零数字 */
    const zeros = [];
    for (let secs = 1; secs <= 7200; secs += (secs < 130 ? 1 : 137)) {
      const txt = fmtDur(secs * 1000);
      if (!/[1-9]/.test(txt)) zeros.push(secs + 's → "' + txt + '"');
    }
    ok('扫 1 秒到 2 小时，没有一处显示成 0', zeros.length === 0, zeros.slice(0, 6).join('，'));
  }
  eq('59 分 50 秒不会算成 0h60m', fmtDur(3590 * 1000), '59m');
}

/* ── 11. 存盘往返 ──────────────────────────────────────── */

console.log('\n  ── 存盘往返 ──');
{
  const orig = createSession({
    id: 'x', date: 'D', blockId: 'b1', todoId: 't1',
    label: '英语', startedAt: T0, strict: false,
  });
  markAway(orig, T0 + 5 * M);
  markBack(orig, T0 + 7 * M);
  addUnknown(orig, 3 * M);
  endSession(orig, T0 + 60 * M);

  const back = fromRecord(toRecord(orig));

  eq('往返后结算结果完全一致', summarize(back).effectiveMs, summarize(orig).effectiveMs);
  eq('往返后离开区间一致', back.away, orig.away);
  eq('往返后未知时长一致', back.unknownMs, orig.unknownMs);
  eq('往返后标签一致', back.label, '英语');
  eq('往返后待办 id 一致', back.todoId, 't1');

  /* 存进去的必须是纯对象，不能被 IndexedDB 的结构化克隆拒绝 */
  const plain = toRecord(orig);
  ok('存盘对象是纯 JSON', typeof plain === 'object' && !(plain instanceof Map));
  ok('存盘后能被 JSON 再序列化一次',
    typeof JSON.stringify(plain) === 'string');
}

/* ── 10. 格式化 ────────────────────────────────────────── */

console.log('\n  ── 小工具 ──');
eq('fmtMs 4小时5分', fmtMs(4 * H + 5 * M), '4h05m');
eq('fmtMs 零', fmtMs(0), '0h00m');
eq('fmtMs 负数当零', fmtMs(-9999), '0h00m');
eq('fmtMs 59秒不进位', fmtMs(59 * 1000), '0h00m');
eq('pct 四舍五入', pct(0.336), '34%');
eq('pct 超范围会夹住', pct(1.7), '100%');

/* ── 结果 ──────────────────────────────────────────────── */

console.log('');
console.log(`  结果：${pass} 通过，${fail} 失败`);
if (fail) {
  console.log('');
  console.log('  失败项：');
  for (const f of fails) console.log('    · ' + f);
}
console.log('');

process.exit(fail ? 1 : 0);
