/* ═══════════════════════════════════════════════════════════
   test-focus.mjs — 专注引擎的单元测试
   纯逻辑，不开浏览器，跑得飞快。用法：node tools/test-focus.mjs
   ═══════════════════════════════════════════════════════════ */

import {
  createSession, markAway, markBack, endSession, addUnknown, summarize,
  dayFocus, byBlock, toRecord, fromRecord, fmtMs, pct, GRACE_MS,
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

/* ── 2. 短离开不扣、长离开扣 ───────────────────────────── */

console.log('\n  ── 短离开 vs 长离开 ──');
{
  const s = createSession({ startedAt: T0 });
  markAway(s, T0 + 60 * M);
  markBack(s, T0 + 61 * M);            // 离开 1 分钟
  endSession(s, T0 + 120 * M);
  const r = summarize(s);

  eq('离开次数记了 1 次', r.awayCount, 1);
  eq('短离开的时长仍然记录在案', r.awayMs, 1 * M);
  eq('但一分钱都不扣', r.deductedMs, 0);
  eq('有效 = 总时长 120 分钟', r.effectiveMs, 120 * M);
}
{
  const s = createSession({ startedAt: T0 });
  markAway(s, T0 + 30 * M);
  markBack(s, T0 + 35 * M);            // 离开 5 分钟
  endSession(s, T0 + 60 * M);
  const r = summarize(s);

  eq('长离开扣 5 分钟', r.deductedMs, 5 * M);
  eq('有效 = 55 分钟', r.effectiveMs, 55 * M);
  eq('长离开次数 1', r.longAwayCount, 1);
}
{
  /* 2 分钟整，正好卡在阈值上，应当算长离开 */
  const a = createSession({ startedAt: T0 });
  endSession(markBack(markAway(a, T0), T0 + GRACE_MS), T0 + 60 * M);
  eq('正好 2 分钟：算长离开', summarize(a).deductedMs, GRACE_MS);

  const b = createSession({ startedAt: T0 });
  endSession(markBack(markAway(b, T0), T0 + GRACE_MS - 1), T0 + 60 * M);
  eq('差 1 毫秒：算短离开', summarize(b).deductedMs, 0);
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
  eq('有效 = 10 分钟', r.effectiveMs, 10 * M);
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

  eq('未知的 12 分钟照实扣掉', r.effectiveMs, 48 * M);
  eq('未知时长单独记着', r.unknownMs, 12 * M);
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
  eq('这一段扣 10 分钟', r.deductedMs, 10 * M);
  eq('有效 50 分钟', r.effectiveMs, 50 * M);
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

/* ── 9. 存盘往返 ───────────────────────────────────────── */

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
