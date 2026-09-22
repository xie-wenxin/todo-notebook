/* ═══════════════════════════════════════════════════════════
   schedule-data.js — 课表数据（由 tools/parse-schedule.mjs 生成，别手改）

   weeks 是「第几周」，不是日期。第一周周一见 WEEK1_MONDAY。
   App 每次打开某一天，会算出那天是第几周、星期几，
   再看这一天有没有课，有就提前填成待办。
   ═══════════════════════════════════════════════════════════ */

/** 学期第一周的周一 */
export const WEEK1_MONDAY = '2026-09-07';

/** 第几节 → 挂到哪个时间块上 */
export const PERIOD_TO_BLOCK = [
  { from: 1, to: 4, block: 'b2' },   // 上午  08:00–12:00
  { from: 5, to: 8, block: 'b4' },   // 下午  14:00–18:00
  { from: 9, to: 10, block: 'b6' },  // 晚上→运动那个块 19:00–20:00
];

/** 全部课程 */
export const COURSES = [
  /* ── 周一 ── */
  { wd: 1, from: 1, to: 2, name: "MATLAB与机电系统仿真", teacher: "李全武", room: "水建楼A219", weeks: [11,12,13,14] },
  { wd: 1, from: 3, to: 4, name: "水轮机", teacher: "王玉川", room: "N8109", weeks: [1,2,4,6,7,8,9,10,11,12] },
  { wd: 1, from: 5, to: 6, name: "形势与政策", teacher: "朱若晨", room: "N8609", weeks: [10,11,12,13] },
  { wd: 1, from: 7, to: 8, name: "自动控制原理（乙）", teacher: "樊强,樊强", room: "N8212", weeks: [1,2,3,4,6,7,8,9,10,11] },
  /* ── 周二 ── */
  { wd: 2, from: 1, to: 2, name: "水轮机", teacher: "王玉川", room: "N8109", weeks: [3] },
  { wd: 2, from: 1, to: 2, name: "自动控制原理（乙）", teacher: "樊强", room: "水建楼B416", weeks: [12,13] },
  { wd: 2, from: 1, to: 2, name: "MATLAB与机电系统仿真", teacher: "李全武", room: "N8115", weeks: [6,7,8,9,10,11] },
  { wd: 2, from: 3, to: 4, name: "电机与拖动", teacher: "张宁", room: "N8208", weeks: [1,2,3,4,6,7,8,9,10,11,12] },
  { wd: 2, from: 5, to: 6, name: "电机与拖动", teacher: "张宁", room: "水建楼B418", weeks: [12] },
  { wd: 2, from: 5, to: 6, name: "计算流体力学（甲）", teacher: "冉聃颉", room: "N8409", weeks: [1,2,3,4,6,7,8,9] },
  { wd: 2, from: 7, to: 8, name: "数据挖掘与机器学习", teacher: "刘泽", room: "N8214", weeks: [1,2,3,4,6,7,8,9] },
  /* ── 周三 ── */
  { wd: 3, from: 1, to: 2, name: "MATLAB与机电系统仿真", teacher: "李全武", room: "水建楼A219", weeks: [11,12,13,14] },
  { wd: 3, from: 3, to: 4, name: "水轮机", teacher: "毛秀丽", room: "N8111", weeks: [13] },
  { wd: 3, from: 3, to: 4, name: "水轮机", teacher: "王玉川", room: "N8109", weeks: [1,2,3,4,6,7,8,9,10,11,12] },
  { wd: 3, from: 5, to: 6, name: "发电厂电气部分（乙）", teacher: "宋莹", room: "N8418", weeks: [1,2,3,4,6,7,8,9,10,11] },
  { wd: 3, from: 9, to: 10, name: "社会主义发展史", teacher: "高耀芳", room: "N8T06", weeks: [12,13] },
  { wd: 3, from: 9, to: 10, name: "社会主义发展史", teacher: "黄瑞卿", room: "N8T06", weeks: [9,10,11] },
  { wd: 3, from: 9, to: 10, name: "社会主义发展史", teacher: "张坤", room: "N8T06", weeks: [4,14] },
  { wd: 3, from: 9, to: 10, name: "社会主义发展史", teacher: "雍婧", room: "N8T06", weeks: [6,7,8] },
  /* ── 周四 ── */
  { wd: 4, from: 1, to: 2, name: "毛泽东思想和中国特色社会主义理论体系概论", teacher: "汪钊", room: "N8216", weeks: [5,6,7,8,9,10,11,12] },
  { wd: 4, from: 3, to: 4, name: "电机与拖动", teacher: "张宁", room: "N8208", weeks: [1,2,3,5,6,7,8,9,10,11,12] },
  { wd: 4, from: 3, to: 4, name: "水轮机", teacher: "王立青", room: "水建楼B108", weeks: [13] },
  { wd: 4, from: 5, to: 6, name: "电机与拖动", teacher: "张宁", room: "水建楼B418", weeks: [12] },
  { wd: 4, from: 5, to: 6, name: "MATLAB与机电系统仿真", teacher: "李全武", room: "N8115", weeks: [6,7,8,9,10,11] },
  { wd: 4, from: 7, to: 8, name: "计算流体力学（甲）", teacher: "冉聃颉", room: "N8409", weeks: [1,2,5,6,7,8,9,10] },
  { wd: 4, from: 7, to: 8, name: "自动控制原理（乙）", teacher: "樊强", room: "水建楼B416", weeks: [13] },
  { wd: 4, from: 9, to: 10, name: "公共财政理论与实践", teacher: "姬便便", room: "N9101", weeks: [5,6,7,8,9,10,11,12,13,14] },
  /* ── 周五 ── */
  { wd: 5, from: 1, to: 2, name: "毛泽东思想和中国特色社会主义理论体系概论", teacher: "汪钊", room: "N8507", weeks: [1,2,5,6,7,8,9,10,11,12,13] },
  { wd: 5, from: 3, to: 4, name: "自动控制原理（乙）", teacher: "樊强,樊强", room: "N8212", weeks: [1,2,5,6,7,8,9,10,11] },
  { wd: 5, from: 3, to: 4, name: "自动控制原理（乙）", teacher: "樊强,樊强", room: "N8417", weeks: [12] },
  { wd: 5, from: 5, to: 6, name: "发电厂电气部分（乙）", teacher: "宋莹", room: "N8418", weeks: [1,2,5,6,7,8,9,10,11] },
  { wd: 5, from: 7, to: 8, name: "数据挖掘与机器学习", teacher: "刘泽", room: "N8214", weeks: [1,2,5,6,7,8,9] },
  /* ── 周日 ── */
  { wd: 7, from: 1, to: 2, name: "毛泽东思想和中国特色社会主义理论体系概论", teacher: "汪钊", room: "N8507", weeks: [2] },
  { wd: 7, from: 3, to: 4, name: "自动控制原理（乙）", teacher: "樊强,樊强", room: "N8212", weeks: [2] },
  { wd: 7, from: 5, to: 6, name: "发电厂电气部分（乙）", teacher: "宋莹", room: "N8418", weeks: [2] },
  { wd: 7, from: 7, to: 8, name: "数据挖掘与机器学习", teacher: "刘泽", room: "N8214", weeks: [2] },
];
