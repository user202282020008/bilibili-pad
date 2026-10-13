// ============================================================================
// 扳机倍速 · 播放器层
// 定位 <video>、挂载/卸载、倍速基准与写入。
// 依赖：00-core.js（状态 / clamp / q2 等）
//       20-hud.js（buildHud / hudAnchor / removeHud）
//       50-actions.js（restoreSub）
// ============================================================================
'use strict';

// ---------------------------------------------------------------- 查找视频
// Shadow DOM 路径缓存，避免重复递归
let shadowRootCache = new WeakSet();

function collectVideos(root, out) {
  out = out || [];
  let list;
  try { list = root.querySelectorAll('video'); } catch (e) { return out; }
  for (const v of list) out.push(v);
  // 新版播放器可能把 video 放在 shadow DOM 里
  for (const el of root.querySelectorAll('*')) {
    if (el.shadowRoot && !shadowRootCache.has(el.shadowRoot)) {
      shadowRootCache.add(el.shadowRoot);
      collectVideos(el.shadowRoot, out);
    }
  }
  return out;
}

const PLAYER_SEL = '.bpx-player-video-area, .bilibili-player-video-wrap, .bpx-player-container, .bilibili-player, #bilibili-player';

function findVideo() {
  const vids = collectVideos(document);
  if (!vids.length) return null;
  const usable = vids.filter((v) => !v.classList.contains('pts-ignore') && (v.readyState > 0 || v.currentSrc));
  const pool = usable.length ? usable : vids;
  const inPlayer = pool.find((v) => v.closest(PLAYER_SEL));
  if (inPlayer && isFinite(inPlayer.duration)) return inPlayer;
  let best = null, area = -1;
  for (const v of pool) {
    if (!isFinite(v.duration)) continue;
    const r = v.getBoundingClientRect();
    const a = r.width * r.height;
    if (a > area) { area = a; best = v; }
  }
  return best;
}

// ---------------------------------------------------------------- 倍速
// 把播放器当前倍速同步到 storage.local，供弹窗显示
function reportPlayerRate() {
  if (Math.abs(playerRate - reported) < 0.001) return;
  reported = playerRate;
  try { chrome.storage.local.set({ playerRate }); } catch (e) { /* ignore */ }
}

// 松开扳机时的基准倍速：同步播放器时读播放器自身的倍速
function baseRate() {
  return cfg.syncPlayer ? playerRate : clampRate(cfg.base);
}

// 统一入口：写入倍速，并记下时间（用于区分播放器自身的改动）
function setRate(v) {
  if (!video) return;
  writeAt = performance.now();
  expected = v;
  try { video.playbackRate = v; } catch (e) { /* ignore */ }
}

// 立刻把视频切到自定义默认倍速
function applyBase(syncNow) {
  if (!video) return;
  const b = q2(clampRate(cfg.base));
  if (syncNow) cur = b;
  setRate(b);
}

function onRateChange() {
  if (!video) return;
  const now = performance.now();
  const r = clampRate(video.playbackRate);
  // 我们自己刚写的（或值没变）→ 不是播放器改的设置
  if (now - writeAt < RATE_CHANGE_WINDOW || Math.abs(r - expected) <= 0.005) return;
  // 键盘长按 → 官方加速是临时状态，不当成新的基准倍速
  if (kbdBoost) return;
  // 空闲时播放器的倍速变化就是新的基准（同步模式下跟随它）
  if (!triggerHeld && now - lastActivity > PLAYER_SYNC_THRESHOLD) {
    playerRate = r;
    reportPlayerRate();
    cur = r;
  }
}

// ---------------------------------------------------------------- 挂载
function attach(v) {
  video = v;
  playerRate = clampRate(v.playbackRate);
  reportPlayerRate();
  // 只在启用且有手柄时应用自定义倍速
  if (cfg.enabled && activePadId && !cfg.syncPlayer) applyBase(true);
  else cur = expected = playerRate;
  v.addEventListener('ratechange', onRateChange);
  // 字幕：之前已接管过就回到保存的状态（菜单可能晚于播放器渲染，交给主循环重试）
  subApplied = cfg.subIndex < 0;
  subTries = 0;
  if (!subApplied && restoreSub()) subApplied = true;
  if (cfg.hud) buildHud(v, hudAnchor(v));
}

function detach() {
  if (video) video.removeEventListener('ratechange', onRateChange);
  video = null;
  removeHud();
}
