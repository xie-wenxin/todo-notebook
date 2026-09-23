/* ═══════════════════════════════════════════════════════════
   schedule.js — 课表 → 提前填好的待办

   课表是按「第几周 + 星期几 + 第几节」存的，而 App 是按日期走的。
   所以每次打开某一天，先算出那天是第几周、星期几，
   再看那天有没有课，有就把它当成一条待办**提前填进对应的时间块**。

   第几节 → 哪个块：
     1–4 节   → 上午 08:00–12:00
     5–8 节   → 下午 14:00–18:00
     9–10 节  → 运动那个块 19:00–20:00
   ═══════════════════════════════════════════════════════════ */

import { WEEK1_MONDAY, COURSES, PERIOD_TO_BLOCK } from './schedule-data.js';
import { fromKey, dateKey, diffDays, todayKey, newId } from './store.js';

/* ── 日期 ↔ 第几周 ─────────────────────────────────────── */

/** 这一天所在周的周一 */
function mondayOf(date) {
  const d = fromKey(date);
  const back = (d.getDay() + 6) % 7;
  return dateKey(new Date(d.getFullYear(), d.getMonth(), d.getDate() - back));
}

/** 这一天是第几周；不在学期范围内返回 0 */
export function weekOf(date) {
  const n = Math.floor(diffDays(WEEK1_MONDAY, mondayOf(date)) / 7) + 1;
  return n >= 1 ? n : 0;
}

/** 周一=1 … 周日=7 */
export function weekdayOf(date) {
  return ((fromKey(date).getDay() + 6) % 7) + 1;
}

/* ── 查课 ──────────────────────────────────────────────── */

/** 这一天有哪些课，按节次排好 */
export function coursesOn(date) {
  const w = weekOf(date);
  if (!w) return [];
  const wd = weekdayOf(date);
  return COURSES
    .filter(c => c.wd === wd && c.weeks.includes(w))
    .sort((a, b) => a.from - b.from);
}

/** 这一节该挂到哪个时间块上 */
export function blockFor(course) {
  for (const m of PERIOD_TO_BLOCK) {
    if (course.from >= m.from && course.from <= m.to) return m.block;
  }
  return null;
}

/** 课名太长就缩写，够区分就行 */
const SHORT_NAME = {
  '计算流体力学（甲）': '计算流体',
  '数据挖掘与机器学习': '数据挖掘',
  'MATLAB与机电系统仿真': 'MATLAB',
  '自动控制原理（乙）': '自动控制',
  '毛泽东思想和中国特色社会主义理论体系概论': '毛概',
  '发电厂电气部分（乙）': '发电厂',
  '形势与政策': '形势政策',
  '社会主义发展史': '社会主义',
  '公共财政理论与实践': '公共财政',
  '电机与拖动': '电机拖动',
};

/** 课 → 待办文字（缩写名 + 教室 + 第几节） */
export function courseText(c) {
  const name = SHORT_NAME[c.name] || c.name;
  const parts = [`📚 ${name}`];
  if (c.room) parts.push(c.room);
  parts.push(`第${c.from}-${c.to}节`);
  return parts.join(' · ');
}

/* ── 填进那一天 ────────────────────────────────────────── */

/**
 * 把这一天的课填成待办。只填一次（靠 day.courseSeed 标记），
 * 之后你自己删掉或改过的就不会再被塞回来。
 * 过去的日子不管 —— 你说了前面的不用管。
 *
 * @returns {Promise<number>} 新增了几条
 */
export async function seedCourses(day) {
  if (!day || day.courseSeed) return 0;
  if (day.date < todayKey()) return 0;   /* 过去的日子不动 */

  day.courseSeed = true;

  const list = coursesOn(day.date);
  let added = 0;

  /* 先按块分组。分组时 list 已经是按节次排好的，
     所以组内顺序天然正确 —— 一次性 unshift 进去就不会倒序。 */
  const byBlock = new Map();
  for (const c of list) {
    const bid = blockFor(c);
    if (!bid) continue;
    if (!byBlock.has(bid)) byBlock.set(bid, []);
    byBlock.get(bid).push(c);
  }

  for (const [bid, courses] of byBlock) {
    if (!day.todos[bid]) day.todos[bid] = [];

    const fresh = [];
    for (const c of courses) {
      const text = courseText(c);
      /* 已经有一条一模一样的就不重复加 */
      if (day.todos[bid].some(t => t.text === text)) continue;
      fresh.push({
        id: newId(),
        text,
        done: false,
        createdAt: Date.now(),
        doneAt: null,
        from: 'course',
        course: {
          name: c.name, room: c.room, teacher: c.teacher,
          from: c.from, to: c.to,
        },
      });
    }

    if (fresh.length) {
      /* 课插在待办**前面** —— 它是固定安排，按时间走 */
      day.todos[bid].unshift(...fresh);
      added += fresh.length;
    }
  }

  return added;
}

/** 给外部看：今天有没有课 */
export function todaysCourses() {
  return coursesOn(todayKey());
}
