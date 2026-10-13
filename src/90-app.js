// ============================================================================
// 扳机倍速 · 主循环
// 每帧：找播放器 → 读手柄 → 算出目标倍速 → 平滑 → 写入 → 读按键 → 更新 HUD。
// 依赖：00-core / 20-hud / 30-player / 40-gamepad / 50-actions
// ============================================================================
'use strict';

// ---------------------------------------------------------------- 子功能模块

// 检测并处理播放器挂载
function updatePlayerConnection() {
  if (!video || !video.isConnected) {
    if (scanTick % SCAN_INTERVAL === 0) {
      const v = findVideo();
      if (v) { if (video) detach(); attach(v); }
      else if (video) detach();
    }
    return false;
  }
  return true;
}

// 处理默认倍速变更
function updateBaseRate(now) {
  if (forceBase) {
    forceBase = false;
    // 只在启用且有手柄时应用自定义倍速
    if (cfg.enabled && activePadId && !cfg.syncPlayer) applyBase(true);
    else {
      // 切到同步模式：以当前实际倍速为起点，之后跟随播放器的改动
      playerRate = cur = expected = clampRate(video.playbackRate);
      reportPlayerRate();
    }
  }
}

// 读取手柄状态
function readGamepadState() {
  const pads = navigator.getGamepads ? navigator.getGamepads() : [];
  const { best, connectedId } = pickPad(pads);
  notePadConnection(connectedId, performance.now());
  const pad = best ? best.pad : null;
  const rtRaw = best ? best.r : 0;
  const ltRaw = best ? best.l : 0;
  const active = !!best;
  const rt = cfg.swap ? ltRaw : rtRaw;
  const lt = cfg.swap ? rtRaw : ltRaw;
  return { pad, rt, lt, active };
}

// 计算目标倍速
function calculateTargetRate(rt, lt, active) {
  const dz = clamp(cfg.deadzone, 0, 0.5);
  const base = baseRate();
  let target = base;

  // 只有在启用且有手柄连接时才处理扳机输入
  triggerHeld = cfg.enabled && active && activePadId && (rt > dz || lt > dz);

  if (cfg.enabled && active && activePadId) {
    // 可调上限模式：RT 全力 = 默认倍速 + 偏移量；否则用固定值
    const cap = cfg.rtMaxRel ? base + clamp(cfg.rtMaxDelta, 0.5, 15) : cfg.rtMax;
    if (cfg.ltAccel) {
      // LT 也加速：两扳机叠加，一起向最高速插值
      const n = clamp((clamp(rt + lt, 0, 1) - dz) / (1 - dz), 0, 1);
      if (n > 0) target = base + n * (cap - base);
    } else {
      const net = rt - lt;
      const n = clamp((Math.abs(net) - dz) / (1 - dz), 0, 1);
      if (n > 0) {
        target = net > 0
          ? base + n * (cap - base)
          : base - n * (base - cfg.ltMin);
      }
    }
    if (triggerHeld) lastActivity = performance.now();
  }
  return clampRate(target);
}

// 应用平滑并写入倍速
function applyPlaybackRate(target, dt, active) {
  // 指数平滑
  const tau = Math.max(0, cfg.smooth);
  const alpha = tau <= 0.002 ? 1 : 1 - Math.exp(-dt / tau);
  cur += (target - cur) * alpha;
  if (Math.abs(cur - target) < 0.0005) cur = target;
  cur = clampRate(cur);

  // 只在「启用 + 手柄连接 + 正在扣扳机 / 松手后正在回归基准」时接管倍速；
  // 自定义默认倍速（关闭同步）时额外持续守住。其余时间交还给播放器，
  // 否则手柄一插着就会把播放器菜单里设的倍速覆盖掉。
  const settling = Math.abs(cur - target) > 0.004;
  // kbdBoost：键盘长按 → 官方加速期间不接管，避免把播放器的临时倍速盖掉
  const canWrite = cfg.enabled && activePadId && !kbdBoost && ((active && (triggerHeld || settling)) || !cfg.syncPlayer);
  const w = q2(cur);   // 写入值量化到两位，B 站的倍速显示才不会变成一长串

  if (canWrite && Math.abs(w - video.playbackRate) > 0.004) {
    setRate(w);
  } else if (!canWrite && Math.abs(cur - video.playbackRate) > 0.0005) {
    // 不接管时，跟随视频的真实倍速，避免下次接管时从错误的值起步
    cur = expected = clampRate(video.playbackRate);
  }

  // 跟随模式且空闲：播放器里的倍速一变就实时成为新的默认倍速
  // （不只依赖 ratechange，轮询兜住播放器改了但没派发事件的情况）
  if (cfg.syncPlayer && cfg.enabled && !kbdBoost && !canWrite && !triggerHeld) {
    const r = clampRate(video.playbackRate);
    if (Math.abs(r - playerRate) > 0.004) {
      playerRate = r;
      cur = expected = r;
      reportPlayerRate();
    }
  }

  // 跟随模式下，松手回到基准后，强制同步 playerRate
  // 避免量化误差累积导致的漂移（如 1.00 -> 0.99 -> 0.98...）
  // 注意：只在完全稳定后才修正，避免干扰正常的扳机控制
  if (cfg.syncPlayer && cfg.enabled && activePadId && !kbdBoost && !triggerHeld && !settling && !active) {
    const actual = clampRate(video.playbackRate);
    if (Math.abs(actual - playerRate) > 0.01) {
      playerRate = actual;
      cur = expected = actual;
      reportPlayerRate();
    }
  }
}

// 处理所有按键输入
function processButtonInputs(pad, now) {
  // 只有在启用且手柄连接时才处理按键
  if (!cfg.enabled || !activePadId) return;

  handleVolume(pad, now);
  handleRateStep(pad, now);
  handleSubtitle(pad, now);
  handlePause(pad, now);
  handleSeek(pad, now);
  handleKeys(pad, now);
}

// 处理字幕恢复和任务
function updateSubtitleState(now) {
  // 字幕：已接管但菜单还没渲染好时，低频重试直到套用成功（约 0.5s 一次，最多 20s）
  if (!subApplied && scanTick % SUB_RESTORE_INTERVAL === 0) {
    subTries++;
    if (restoreSub() || subTries > SUB_RESTORE_MAX_TRIES) subApplied = true;
  }
  flushSubJob(now);
  // B 站的「字幕已切换至 xx」提示可能是异步挂上来的，切完多扫几帧
  if (subToastSweep > 0) { subToastSweep--; suppressSubToast(); }
}

// 更新 HUD 显示
function updateHUD(now, rt, lt) {
  if (cfg.hud) {
    const anchor = hudAnchor(video);
    if (!hud || hud.parentElement !== anchor) buildHud(video, anchor);
    const showFlash = now < flashUntil;
    const visible = triggerHeld || showFlash || now - lastActivity < ACTIVITY_TIMEOUT;
    // 谁最后动作就显示谁；没有动作时显示扣扳机状态或待命信息
    let note = showFlash ? flashText : '';
    if (!note && triggerHeld) note = cfg.ltAccel
      ? '扳机加速' + (cfg.swap ? '（已交换）' : '')
      : (rt >= lt ? 'RT 加速' : 'LT 减速') + (cfg.swap ? '（已交换）' : '');
    // 待命提示保持在固定宽度内（当前倍速上面的大字已经显示了，这里只报扳机区间）
    if (!note) {
      const lo = cfg.ltAccel ? baseRate() : cfg.ltMin;
      const cap = cfg.rtMaxRel ? baseRate() + clamp(cfg.rtMaxDelta, 0.5, 15) : cfg.rtMax;
      note = activePadId
        ? '待命 · ' + lo.toFixed(2) + 'x ~ ' + cap.toFixed(1) + 'x'
        : '未检测到手柄';
    }
    setHud(visible, q2(cur), lt, rt, note);
  } else if (hud) {
    removeHud();
  }
}

// ---------------------------------------------------------------- 主循环

function frame(now) {
  // 扩展被重载 / 页面里来了新实例 → 立刻停手并撤掉 HUD，不再排下一帧
  if (!instanceAlive()) { detach(); return; }
  requestAnimationFrame(frame);
  scanTick++;
  const dt = lastFrame ? Math.min((now - lastFrame) / 1000, 0.1) : 0.016;
  lastFrame = now;

  // URL 变化检测：SPA 切换视频时重置字幕状态
  const currentUrl = location.href;
  if (currentUrl !== lastUrl) {
    lastUrl = currentUrl;
    resetSubState();
  }

  // 检测播放器连接
  if (!updatePlayerConnection()) return;

  // 处理默认倍速变更
  updateBaseRate(now);

  // 读取手柄状态
  const { pad, rt, lt, active } = readGamepadState();

  // 计算目标倍速
  const target = calculateTargetRate(rt, lt, active);

  // 应用平滑并写入倍速
  applyPlaybackRate(target, dt, active);

  // 处理按键输入
  processButtonInputs(pad, now);

  // 更新字幕状态
  updateSubtitleState(now);

  // 更新 HUD
  updateHUD(now, rt, lt);
}

function boot() {
  // 启动时先立刻找一次播放器（document_idle 时通常已存在），
  // 之后的轮询只用于 SPA 切换 / 播放器延迟出现的情况
  const initial = findVideo();
  if (initial) attach(initial);
  requestAnimationFrame(frame);
}

// ---------------------------------------------------------------- 键盘兼容
// B 站官方快捷键「长按 → 临时加速」：按住期间把倍速控制权还给播放器，
// 否则自定义基准模式下扩展会每帧把倍速写回去，官方加速直接被盖掉。
// 只监听、不拦截，播放器自己的处理不受影响；↑↓ 音量本来就不冲突。
function watchKeyboardBoost() {
  const typing = (t) => !!(t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable));
  try {
    window.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowRight' && !typing(e.target)) kbdBoost = true;
    }, true);
    window.addEventListener('keyup', (e) => {
      if (e.key === 'ArrowRight') kbdBoost = false;
    }, true);
    window.addEventListener('blur', () => { kbdBoost = false; });
  } catch (e) { /* ignore */ }
}

watchKeyboardBoost();
if (!PTS_LIVE) boot();
