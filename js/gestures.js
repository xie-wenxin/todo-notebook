/* ═══════════════════════════════════════════════════════════
   gestures.js — 左右划识别
   要点：
     1. 在输入框上起手不算滑动（不然选字会被吃掉）
     2. 先判断方向：横向位移 > 纵向位移 × 1.3 才算横向，避免和上下滚打架
     3. 配合 CSS 的 touch-action: pan-y，纵向滚动完全交给系统，最跟手
   ═══════════════════════════════════════════════════════════ */

const DEAD_ZONE = 14;      // 手指先动这么多像素才开始判断方向
const AXIS_RATIO = 1.3;

export function attachSwipe(el, opts) {
  const {
    onLeft, onRight,
    threshold = 64,
    onDrag, onDragEnd,
    disabled = () => false,
    /* 待办那一行需要在文字上也能起手左划，所以给个开关 */
    allowEditable = false,
    /* 这个选择器里的手势归别人管，我不插手。
       没有它的话，在待办上左划会同时触发「这条待办」和「整页」两个动作。 */
    ignoreFrom = null,
  } = opts;

  let active = false;
  let pid = null;
  let sx = 0, sy = 0;
  let axis = null;

  function begin(e) {
    if (active || disabled()) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    if (ignoreFrom && e.target.closest(ignoreFrom)) return;
    if (!allowEditable && e.target.closest('input, textarea, [contenteditable]')) return;
    active = true;
    pid = e.pointerId;
    sx = e.clientX; sy = e.clientY;
    axis = null;
  }

  function move(e) {
    if (!active || e.pointerId !== pid) return;
    const dx = e.clientX - sx;
    const dy = e.clientY - sy;

    if (!axis) {
      if (Math.abs(dx) < DEAD_ZONE && Math.abs(dy) < DEAD_ZONE) return;
      axis = Math.abs(dx) > Math.abs(dy) * AXIS_RATIO ? 'x' : 'y';
    }
    if (axis === 'x' && onDrag) onDrag(dx, e);
  }

  function end(e) {
    if (!active || e.pointerId !== pid) return;
    const dx = e.clientX - sx;
    const dy = e.clientY - sy;
    const isHorizontal = axis === 'x'
      && Math.abs(dx) >= threshold
      && Math.abs(dx) > Math.abs(dy) * AXIS_RATIO;

    active = false;
    pid = null;
    axis = null;

    if (isHorizontal) {
      if (dx < 0 && onLeft) onLeft();
      else if (dx > 0 && onRight) onRight();
    }
    if (onDragEnd) onDragEnd();
  }

  el.addEventListener('pointerdown', begin, { passive: true });
  el.addEventListener('pointermove', move, { passive: true });
  el.addEventListener('pointerup', end, { passive: true });
  el.addEventListener('pointercancel', end, { passive: true });

  return () => {
    el.removeEventListener('pointerdown', begin);
    el.removeEventListener('pointermove', move);
    el.removeEventListener('pointerup', end);
    el.removeEventListener('pointercancel', end);
  };
}
