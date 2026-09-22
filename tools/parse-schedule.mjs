/* ═══════════════════════════════════════════════════════════
   parse-schedule.mjs — 把课表 xlsx 解析成规范化的数据
   ═══════════════════════════════════════════════════════════ */

import fs from 'node:fs';
import zlib from 'node:zlib';

const file = process.argv[2];
const buf = fs.readFileSync(file);

/* ── 解 zip ────────────────────────────────────────────── */

function readZip(b) {
  const u8 = new Uint8Array(b);
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  let eocd = -1;
  for (let i = u8.length - 22; i >= Math.max(0, u8.length - 66000); i--) {
    if (dv.getUint32(i, true) === 0x06054B50) { eocd = i; break; }
  }
  const count = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  const out = new Map();
  for (let i = 0; i < count; i++) {
    const method = dv.getUint16(p + 10, true);
    const compSize = dv.getUint32(p + 20, true);
    const nameLen = dv.getUint16(p + 28, true);
    const extraLen = dv.getUint16(p + 30, true);
    const commentLen = dv.getUint16(p + 32, true);
    const localOffset = dv.getUint32(p + 42, true);
    const name = Buffer.from(u8.subarray(p + 46, p + 46 + nameLen)).toString('utf8');
    const l1 = dv.getUint16(localOffset + 26, true);
    const l2 = dv.getUint16(localOffset + 28, true);
    const start = localOffset + 30 + l1 + l2;
    const raw = Buffer.from(u8.subarray(start, start + compSize));
    out.set(name, method === 0 ? raw : zlib.inflateRawSync(raw));
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

const colToNum = (c) => { let n = 0; for (const ch of c) n = n * 26 + (ch.charCodeAt(0) - 64); return n; };
const numToCol = (n) => { let s = ''; while (n > 0) { const r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = Math.floor((n - 1) / 26); } return s; };
const unesc = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
  .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d))).replace(/&amp;/g, '&');

const zip = readZip(buf);

const shared = [];
const ss = zip.get('xl/sharedStrings.xml').toString('utf8');
for (const m of ss.matchAll(/<si>([\s\S]*?)<\/si>/g)) {
  shared.push(unesc([...m[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map(x => x[1]).join('')));
}

const sheet = zip.get('xl/worksheets/sheet1.xml').toString('utf8');
const cells = new Map();
for (const rowM of sheet.matchAll(/<row[^>]*\br="(\d+)"[^>]*>([\s\S]*?)<\/row>/g)) {
  const r = Number(rowM[1]);
  for (const cM of rowM[2].matchAll(/<c([^>]*?)\/>|<c([^>]*?)>([\s\S]*?)<\/c>/g)) {
    const attrs = cM[1] || cM[2] || '';
    const inner = cM[3] || '';
    const ref = /\br="([A-Z]+)(\d+)"/.exec(attrs);
    if (!ref) continue;
    const t = (/\bt="([^"]+)"/.exec(attrs) || [])[1] || '';
    let val = '';
    if (t === 's') {
      const v = /<v>(\d+)<\/v>/.exec(inner);
      val = v ? (shared[Number(v[1])] || '') : '';
    } else {
      const v = /<v>([\s\S]*?)<\/v>/.exec(inner);
      val = v ? unesc(v[1]) : '';
    }
    if (val) cells.set(ref[1] + r, val);
  }
}

/* ── 表结构（从表头推出来） ────────────────────────────── */

const WEEKDAYS = [
  { name: '周一', col: 'C' },
  { name: '周二', col: 'E' },
  { name: '周三', col: 'G' },
  { name: '周四', col: 'I' },
  { name: '周五', col: 'J' },
  { name: '周六', col: 'M' },
  { name: '周日', col: 'O' },
];

/* 第 N 节 落在第几行 */
const PERIOD_ROWS = [5, 11, 17, 23, 29, 35, 41, 47, 53, 59];

/* ── 把一格里的多门课拆开 ──────────────────────────────── */

function parseCell(text) {
  if (!text) return [];
  const parts = String(text).split(/\n?,\s*(?=【)/).map(s => s.trim()).filter(Boolean);

  return parts.map((p) => {
    const lines = p.split('\n').map(s => s.trim()).filter(Boolean);
    const head = lines[0] || '';
    const rest = lines.slice(1).join(' ');

    const hm = /^【([^】]*)】(.*?)\[([^\]]*)\](.*)$/.exec(head);
    const name = hm ? hm[2].trim() : head.replace(/^【[^】]*】/, '').trim();
    const code = hm ? hm[3].trim() : '';
    const kind = hm ? hm[4].trim() : '';

    const toks = rest.split(/\s+/).filter(Boolean);
    const wi = toks.findIndex(t => /周/.test(t));
    const teacher = wi > 0 ? toks.slice(0, wi).join(',') : '';
    const weeks = wi >= 0 ? toks[wi] : '';
    const pi = toks.findIndex(t => /第\s*\d+\s*节/.test(t));
    const periods = pi >= 0 ? toks[pi] : '';
    const room = toks.length ? toks[toks.length - 1] : '';

    return { name, code, kind, teacher, weeks, periods, room };
  });
}

/* ── 周次字符串 → 周次数组 ─────────────────────────────── */

function parseWeeks(s) {
  const out = [];
  for (const seg of String(s).replace(/周/g, '').split(/[,，]/)) {
    const t = seg.trim();
    if (!t) continue;
    const m = /^(\d+)\s*-\s*(\d+)$/.exec(t);
    if (m) {
      for (let i = Number(m[1]); i <= Number(m[2]); i++) out.push(i);
    } else if (/^\d+$/.test(t)) {
      out.push(Number(t));
    }
  }
  return [...new Set(out)].sort((a, b) => a - b);
}

/* ── 收集全部课程 ──────────────────────────────────────── */

const all = [];

WEEKDAYS.forEach((wd) => {
  PERIOD_ROWS.forEach((row, idx) => {
    const period = idx + 1;
    /* 只读奇数节（1,3,5,7,9）—— 双数节的格子和上一节是同一段合并单元格 */
    if (period % 2 === 0) return;

    const text = cells.get(wd.col + row);
    for (const c of parseCell(text)) {
      all.push({
        ...c,
        weekday: wd.name,
        periodStart: period,
        periodEnd: period + 1,
        weekList: parseWeeks(c.weeks),
      });
    }
  });
});

/* ── 调课信息 ──────────────────────────────────────────── */

const moved = [];
for (const row of [86, 87]) {
  const type = cells.get('A' + row);
  if (!type) continue;
  const d = cells.get('D' + row) || '';
  const from = {
    week: cells.get('J' + row) || '', weekday: cells.get('K' + row) || '',
    period: cells.get('L' + row) || '', room: cells.get('M' + row) || '',
  };
  const to = {
    week: cells.get('N' + row) || '', weekday: cells.get('O' + row) || '',
    period: cells.get('P' + row) || '', room: cells.get('Q' + row) || '',
  };
  if (d) moved.push({ type, name: d, from, to });
}

/* ── 输出 ──────────────────────────────────────────────── */

console.log('');
console.log('═══ 全部课程（按星期几分组） ═══');
for (const wd of WEEKDAYS) {
  const list = all.filter(c => c.weekday === wd.name);
  if (!list.length) continue;
  console.log('\n■ ' + wd.name);
  for (const c of list) {
    console.log(`   第${c.periodStart}-${c.periodEnd}节  ${c.name}${c.kind ? '(' + c.kind + ')' : ''}`);
    console.log(`              ${c.teacher}  ${c.weeks}  教室 ${c.room}`);
  }
}

console.log('\n═══ 调课信息 ═══');
for (const m of moved) {
  console.log(`   ${m.name}`);
  console.log(`     原：${m.from.week} 星期${m.from.weekday} 第${m.from.period}节 ${m.from.room}`);
  console.log(`     调到：${m.to.week} 星期${m.to.weekday} 第${m.to.period}节 ${m.to.room}`);
}

/* ── 指定周次 / 星期几 ─────────────────────────────────── */

const wantWeek = Number(process.argv[3] || 3);
const wantDay = process.argv[4] || '周二';

console.log('');
console.log(`═══ 第 ${wantWeek} 周 ${wantDay} 的课 ═══`);
const todays = all.filter(c => c.weekday === wantDay && c.weekList.includes(wantWeek));
if (!todays.length) console.log('   （没有课）');
for (const c of todays.sort((a, b) => a.periodStart - b.periodStart)) {
  console.log(`   第${c.periodStart}-${c.periodEnd}节  ${c.name}  ${c.teacher}  教室 ${c.room}`);
}

console.log('');
console.log(`═══ 第 ${wantWeek} 周 ${wantDay} 的调课 ═══`);
for (const m of moved) {
  const isTo = /^(\d+)/.exec(m.to.week)?.[1] === String(wantWeek)
    && (m.to.weekday === String(['一', '二', '三', '四', '五', '六', '日'].indexOf(wantDay.slice(1)) + 1));
  if (isTo) console.log(`   ↓ 从别处调来：${m.name}  第${m.to.period}节  ${m.to.room}`);
}

/* ══════════════════════════════════════════════════════════
   生成 App 用的数据模块
   ══════════════════════════════════════════════════════════ */

const WD_NUM = { 周一: 1, 周二: 2, 周三: 3, 周四: 4, 周五: 5, 周六: 6, 周日: 7 };

/* 合并「同一天同一节次同一门课同教室」的多条周次记录 */
const merged = new Map();
for (const c of all) {
  if (!c.weekList.length) continue;
  const key = [WD_NUM[c.weekday], c.periodStart, c.periodEnd, c.name, c.teacher, c.room].join('|');
  if (!merged.has(key)) {
    merged.set(key, {
      wd: WD_NUM[c.weekday],
      from: c.periodStart,
      to: c.periodEnd,
      name: c.name,
      teacher: c.teacher,
      room: c.room,
      weeks: new Set(),
    });
  }
  for (const w of c.weekList) merged.get(key).weeks.add(w);
}

const courses = [...merged.values()].map(c => ({ ...c, weeks: [...c.weeks].sort((a, b) => a - b) }));

/* 调课：以「补课时间地点」（后面那几列）为准，覆盖那个位置的教室。
   注意：调课表里的「星期」是数字（1=周一 … 7=周日），不是「周二」这种字样。 */
const overrides = [];
for (const m of moved) {
  const rawWd = String(m.to.weekday).trim();
  const wd = /^[1-7]$/.test(rawWd)
    ? Number(rawWd)
    : WD_NUM['周' + rawWd];
  const wk = Number((/^(\d+)/.exec(m.to.week) || [])[1]);
  const pm = /(\d+)\s*-\s*(\d+)/.exec(m.to.period);
  if (!wd || !wk || !pm) {
    console.log(`   [调课解析跳过] ${m.name} —— 星期=${rawWd} 周=${m.to.week} 节=${m.to.period}`);
    continue;
  }
  overrides.push({
    week: wk, wd,
    from: Number(pm[1]), to: Number(pm[2]),
    name: m.name, room: String(m.to.room || '').trim(),
  });
}
console.log('\n═══ 识别出的调课 ═══');
for (const o of overrides) console.log(`   第${o.week}周 周${'一二三四五六日'[o.wd - 1]} 第${o.from}-${o.to}节  ${o.name}  →  ${o.room}`);

/* 用调课覆盖课表里的教室（以「补课时间地点」为准） */
const bare = (s) => String(s).replace(/（.*?）/g, '').trim();
for (const o of overrides) {
  if (!o.room) continue;
  for (const c of courses) {
    if (c.wd !== o.wd || c.from !== o.from || c.to !== o.to) continue;
    if (!c.weeks.includes(o.week)) continue;
    const a = bare(c.name);
    const b = bare(o.name);
    if (a === b || c.name.includes(o.name) || o.name.includes(c.name)) {
      c.room = o.room;
    }
  }
}

/* 按星期几、节次排好，输出成可读的模块 */
courses.sort((a, b) => a.wd - b.wd || a.from - b.from || a.name.localeCompare(b.name));

const lines = [];
lines.push('/* ═══════════════════════════════════════════════════════════');
lines.push('   schedule-data.js — 课表数据（由 tools/parse-schedule.mjs 生成，别手改）');
lines.push('');
lines.push('   weeks 是「第几周」，不是日期。第一周周一见 WEEK1_MONDAY。');
lines.push('   App 每次打开某一天，会算出那天是第几周、星期几，');
lines.push('   再看这一天有没有课，有就提前填成待办。');
lines.push('   ═══════════════════════════════════════════════════════════ */');
lines.push('');
lines.push('/** 学期第一周的周一 */');
lines.push("export const WEEK1_MONDAY = '2026-09-07';");
lines.push('');
lines.push('/** 第几节 → 挂到哪个时间块上 */');
lines.push('export const PERIOD_TO_BLOCK = [');
lines.push("  { from: 1, to: 4, block: 'b2' },   // 上午  08:00–12:00");
lines.push("  { from: 5, to: 8, block: 'b4' },   // 下午  14:00–18:00");
lines.push("  { from: 9, to: 10, block: 'b6' },  // 晚上→运动那个块 19:00–20:00");
lines.push('];');
lines.push('');
lines.push('/** 全部课程 */');
lines.push('export const COURSES = [');
let lastWd = 0;
for (const c of courses) {
  if (c.wd !== lastWd) {
    lines.push(`  /* ── 周${'一二三四五六日'[c.wd - 1]} ── */`);
    lastWd = c.wd;
  }
  lines.push(`  { wd: ${c.wd}, from: ${c.from}, to: ${c.to}, `
    + `name: ${JSON.stringify(c.name)}, teacher: ${JSON.stringify(c.teacher)}, `
    + `room: ${JSON.stringify(c.room)}, weeks: [${c.weeks.join(',')}] },`);
}
lines.push('];');
lines.push('');

const outPath = process.argv[5] || 'js/schedule-data.js';
fs.writeFileSync(outPath, lines.join('\n'), 'utf8');

console.log('');
console.log(`已写出 ${outPath}`);
console.log(`   ${courses.length} 条课程记录，覆盖第 ${Math.min(...courses.flatMap(c => c.weeks))}–${Math.max(...courses.flatMap(c => c.weeks))} 周`);
console.log('');
