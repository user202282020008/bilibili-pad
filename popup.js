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
  r3Dm: true,
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
let saveTimer = 0, savePending = null, failedSettings = null, saveInFlight = false;
function saveStatus(text, error = false) {
  const status = document.getElementById('saveStatus');
  status.textContent = text;
  status.dataset.state = error ? 'error' : 'normal';
  document.getElementById('save').hidden = !error;
}
function saveSettings(obj, immediate = false) {
  savePending = Object.assign(savePending || {}, obj);
  saveStatus('正在保存…');
  // 开关直接落盘，避免点击后立刻关闭弹窗时丢失；仅滑块输入防抖。
  if (immediate) {
    clearTimeout(saveTimer);
    flushSettings();
    return;
  }
  if (saveTimer) return;
  saveTimer = setTimeout(flushSettings, 200);
}
function flushSettings() {
  saveTimer = 0;
  if (saveInFlight || (!savePending && !failedSettings)) return;
  const obj = Object.assign({}, failedSettings || {}, savePending || {});
  savePending = null;
  failedSettings = null;
  saveInFlight = true;
  chrome.storage.sync.set(obj, () => {
    saveInFlight = false;
    const error = chrome.runtime && chrome.runtime.lastError;
    if (error) {
      failedSettings = obj;
      saveStatus('保存失败，请重试', true);
    } else {
      saveStatus('已保存 · 自动同步设置');
      notifyTab();
    }
    if (savePending) { clearTimeout(saveTimer); flushSettings(); }
  });
}
// 弹窗被关掉时挂起的写入会连同定时器一起消失，这里补一次立即落盘
function flushNow() {
  if (!savePending) return;
  clearTimeout(saveTimer);
  flushSettings();
}
function notifyTab(allowInject = true) {
  try {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tab = tabs && tabs[0];
      if (!tab || tab.id == null) return;
      chrome.tabs.sendMessage(tab.id, { type: 'pts-config' }, () => {
        if (!chrome.runtime.lastError) return;   // 页面里的脚本还活着，配置已实时下发
        // 收不到回应 = 那份脚本因为扩展重载失联了，直接补注入一份新的，
        // 这样改完设置 / 改完代码都不用再刷新 B 站页面
        if (!allowInject || !/^https:\/\/([\w-]+\.)*bilibili\.com\//.test(tab.url || '')) return;
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
        if (chrome.runtime.lastError) return;
        notifyTab(false);                        // 每次通知最多补注入一次
      }
    );
  } catch (e) { /* ignore */ }
}

function setBase(v, fromSlider) {
  if (cfg.syncPlayer) return;  // 跟随模式仅展示基准，不能隐式切换成自定义。
  const c = CUSTOM.base;
  const n = Math.min(c.max, Math.max(c.min, Number(v)));
  if (!isFinite(n)) return;
  cfg.base = n;
  const patch = { base: n };
  saveSettings(patch);
  if (!fromSlider) inputs.base.value = n;
  syncBase();
  syncModeRows();
}

function syncBase() {
  const sync = !!cfg.syncPlayer;
  inputs.syncPlayer.checked = sync;
  document.getElementById('fixedBase').checked = !sync;
  document.getElementById('followRate').hidden = !sync;
  document.getElementById('fixedRate').hidden = sync;
  document.getElementById('baseHint').textContent = sync
    ? '在播放器中选择倍速，扳机只做临时加减速。'
    : '启用控制时持续使用此倍速；扳机松开后恢复，支持精确输入。';
  inputs.base.disabled = sync;
  const row = document.getElementById('baseRow');
  if (row) row.classList.toggle('off', sync);
  // 同步播放器时，滑块直接反映网页播放器的倍速
  const shown = sync ? (playerRate || 1) : cfg.base;
  inputs.base.value = shown;
  const num = document.getElementById('baseNum');
  if (num) num.disabled = sync;
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
  document.getElementById('rtMaxV').disabled = rel;
  document.getElementById('rtMaxDeltaV').disabled = !rel;
  document.getElementById('ltMinV').disabled = acc;
  document.getElementById('fixedCap').hidden = rel;
  document.getElementById('relativeCap').hidden = !rel;
  document.getElementById('slowRate').hidden = acc;
  const base = cfg.syncPlayer ? (playerRate || 1) : cfg.base;
  document.getElementById('capHint').textContent = rel
    ? '默认 ' + trim(base) + 'x + ' + trim(cfg.rtMaxDelta) + 'x，最高 ' + trim(Math.min(16, base + cfg.rtMaxDelta)) + 'x。'
    : '按得越深越快，最高不低于默认倍速。';
  document.getElementById('ltHint').textContent = acc
    ? 'LT / RT 的力度叠加，共同向加速上限变化。'
    : 'LT 减速、RT 加速；同时按下时按力度差计算。';
  inputs.yCycle.disabled = !cfg.yFull;
  document.getElementById('enabledHint').textContent = cfg.enabled
    ? '已开启 · 设置即时生效' : '已暂停 · 设置保留，3 倍速仍可使用';
}

function render(next) {
  cfg = Object.assign({}, DEFAULTS, next || {});
  for (const k of Object.keys(DEFAULTS)) {
    const el = inputs[k];
    if (!el) continue;
    if (el.type === 'checkbox' || el.type === 'radio') el.checked = !!cfg[k];
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
  syncModeRows();
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.playerRate) {
    playerRate = changes.playerRate.newValue || 0;
    syncBase();
    syncModeRows();
  } else if (area === 'sync') {
    const next = Object.assign({}, cfg);
    for (const k of Object.keys(changes)) if (k in DEFAULTS) next[k] = changes[k].newValue;
    render(Object.assign(next, savePending || {}));
  }
});

for (const k of Object.keys(DEFAULTS)) {
  const el = inputs[k];
  if (!el) continue;
  el.addEventListener('input', () => {
    if (k === 'syncPlayer') { if (el.checked) selectBaseMode(true); return; }
    const v = el.type === 'checkbox' ? el.checked : Number(el.value);
    if (k === 'base') { setBase(v, true); return; }
    cfg[k] = v;
    const out = document.getElementById(k + 'V');
    syncModeRows();
    if (k === 'syncPlayer') syncBase();
    else if (out) {
      if (out.tagName === 'INPUT') out.value = trim(v);
      else if (FMT[k]) out.textContent = FMT[k](v);
    }
    saveSettings({ [k]: v }, el.type === 'checkbox');
  });
}

// 精确输入倍速（不受滑块步进限制，如 1.333）
document.getElementById('baseNum').addEventListener('change', (e) => {
  setBase(e.target.value, false);
});

function selectBaseMode(follow) {
  cfg.syncPlayer = follow;
  syncBase();
  syncModeRows();
  saveSettings({ syncPlayer: follow }, true);
}
document.getElementById('fixedBase').addEventListener('input', (event) => {
  if (event.target.checked) selectBaseMode(false);
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
    syncModeRows();
    saveSettings({ [k]: v });
  });
}

document.getElementById('reset').addEventListener('click', () => {
  clearTimeout(saveTimer);
  saveTimer = 0;
  savePending = null;
  failedSettings = null;
  render(DEFAULTS);
  saveSettings(DEFAULTS, true);
});

// 打开弹窗先确认页面里的脚本还活着：失联就补注入一份新脚本
notifyTab();

// 关弹窗时把挂起的写入立刻落盘（定时器会随弹窗一起销毁）
window.addEventListener('pagehide', flushNow);
document.addEventListener('visibilitychange', () => { if (document.hidden) flushNow(); });

document.getElementById('save').addEventListener('click', () => {
  saveStatus('正在保存…');
  clearTimeout(saveTimer);
  flushSettings();
});
