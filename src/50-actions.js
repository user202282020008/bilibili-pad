// ============================================================================
// 扳机倍速 · 按键功能
// 音量 / 默认倍速 / 暂停 / 字幕 / 宽屏 / 全屏。
// 依赖：00-core.js（状态）、40-gamepad.js（pressed / PAD）
// ============================================================================
'use strict';

// ---------------------------------------------------------------- 音量
// 方向键 ↑↓：按住后先走一步，再按固定间隔连发
function handleVolume(pad, now) {
  if (!cfg.dpadVol || !pad) { volDir = 0; return; }
  const dir = pressed(pad, PAD.UP) ? 1 : pressed(pad, PAD.DOWN) ? -1 : 0;
  if (!dir) { volDir = 0; return; }
  if (volDir !== dir) { volDir = dir; volNext = now + VOL_INITIAL_DELAY; stepVolume(dir, now); }
  else if (now >= volNext) { volNext = now + VOL_REPEAT_DELAY; stepVolume(dir, now); }
}

function stepVolume(dir, now) {
  if (!video) return;
  const v = clamp((video.volume || 0) + dir * VOL_STEP, 0, 1);
  try {
    video.volume = v;
    if (dir > 0 && v > 0) video.muted = false;
  } catch (e) { /* ignore */ }
  flash(video.muted ? '已静音' : '音量 ' + Math.round(v * 100) + '%', now);
}

// ---------------------------------------------------------------- 默认倍速
// 方向键 ←→：每次 ±0.25，按下沿触发，按住不连发
function handleRateStep(pad, now) {
  if (!cfg.dpadRate || !pad) { rateDir = 0; return; }
  const dir = pressed(pad, PAD.RIGHT) ? 1 : pressed(pad, PAD.LEFT) ? -1 : 0;
  if (dir && dir !== rateDir) {
    setBaseRate(clampRate(cfg.base) + dir * RATE_STEP);
    flash('默认倍速 ' + q2(cfg.base).toFixed(2) + 'x', now);
  }
  rateDir = dir;
}

// 改默认倍速：退出跟随模式，立刻套用并保存
function setBaseRate(v) {
  cfg.base = clamp(q2(v), BASE_MIN, BASE_MAX);
  cfg.syncPlayer = false;             // 手动调了就按自定义值来
  forceBase = true;                   // 下一帧套用
  try { chrome.storage.sync.set({ base: cfg.base, syncPlayer: false }); } catch (e) { /* ignore */ }
}

// ---------------------------------------------------------------- 快退 / 快进
// A / B：±10 秒，按下沿触发，按住不重复
function fmtTime(t) {
  const s = Math.max(0, Math.floor(t));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const p = (n) => (n < 10 ? '0' + n : '' + n);
  return h ? h + ':' + p(m) + ':' + p(sec) : m + ':' + p(sec);
}

function seekBy(delta, now) {
  if (!video || !isFinite(video.duration)) return;    // 直播 / 时长未知时不动
  const t = clamp((video.currentTime || 0) + delta, 0, video.duration);
  try { video.currentTime = t; } catch (e) { return; }
  flash((delta < 0 ? '快退 ' : '快进 ') + Math.abs(delta) + 's · ' + fmtTime(t), now);
}

function handleSeek(pad, now) {
  const a = !!(pad && cfg.abSeek && pressed(pad, PAD.A));
  if (a && !aPrev) seekBy(-SEEK_STEP, now);
  aPrev = a;

  const b = !!(pad && cfg.abSeek && pressed(pad, PAD.B));
  if (b && !bPrev) seekBy(SEEK_STEP, now);
  bPrev = b;
}

// ---------------------------------------------------------------- 暂停 / 继续
// 左肩键 L1：按下沿触发，按住不重复
function handlePause(pad, now) {
  const lb = !!(pad && cfg.lbPause && pressed(pad, PAD.L1));
  if (lb && !lbPrev) {
    const wasPaused = !!(video && video.paused);
    if (video) {
      try {
        if (wasPaused) { const p = video.play(); if (p && p.catch) p.catch(() => {}); }
        else video.pause();
      } catch (e) { /* ignore */ }
    }
    flash(wasPaused ? '继续播放' : '已暂停', now);
  }
  lbPrev = lb;
}

// ---------------------------------------------------------------- 字幕
// 真实字幕轨道列表走 B 站接口，DOM 只负责点菜单项切换、CSS 负责兜底隐藏

function clickEl(el) {
  try {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
  } catch (e) {
    try { el.click(); } catch (e2) { /* ignore */ }
  }
}

const PLAYER_OWNER = '.bpx-player-container, .bilibili-player, #bilibili-player';
// 控制条上的字幕按钮（各版本播放器）。只认精确类名，写 [aria-label*="字幕"] 会误匹配设置面板。
const SUB_BTN = '.bpx-player-ctrl-subtitle, .bilibili-player-video-btn-subtitle,'
  + ' .squirtle-subtitle-wrap>button';
const SUB_ITEM = '.bpx-player-ctrl-subtitle-language-item';

function playerRoot() {
  return (video && video.closest && video.closest(PLAYER_OWNER)) || document;
}

// ---------------------------------------------------------------- 真实字幕轨道
// 列表直接从 B 站接口拿（view → aid/cid → player/v2），不扫 DOM 猜结构：
// 播放器设置面板里有固定的 24 种语言模板，会把「没有字幕」误判成「25 个状态」。
// 切换时按 data-lan 精确点菜单项；关字幕用 CSS 兜底（点语言项不会取消，只会重复弹提示）。
let subData = undefined;      // { lans: [{lan, doc}], current } | undefined=未加载
let subDataKey = null;        // 已加载的视频标识（bvid:p）
let subDataLoading = false;

function currentBvid() {
  return (location.pathname.match(/BV[0-9A-Za-z]+/) || [])[0] || null;
}

// 重置字幕状态（SPA 切换视频时调用）
function resetSubState() {
  subData = undefined;
  subDataKey = null;
  subDataLoading = false;
  subJob = null;
  subJobTries = 0;
}

async function loadSubData() {
  const bvid = currentBvid();
  if (!bvid || subDataLoading) return;
  const p = Number(new URLSearchParams(location.search).get('p') || 1) || 1;
  const key = bvid + ':' + p;
  if (subData !== undefined && subDataKey === key) return;
  subDataLoading = true;
  let out = { lans: [], current: '' };
  try {
    const vj = await (await fetch('https://api.bilibili.com/x/web-interface/view?bvid=' + bvid, { credentials: 'include' })).json();
    const d = vj && vj.data;
    const pages = (d && d.pages) || [];
    const page = pages[clamp(p - 1, 0, Math.max(0, pages.length - 1))] || null;
    const aid = d && d.aid, cid = page ? page.cid : (d && d.cid);
    if (aid && cid) {
      const pj = await (await fetch('https://api.bilibili.com/x/player/v2?aid=' + aid + '&cid=' + cid, { credentials: 'include' })).json();
      const sub = pj && pj.data && pj.data.subtitle;
      out = {
        lans: (sub && sub.subtitles ? sub.subtitles : []).map((s) => ({ lan: s.lan, doc: s.lan_doc || s.lan })),
        current: (sub && sub.lan) || '',
      };
    }
  } catch (e) { /* 网络 / 解析失败 → 退回两态 */ }
  subData = out;
  subDataKey = key;
  subDataLoading = false;
}

function ensureSubData() {
  if (subData !== undefined || subDataLoading) return;
  loadSubData();
}

function subTracks() { return subData ? subData.lans : []; }
function subTotal() { return Math.max(2, subTracks().length + 1); }
function currentSubIndex() {
  const cur = subData ? subData.current : '';
  if (!cur) return 0;
  const i = subTracks().findIndex((t) => t.lan === cur);
  return i >= 0 ? i + 1 : 0;
}

function isActive(el) {
  const c = el && el.classList;
  if (c && (c.contains('active') || c.contains('bpx-player-ctrl-subtitle-language-item-active'))) return true;
  return !!(el && el.getAttribute && el.getAttribute('aria-checked') === 'true');
}

// 在播放器里按 data-lan 精确找菜单项（优先自己播放器，菜单 portal 到页面级就兜底全页）
function findSubItem(lan) {
  if (!lan) return null;
  const search = (scope) => {
    let list;
    try { list = scope.querySelectorAll(SUB_ITEM); } catch (e) { return null; }
    for (const el of list) {
      if (el.getAttribute && el.getAttribute('data-lan') === lan) return el;
    }
    return null;
  };
  const root = playerRoot();
  return search(root) || (root !== document ? search(document) : null);
}

// 控制条上的字幕按钮（有它就说明这个视频有字幕轨）
function subButton() {
  try { return playerRoot().querySelector(SUB_BTN) || null; } catch (e) { return null; }
}

// 菜单项是懒渲染的：找不到就先替用户展开一次菜单
function openSubMenu() {
  const btn = subButton();
  if (!btn) return false;
  clickEl(btn);
  return true;
}

function closeSubMenu() {
  const btn = subButton();
  if (btn) {
    try {
      btn.dispatchEvent(new MouseEvent('mouseleave', { bubbles: true }));
      // 额外延迟关闭，确保点击已生效
      setTimeout(() => {
        try { btn.dispatchEvent(new MouseEvent('mouseleave', { bubbles: true })); } catch (e) { /* ignore */ }
      }, 200);
    } catch (e) { /* ignore */ }
  }
}

// B 站切换字幕后会弹一条「字幕已切换至 xx」提示，而且常常自己卡住不消失。
// HUD 里已经报了字幕状态，这条是多余的 —— 只认这条文案，顺手把它抹掉（不碰别的提示）。
function suppressSubToast() {
  // 限制扫描范围到播放器容器，避免全页查询影响性能
  const root = playerRoot();
  if (!root) return;

  let list;
  try {
    // 只扫描可能包含提示的元素，不查询所有 div/span/p
    list = root.querySelectorAll('[class*="toast"], [class*="tip"], [class*="message"], [class*="notice"]');
  } catch (e) { return; }

  for (const box of list) {
    // 在提示容器内查找匹配文本
    const text = box.textContent || '';
    if (/字幕.{0,6}(切换|已切换)/.test(text)) {
      try { box.style.display = 'none'; } catch (e) { /* ignore */ }
    }
  }
}

// 套用某个字幕状态（0 = 关）
function applySubState(idx) {
  const root = document.documentElement;
  const tracks = subTracks();
  const n = Math.max(2, tracks.length + 1);
  const i = clamp(Math.round(idx) || 0, 0, n - 1);

  if (i === 0) {
    if (root) root.classList.add('pts-sub-off');
    subStateLabel = '字幕：关';
    return;
  }
  if (root) root.classList.remove('pts-sub-off');
  const t = tracks[i - 1];
  subStateLabel = '字幕：' + (t ? t.doc : (tracks.length ? '字幕 ' + i : '开'));
  if (!t) return;
  const el = findSubItem(t.lan);
  if (el) {
    // 延迟点击，确保菜单完全渲染（B 站菜单有时异步加载）
    if (!isActive(el)) {
      setTimeout(() => {
        if (findSubItem(t.lan)) {  // 再次确认元素仍存在
          clickEl(el);
          suppressSubToast();
          subToastSweep = SUB_TOAST_SWEEP_FRAMES;
        }
      }, SUB_CLICK_DELAY);
    }
  } else if (openSubMenu()) {
    subJob = { kind: 'lan', lan: t.lan };
    subJobTries = SUB_JOB_MENU_TRIES;   // 菜单渲染好后再点（见 flushSubJob）
  }
}

// 恢复到已保存的字幕状态；轨道列表还没加载好时返回 false，稍后重试
function restoreSub() {
  if (cfg.subIndex < 0) return true;         // 尚未接管，不去动用户的字幕
  if (subData === undefined) { ensureSubData(); return false; }
  applySubState(cfg.subIndex);
  return true;
}

function cycleSubtitle(now) {
  const total = subTotal();
  const base = cfg.subIndex >= 0 ? cfg.subIndex : currentSubIndex();
  const next = (clamp(base, 0, total - 1) + 1) % total;
  cfg.subIndex = next;
  applySubState(next);
  subApplied = true;
  try { chrome.storage.sync.set({ subIndex: next }); } catch (e) { /* ignore */ }
  flash(subStateLabel, now);
}

// 右肩键 R1：在「关 → 语言1 → 语言2 … → 关」之间循环，并保存当前状态
function handleSubtitle(pad, now) {
  const rb = !!(pad && cfg.rbSub && pressed(pad, PAD.R1));
  if (rb && !rbPrev) {
    if (subData === undefined) {
      // 还没拿到真实轨道列表：先去抓，抓到了再把这一下按键补上（见 flushSubJob）
      ensureSubData();
      subJob = { kind: 'advance' };
      subJobTries = SUB_JOB_MAX_TRIES;
    } else {
      cycleSubtitle(now);
    }
  }
  rbPrev = rb;
}

// 补上「数据没回来 / 菜单没渲染好」时的动作
function flushSubJob(now) {
  if (!subJob) return;
  if (--subJobTries <= 0) {
    const job = subJob;
    subJob = null;
    if (job.kind === 'advance') cycleSubtitle(now);   // 抓不到轨道列表 → 退回两态切一次
    return;
  }
  if (subJob.kind === 'advance') {
    if (subData !== undefined) { subJob = null; cycleSubtitle(now); }
  } else {
    const el = findSubItem(subJob.lan);
    if (el) {
      // 找到菜单项后延迟点击，确保完全渲染
      setTimeout(() => {
        const item = findSubItem(subJob.lan);
        if (item && !isActive(item)) {
          clickEl(item);
          suppressSubToast();
          subToastSweep = SUB_TOAST_SWEEP_FRAMES;
        }
      }, SUB_CLICK_DELAY);
      subJob = null;
      closeSubMenu();   // 菜单是为了拿菜单项才展开的，点完收起来
    }
  }
}

// ---------------------------------------------------------------- 宽屏 / 全屏
// 点击播放器控制条上的按钮（新旧播放器两套选择器）
const CTRL = {
  wide: ['.bpx-player-ctrl-wide', '.bilibili-player-ctrl-wide', '.bilibili-player-video-btn-wide'],
  web: ['.bpx-player-ctrl-web', '.bilibili-player-ctrl-web', '.bilibili-player-video-btn-web',
    '.bilibili-player-video-web-fullscreen'],
  full: ['.bpx-player-ctrl-full', '.bilibili-player-ctrl-full', '.bilibili-player-video-btn-full'],
};

function clickCtrl(list) {
  for (const sel of list) {
    try {
      const el = document.querySelector(sel);
      if (el) { el.click(); return true; }
    } catch (e) { /* ignore */ }
  }
  return false;
}

// X：宽屏模式（返回要提示的文字，点不到就返回 null）
function toggleWide() {
  if (!clickCtrl(CTRL.wide)) return null;
  return '宽屏';
}

// Y：全屏播放（先点播放器的全屏按钮，点不到就用 Fullscreen API）
function toggleFullscreen() {
  if (document.fullscreenElement || document.webkitFullscreenElement) {
    try {
      const exit = document.exitFullscreen || document.webkitExitFullscreen;
      if (exit) exit.call(document);
    } catch (e) { /* ignore */ }
    return '退出全屏';
  }
  if (clickCtrl(CTRL.full)) return '全屏';
  const el = (video && video.closest(
    '.bpx-player-container, .bpx-player-video-area, .bilibili-player, #bilibili-player'
  )) || document.documentElement;
  try {
    const req = el.requestFullscreen || el.webkitRequestFullscreen;
    if (req) { const p = req.call(el); if (p && p.catch) p.catch(() => {}); }
  } catch (e) { /* ignore */ }
  return '全屏';
}

// ---------------------------------------------------------------- 播放模式循环（Y 键可选）
// 默认 → 宽屏 → 网页全屏 → 全屏 → 默认
const VIEW_NAMES = ['默认模式', '宽屏', '网页全屏', '全屏'];

// 实测（CDP 探针 2026-10）：宽屏不改容器/body class，只在按钮上标 bpx-state-entered；
// 网页全屏容器加 mode-webscreen（body 加 webscreen-fix）；全屏用 fullscreenElement 判断
function ctrlEntered(list) {
  for (const sel of list) {
    try {
      const el = document.querySelector(sel);
      if (el && el.classList && el.classList.contains('bpx-state-entered')) return true;
    } catch (e) { /* ignore */ }
  }
  return false;
}

function detectViewMode() {
  if (document.fullscreenElement || document.webkitFullscreenElement) return 3;
  const el = video && video.closest(PLAYER_OWNER);
  const cls = el && typeof el.className === 'string' ? el.className : '';
  if (/webscreen|web-full/i.test(cls) || ctrlEntered(CTRL.web)) return 2;
  if (/mode-wide|widescreen/i.test(cls) || ctrlEntered(CTRL.wide)) return 1;
  return 0;
}

function enterFullscreen() {
  if (clickCtrl(CTRL.full)) return;
  const el = (video && video.closest(
    '.bpx-player-container, .bpx-player-video-area, .bilibili-player, #bilibili-player'
  )) || document.documentElement;
  try {
    const req = el.requestFullscreen || el.webkitRequestFullscreen;
    if (req) { const p = req.call(el); if (p && p.catch) p.catch(() => {}); }
  } catch (e) { /* ignore */ }
}

function exitToDefault(from) {
  if (from === 3) {
    try {
      const exit = document.exitFullscreen || document.webkitExitFullscreen;
      if (exit) exit.call(document);
    } catch (e) { /* ignore */ }
    // 退出原生全屏后会退回网页全屏，稍后再点一下 web 按钮收干净
    setTimeout(() => { if (detectViewMode() === 2) clickCtrl(CTRL.web); }, 250);
  } else if (from === 2) {
    clickCtrl(CTRL.web);
  } else if (from === 1) {
    clickCtrl(CTRL.wide);
  }
}

function cycleViewMode(now) {
  const next = (detectViewMode() + 1) % 4;
  if (next === 1) clickCtrl(CTRL.wide);
  else if (next === 2) clickCtrl(CTRL.web);
  else if (next === 3) enterFullscreen();
  else exitToDefault((next + 3) % 4);
  flash('播放模式：' + VIEW_NAMES[next], now);
}

// X / Y：按下沿触发，按住不重复
function handleKeys(pad, now) {
  const x = !!(pad && cfg.xWide && pressed(pad, PAD.X));
  if (x && !xPrev) { const t = toggleWide(); if (t) flash(t, now); }
  xPrev = x;

  const y = !!(pad && cfg.yFull && pressed(pad, PAD.Y));
  if (y && !yPrev) {
    if (cfg.yCycle) cycleViewMode(now);
    else { const t = toggleFullscreen(); if (t) flash(t, now); }
  }
  yPrev = y;
}
