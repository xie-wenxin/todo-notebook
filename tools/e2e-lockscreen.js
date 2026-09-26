/* 端到端：模拟手机上真实发生的事 —— 点开始 → 黑屏 → 页面被 iOS 回收
   → 90 分钟后回来点停止。然后看屏幕上到底显示多少分钟。 */
(async () => {
  const store = await import('./js/store.js');
  const F = await import('./js/focus.js');
  const sum = await import('./js/summary.js');
  const wait = (ms) => new Promise(r => setTimeout(r, ms));

  const today = store.todayKey();
  const now = Date.now();
  const MIN = 60000;

  const before = (document.getElementById('goalNow') || {}).textContent;

  /* 91 分钟前点的开始；1 分钟后就失联了（只来得及存一次盘） */
  const s = F.createSession({
    id: 'e2e-' + now, date: today, blockId: 'b2',
    label: '流体力学', startedAt: now - 91 * MIN,
  });
  s.lastTick = now - 90 * MIN;
  F.addUnknown(s, 89 * MIN);          /* 失联的那段，以前会被扣光 */
  F.endSession(s, now);
  await store.putSession(F.toRecord(s));

  /* 等价于「从别的 App 切回来」 */
  document.dispatchEvent(new Event('visibilitychange'));
  await wait(1000);
  const bar = (document.getElementById('goalNow') || {}).textContent;

  /* 打开总结页 */
  const day = await store.getDay(today);
  await sum.openSummary(today, day);
  await wait(700);

  const donut = document.querySelector('.donut-big');
  const legend = document.querySelector('.donut-legend, .sum-legend');

  const out = {
    goalBar_before: before,
    goalBar_after: bar,
    donut_big: donut ? donut.textContent : '(none)',
    timeline_segments: document.querySelectorAll('.vtl-seg').length,
    legend_text: legend ? legend.textContent.replace(/\s+/g, ' ').trim().slice(0, 80) : '(none)',
    unknownMs_recorded: s.unknownMs,
    effectiveMs: F.dayFocus([F.fromRecord(JSON.parse(JSON.stringify(s)))]).effectiveMs,
  };
  sum.closeSummary();
  return out;
})()
