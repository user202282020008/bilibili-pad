// ============================================================================
// 扳机倍速 · 核心层
// 常量、工具函数、共享状态。
//
// 说明：本扩展的 content 脚本按 manifest.json 里 content_scripts[].js 的顺序注入，
//       同一帧内它们共处一个隔离作用域（isolated world），后面文件能直接使用
//       前面文件声明的顶层变量/函数。因此拆分文件时请勿重名。
// ============================================================================
'use strict';

// ---------------------------------------------------------------- 配置默认值
const DEFAULTS = {
  enabled: true,     // 总开关
  rtMax: 3,          // RT 全力按压时的倍速
  rtMaxRel: false,   // RT 上限跟随默认倍速（= 默认倍速 + rtMaxDelta）
  rtMaxDelta: 3,     // RT 上限相对默认倍速的偏移量
  ltMin: 0.25,       // LT 全力按压时的倍速
  ltAccel: false,    // LT 也加速（与 RT 叠加向最高速）
  syncPlayer: true,  // 默认倍速跟随网页播放器的倍速
  base: 1,           // 关闭同步时的自定义默认倍速
  deadzone: 0.08,    // 扳机死区（0~0.5）
  smooth: 0.08,      // 平滑时间常数（秒），0 = 无平滑
  hud: true,         // 显示画面提示
  swap: false,       // 交换 LT / RT
  dpadVol: true,     // 方向键上/下调音量
  dpadRate: true,    // 方向键左/右调默认倍速（每次 0.25）
  abSeek: true,      // A / B 键 快退 / 快进 10 秒
  lbPause: true,     // 左肩键 L1 暂停 / 继续
  rbSub: true,       // 右肩键 R1 循环切换字幕
  xWide: true,       // X 键开关宽屏
  yFull: true,       // Y 键开关全屏
  yCycle: false,     // Y 键循环四种播放模式（默认/宽屏/网页全屏/全屏），替代全屏开关
  subIndex: -1,      // 字幕状态：-1=尚未接管，0=关，1..n=第 n 条字幕（R1 循环并保存）
  v2: true,          // 配置版本标记（旧版 useBase 迁移用）
};

// ---------------------------------------------------------------- 常量
const VOL_STEP = 0.05;    // 方向键 ↑↓ 每次调整的音量
const RATE_STEP = 0.25;   // 方向键 ←→ 每次调整的默认倍速量
const SEEK_STEP = 10;     // A / B 键每次快退 / 快进的秒数
const BASE_MIN = 0.25;    // 默认倍速下限（与弹窗一致）
const BASE_MAX = 8;       // 默认倍速上限
const MIN_RATE = 0.1;
const MAX_RATE = 16;

// 定时与重试常量
const SCAN_INTERVAL = 30;           // 播放器扫描间隔（帧数）
const SUB_RESTORE_INTERVAL = 30;    // 字幕恢复重试间隔（帧数）
const SUB_RESTORE_MAX_TRIES = 40;   // 字幕恢复最大重试次数
const SUB_JOB_MAX_TRIES = 150;      // 字幕任务最大等待帧数（接口响应）
const SUB_JOB_MENU_TRIES = 30;      // 字幕菜单渲染等待帧数（从20增加到30）
const SUB_TOAST_SWEEP_FRAMES = 5;   // 清除字幕提示的扫描帧数
const FLASH_DURATION = 900;         // HUD 闪烁提示持续时间（毫秒）
const FLASH_DURATION_LONG = 2500;   // 手柄连接提示持续时间（毫秒）
const ACTIVITY_TIMEOUT = 900;       // HUD 活动超时隐藏时间（毫秒）
const VOL_INITIAL_DELAY = 280;      // 音量按键首次触发延迟（毫秒）
const VOL_REPEAT_DELAY = 110;       // 音量按键连发间隔（毫秒）
const RATE_CHANGE_WINDOW = 250;     // 倍速变更检测窗口（毫秒）
const PLAYER_SYNC_THRESHOLD = 300;  // 播放器同步判断的空闲阈值（毫秒）
const SUB_CLICK_DELAY = 50;         // 字幕菜单项点击延迟（毫秒，确保菜单完全渲染）
const RATE_DRIFT_CHECK_INTERVAL = 60; // 倍速漂移检查间隔（帧数）

// ---------------------------------------------------------------- 运行时配置
const cfg = Object.assign({}, DEFAULTS);

// ---------------------------------------------------------------- 小工具
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const clampRate = (v) => clamp(v || 1, MIN_RATE, MAX_RATE);
// 写入视频的倍速保留两位小数：B 站会原样显示 playbackRate（如 1.8319481...倍速），
// 全精度浮点会把它的控制栏挤爆
const q2 = (v) => Math.round(v * 100) / 100;

// 直播页不做变速（真正的跳过在 90-app.js 的 boot 里）
const PTS_LIVE = location.pathname.startsWith('/live') || !!document.querySelector('.live-player-ctnr');

// ---------------------------------------------------------------- 实例存活
// 扩展被「重新加载」后（chrome://extensions 点刷新），已经打开的页面里这份旧脚本
// 会和扩展失去联系：storage 监听全部失效，但它还在跑、还在按旧配置控制播放器。
// 所以每帧问一次「我还活着吗」，一旦失联立刻停手；新脚本由弹窗自动补注入。
const INSTANCE = { dead: false };

function contextAlive() {
  try { return !chrome.runtime || !!chrome.runtime.id; } catch (e) { return false; }
}

// 同一页面若被补注入了一份新脚本，旧实例收到通知就让位，避免两份脚本抢播放器
function claimInstance() {
  try {
    window.__ptsInstance = INSTANCE;
    window.dispatchEvent(new Event('pts-takeover'));
  } catch (e) { /* ignore */ }
}
try {
  window.addEventListener('pts-takeover', () => {
    if (window.__ptsInstance !== INSTANCE) INSTANCE.dead = true;
  });
} catch (e) { /* ignore */ }
// 先挂好自己的监听，再广播接管，让页面里可能存在的旧实例让位
claimInstance();

function instanceAlive() {
  return !INSTANCE.dead && contextAlive();
}

// ---------------------------------------------------------------- 共享状态
let video = null;
let playerRate = 1;      // 网页播放器自身设定的倍速（读出来，供弹窗显示）
let reported = -1;       // 已上报的 playerRate
let expected = 1;        // 我们最后一次写入的值
let cur = 1;             // 平滑后的当前值
let forceBase = false;   // 默认倍速设置改动后需立刻写入
let writeAt = -1e9;      // 最近一次写入倍速的时间戳（用来判断是谁改的倍速）
let triggerHeld = false; // 当前是否有扳机输入
let kbdBoost = false;    // 键盘正长按 →（B 站官方临时加速），期间让出倍速控制权
let lastActivity = -1e9;

let volDir = 0, volNext = 0;
let rateDir = 0;
let lbPrev = false, rbPrev = false, xPrev = false, yPrev = false, aPrev = false, bPrev = false;
let subStateLabel = '字幕：关';
let subApplied = true, subTries = 0;   // 本轮挂载是否已恢复字幕状态
let subToastSweep = 0;                 // 还有几帧要去清 B 站的「字幕已切换至 xx」提示
// 字幕待办：'advance' 等接口返回真实轨道列表后切一下；'lan' 等菜单渲染好后点对应语言
let subJob = null, subJobTries = 0;

// URL 变化监听：SPA 切换视频时重置字幕状态
let lastUrl = location.href;

// HUD 上那句提示：谁最后动作就显示谁（别用固定优先级，否则新动作会被旧提示盖住）
let flashText = '', flashUntil = 0;
function flash(text, now, ms) { flashText = text; flashUntil = now + (ms || FLASH_DURATION); }

let activePadId = null;
let lastFrame = 0;
let scanTick = 0;

// HUD 元素引用
let hud = null, hudSpeed = null, hudLt = null, hudRt = null, hudPad = null;
