// ============================================================================
// 扳机倍速 · 配置层
// 读取 / 迁移 / 实时同步 chrome.storage.sync 里的设置。
// 依赖：00-core.js（DEFAULTS / cfg / forceBase / subApplied）
//       50-actions.js（applySubState，异步回调时才调用，此时已定义）
// ============================================================================
'use strict';

// 初次载入 + 旧版本配置迁移
function loadConfig() {
  try {
    chrome.storage.sync.get(DEFAULTS, (v) => {
      Object.assign(cfg, v || {});
      // 旧版 useBase 迁移：get(DEFAULTS) 会把 syncPlayer 填成默认值，
      // 所以只能用一次性标记 v2 判断是否需要迁移
      if (v && v.v2 !== true && v.useBase !== undefined) {
        cfg.syncPlayer = !v.useBase;
        try {
          chrome.storage.sync.set({ syncPlayer: cfg.syncPlayer, v2: true });
          chrome.storage.sync.remove('useBase');
        } catch (e) { /* ignore */ }
      }
      // 旧版 subOn（布尔开关）迁移到 subIndex
      if (v && v.subOn !== undefined) {
        cfg.subIndex = v.subOn ? 1 : 0;
        try { chrome.storage.sync.remove('subOn'); } catch (e) { /* ignore */ }
      }
      forceBase = true;   // 配置到位后立刻套用默认倍速
    });
  } catch (e) { /* storage 不可用时用默认值 */ }
}

// 重读一次最新配置（弹窗通知 / 页面重新可见时调用）
function pullConfig() {
  try {
    chrome.storage.sync.get(DEFAULTS, (v) => {
      if (!v) return;
      const b0 = cfg.base, s0 = cfg.syncPlayer, u0 = cfg.subIndex;
      for (const k of Object.keys(DEFAULTS)) if (k in v) cfg[k] = v[k];
      if (cfg.base !== b0 || cfg.syncPlayer !== s0) forceBase = true;
      if (cfg.subIndex !== u0) { applySubState(cfg.subIndex); subApplied = true; }
    });
  } catch (e) { /* ignore */ }
}

// 弹窗改设置 → 立即生效（主通道）
function watchConfigChanges() {
  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'sync') return;
      for (const k of Object.keys(changes)) if (k in cfg) cfg[k] = changes[k].newValue;
      if (changes.base || changes.syncPlayer || changes.useBase) forceBase = true;
      if (changes.subIndex) { applySubState(cfg.subIndex); subApplied = true; }
    });
  } catch (e) { /* ignore */ }
}

// 弹窗主动通知 / 页面重新可见时重读（兜底，防止漏掉 onChanged）
function watchConfigFallbacks() {
  try {
    if (chrome.runtime && chrome.runtime.onMessage) {
      chrome.runtime.onMessage.addListener((m, sender, sendResponse) => {
        if (!m || m.type !== 'pts-config') return;
        pullConfig();
        // 回一声「我在」，弹窗据此判断页面里还有没有活着的脚本
        if (sendResponse) sendResponse({ ok: true });
      });
    }
  } catch (e) { /* ignore */ }
  try { if (window.addEventListener) window.addEventListener('focus', pullConfig); } catch (e) { /* ignore */ }
  try {
    if (document.addEventListener) {
      document.addEventListener('visibilitychange', () => { if (!document.hidden) pullConfig(); });
    }
  } catch (e) { /* ignore */ }
}

loadConfig();
watchConfigChanges();
watchConfigFallbacks();
