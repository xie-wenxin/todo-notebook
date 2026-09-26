/* 故意在库里塞两条没结束的会话（正常不会出现），
   看 resumeIfAny 会不会只接一条、把多余的收掉。 */
(async () => {
  const store = await import('./js/store.js');
  const F = await import('./js/focus.js');
  const ui = await import('./js/focus-ui.js');
  const today = store.todayKey();
  const now = Date.now();
  const MIN = 60000;

  const a = F.createSession({ id: 'orph-a', date: today, blockId: 'b2', startedAt: now - 60 * MIN });
  a.lastTick = now - 50 * MIN;
  const b = F.createSession({ id: 'orph-b', date: today, blockId: 'b4', startedAt: now - 30 * MIN });
  b.lastTick = now - 20 * MIN;
  await store.putSession(F.toRecord(a));
  await store.putSession(F.toRecord(b));

  const before = (await store.allSessions()).filter(s => !s.endedAt).length;
  await ui.resumeIfAny();
  const all = await store.allSessions();

  const idOf = (x) => x.id;
  const A = all.find(s => s.id === 'orph-a');
  return {
    running_before: before,
    running_after: all.filter(s => !s.endedAt).map(idOf),
    closed_a_at_lastTick_min: A && A.endedAt ? Math.round((now - 50 * MIN - A.endedAt) / 1000) : null,
    dayTotalMin: Math.round(F.dayFocus(all.map(x => ({ ...x, away: x.away || [] }))).effectiveMs / MIN),
  };
})()
