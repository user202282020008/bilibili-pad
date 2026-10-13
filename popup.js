'use strict';

const DEFAULTS = {
  enabled: true,
  rtMax: 3,
  rtMaxRel: false,
  rtMaxDelta: 3,
  ltMin: 0.25,
  ltAccel: false,
  syncPlayer: true,
  base: 1,
  deadzone: 0.08,
  smooth: 0.08,
  hud: true,
  swap: false,
  dpadVol: true,
  dpadRate: true,
  abSeek: true,
  lbPause: true,
  rbSub: true,
  xWide: true,
  yFull: true,
  yCycle: false,
  subIndex: -1,
  v2: true,
};

const trim = (v) => String(Number(v.toFixed(3))); // 1.50 → 1.5，1.333 原样保留

const FMT = {
  rtMax: (v) => trim(v) + 'x',
  rtMaxDelta: (v) => '+' + trim(v) + 'x',
  ltMin: (v) => trim(v) + 'x',
  base: (v) => trim(v) + 'x',
  deadzone: (v) => trim(v),
  smooth: (v) => (v === 0 ? '关闭' : trim(v) + 's'),
};

const inputs = {};
for (const k of Object.keys(DEFAULTS)) inputs[k] = document.getElementById(k);

let playerRate = 0;   // 网页播放器当前倍速（由 content script 上报）
let cfg = Object.assign({}, DEFAULTS);

const CUSTOM = { base: { min: 0.25, max: 8 } };  // 允许超出滑块范围的精确值

// 设置写入：合并高频改动（拖滑块会连发 input 事件，会撞 storage.sync 的写入频率配额），
// 落盘后主动通知当前标签页重读，做到免刷新即时生效
let saveTimer = 0, savePending = null;
function saveSettings(obj) {
  savePending = Object.assign(savePending || {}, obj);
  if (saveTimer) return;
  saveTimer = setTimeout(flushSettings, 200);
}
function flushSettings() {
  saveTimer = 0;
  const obj = savePending || {};
  savePending = null;
  chrome.storage.sync.set(obj, notifyTab);
}
// 弹窗被关掉时挂起的写入会连同定时器一起消失，这里补一次立即落盘
function flushNow() {
  if (!saveTimer || !savePending) return;
  clearTimeout(saveTimer);
  flushSettings();
}
function notifyTab() {
  try {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tab = tabs && tabs[0];
      if (!tab || tab.id == null) return;
      chrome.tabs.sendMessage(tab.id, { type: 'pts-config' }, () => {
        if (!chrome.runtime.lastError) return;   // 页面里的脚本还活着，配置已实时下发
        // 收不到回应 = 那份脚本因为扩展重载失联了，直接补注入一份新的，
        // 这样改完设置 / 改完代码都不用再刷新 B 站页面
        if (!tab.url) return;                    // 不是 B 站页面（无权限看 url），不注入
        injectContentScript(tab.id);
      });
    });
  } catch (e) { /* 环境不支持时忽略，storage.onChanged 仍会生效 */ }
}

function injectContentScript(tabId) {
  try {
    const cs = (chrome.runtime.getManifest().content_scripts || [])[0] || {};
    const files = cs.js || [];
    if (!files.length) return;
    chrome.scripting.executeScript(
      { target: { tabId, allFrames: !!cs.all_frames }, files },
      () => {
        void chrome.runtime.lastError;
        notifyTab();                             // 新脚本就位后再推一次配置
      }
    );
  } catch (e) { /* ignore */ }
}

function setBase(v, fromSlider) {
  const c = CUSTOM.base;
  const n = Math.min(c.max, Math.max(c.min, Number(v)));
  if (!isFinite(n)) return;
  cfg.base = n;
  const patch = { base: n };
  if (cfg.syncPlayer) {           // 动了默认倍速就自动退出同步模式
    cfg.syncPlayer = false;
    inputs.syncPlayer.checked = false;
    patch.syncPlayer = false;
  }
  saveSettings(patch);
  if (!fromSlider) inputs.base.value = n;
  syncBase();
}

function syncBase() {
  const sync = !!cfg.syncPlayer;
  inputs.base.disabled = sync;
  const row = document.getElementById('baseRow');
  if (row) row.classList.toggle('off', sync);
  // 同步播放器时，滑块直接反映网页播放器的倍速
  const shown = sync ? (playerRate || 1) : cfg.base;
  inputs.base.value = shown;
  const num = document.getElementById('baseNum');
  if (num && document.activeElement !== num) num.value = trim(shown);
  const live = document.getElementById('playerRateV');
  if (live) live.textContent = playerRate ? FMT.base(playerRate) : '—';
}

// 互斥/联动控件：跟随上限开启时固定值失效；LT 加速时 LT 最慢失效
function syncModeRows() {
  const rel = !!cfg.rtMaxRel, acc = !!cfg.ltAccel;
  const dim = (id, off) => { const el = document.getElementById(id); if (el) el.classList.toggle('off', off); };
  dim('rtMaxRow', rel);
  dim('rtMaxDeltaRow', !rel);
  dim('ltMinRow', acc);
  if (inputs.rtMax) inputs.rtMax.disabled = rel;
  if (inputs.rtMaxDelta) inputs.rtMaxDelta.disabled = !rel;
  if (inputs.ltMin) inputs.ltMin.disabled = acc;
}

function render(next) {
  cfg = Object.assign({}, DEFAULTS, next || {});
  for (const k of Object.keys(DEFAULTS)) {
    const el = inputs[k];
    if (!el) continue;
    if (el.type === 'checkbox') el.checked = !!cfg[k];
    else if (k !== 'base' && k !== 'subIndex') {
      el.value = cfg[k];
      const out = document.getElementById(k + 'V');
      if (!out) continue;
      if (out.tagName === 'INPUT') out.value = trim(cfg[k]);   // 精确输入框
      else out.textContent = FMT[k](Number(cfg[k]));
    }
  }
  syncBase();
  syncModeRows();
}

chrome.storage.sync.get(DEFAULTS, (v) => {
  // 旧版 useBase 迁移（get(DEFAULTS) 会填默认值，故用 v2 一次性标记判断）
  if (v && v.v2 !== true && v.useBase !== undefined) {
    v.syncPlayer = !v.useBase;
    v.v2 = true;
    chrome.storage.sync.set({ syncPlayer: v.syncPlayer, v2: true });
    chrome.storage.sync.remove('useBase');
  }
  render(v);
});
chrome.storage.local.get({ playerRate: 0 }, (v) => {
  playerRate = v.playerRate || 0;
  syncBase();
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes.playerRate) { playerRate = changes.playerRate.newValue || 0; syncBase(); }
});

for (const k of Object.keys(DEFAULTS)) {
  const el = inputs[k];
  if (!el) continue;
  el.addEventListener('input', () => {
    const v = el.type === 'checkbox' ? el.checked : Number(el.value);
    if (k === 'base') { setBase(v, true); return; }   // 拖滑块即退出同步模式
    cfg[k] = v;
    const out = document.getElementById(k + 'V');
    if (k === 'rtMaxRel' || k === 'ltAccel') syncModeRows();
    if (k === 'syncPlayer') syncBase();
    else if (out) {
      if (out.tagName === 'INPUT') out.value = trim(v);
      else if (FMT[k]) out.textContent = FMT[k](v);
    }
    saveSettings({ [k]: v });
  });
}

// 精确输入倍速（不受滑块步进限制，如 1.333）
document.getElementById('baseNum').addEventListener('change', (e) => {
  setBase(e.target.value, false);
});

for (const [id, k, lo, hi] of [['rtMaxV', 'rtMax', 1, 16], ['ltMinV', 'ltMin', 0.1, 1], ['rtMaxDeltaV', 'rtMaxDelta', 0.5, 15]]) {
  const el = document.getElementById(id);
  if (!el) continue;
  el.addEventListener('change', () => {
    const n = Number(el.value);
    if (!isFinite(n)) { el.value = trim(cfg[k]); return; }
    const v = Math.min(hi, Math.max(lo, n));
    cfg[k] = v;
    if (inputs[k]) inputs[k].value = v;
    el.value = trim(v);
    saveSettings({ [k]: v });
  });
}

document.getElementById('reset').addEventListener('click', () => {
  chrome.storage.sync.set(DEFAULTS, () => { render(DEFAULTS); notifyTab(); });
});

// 打开弹窗先确认页面里的脚本还活着：失联就补注入一份新脚本
notifyTab();

// 关弹窗时把挂起的写入立刻落盘（定时器会随弹窗一起销毁）
window.addEventListener('pagehide', flushNow);
document.addEventListener('visibilitychange', () => { if (document.hidden) flushNow(); });

document.getElementById('save').addEventListener('click', (e) => {
  const btn = e.currentTarget;
  btn.textContent = '已保存 ✓';
  setTimeout(() => (btn.textContent = '同步到云'), 1200);
});
