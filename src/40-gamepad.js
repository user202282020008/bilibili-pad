// ============================================================================
// 扳机倍速 · 手柄层
// Gamepad API 读取与按键辅助。
// 依赖：00-core.js（activePadId / flash）
//
// 按键编号（标准 Xbox 布局映射）：
//   0 = A  1 = B  2 = X  3 = Y  4 = L1  5 = R1  6 = LT  7 = RT
//   11 = R3（右摇杆按下）  12 = ↑  13 = ↓  14 = ←  15 = →
// ============================================================================
'use strict';

const PAD = {
  A: 0, B: 1, X: 2, Y: 3,
  L1: 4, R1: 5, LT: 6, RT: 7,
  R3: 11,
  UP: 12, DOWN: 13, LEFT: 14, RIGHT: 15,
};

// 扳机模拟量（0~1）
function trig(pad, idx) {
  const b = pad.buttons && pad.buttons[idx];
  if (!b) return 0;
  return typeof b.value === 'number' ? b.value : (b.pressed ? 1 : 0);
}

// 数字按键是否按下
function pressed(pad, idx) {
  const b = pad.buttons && pad.buttons[idx];
  if (!b) return false;
  return !!b.pressed || (typeof b.value === 'number' && b.value > 0.5);
}

// 在多只手柄里挑一只：优先当前活跃手柄，其次扳机按得最深的那只
function pickPad(pads) {
  let best = null, bestScore = -1, connectedId = '';
  for (const p of pads) {
    if (!p || !p.connected) continue;
    connectedId = p.id;
    const r = trig(p, PAD.RT), l = trig(p, PAD.LT);
    const score = r + l + (p.id === activePadId ? 0.5 : 0);
    if (score > bestScore) { bestScore = score; best = { pad: p, r, l }; }
  }
  return { best, connectedId };
}

// 手柄插拔时在 HUD 上提示一次
function notePadConnection(connectedId, now) {
  if (connectedId && connectedId !== activePadId) {
    activePadId = connectedId;
    flash('已连接：' + connectedId.replace(/\s*\(.*?\)\s*/g, ' ').trim(), now, FLASH_DURATION_LONG);
  } else if (!connectedId && activePadId) {
    activePadId = null;
    flash('手柄已断开', now, FLASH_DURATION_LONG);
  }
}
