/* ═══════════════════════════════════════════════════════════
   sleep.js — 我睡了 / 我醒了

   你点「我睡了」→ 记下时间，然后自己去锁屏。
   下次打开 App → 自动记「我醒了」。
   间隔不到 3 分钟就不记（大概是点错了，或者只是切出去了一下）。
   ═══════════════════════════════════════════════════════════ */

import { loadSettings, saveSettings, getDay, putDay, todayKey } from './store.js';

const MIN_GAP_MS = 3 * 60 * 1000;

/** 点「我睡了」 */
export async function markAsleep(day) {
  const now = Date.now();
  day.sleepAt = now;
  day.wakeAt = null;
  await putDay(day);
  await saveSettings({ sleeping: true, sleepStamp: now });
  return now;
}

/** 再点一下 = 取消 */
export async function clearAsleep(day) {
  day.sleepAt = null;
  await putDay(day);
  await saveSettings({ sleeping: false, sleepStamp: null });
}

/**
 * 打开 App 时调一次：之前说过「我睡了」，现在又回来了 —— 记「我醒了」。
 * @returns {Promise<number|null>} 醒了的时间戳，没记就返回 null
 */
export async function checkWake() {
  const s = await loadSettings();
  if (!s.sleeping || !s.sleepStamp) return null;

  const now = Date.now();
  if (now - s.sleepStamp < MIN_GAP_MS) return null;   /* 不到 3 分钟不算 */

  const day = await getDay(todayKey());
  day.wakeAt = now;
  await putDay(day);
  await saveSettings({ sleeping: false, sleepStamp: null });
  return now;
}

/** 现在是不是「睡着」状态 */
export async function isSleeping() {
  const s = await loadSettings();
  return !!s.sleeping;
}
