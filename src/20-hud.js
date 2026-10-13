// ============================================================================
// 扳机倍速 · 画面提示（HUD）
// 左下角的实时倍速浮层：位置跟随全屏状态迁移。
// 依赖：00-core.js（hud / hudSpeed / hudLt / hudRt / hudPad）
// ============================================================================
'use strict';

const HUD_CSS = `
/* 尺寸写死：提示文字长短变化时浮窗不跟着伸缩（只换文字，不跳尺寸） */
.pts-hud{position:fixed;left:14px;bottom:14px;z-index:2147483647;pointer-events:none;
  box-sizing:border-box;width:114px;
  font:600 10px/1.25 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif;color:#fff;
  background:rgba(14,16,22,.5);border:1px solid rgba(255,255,255,.1);border-radius:9px;
  padding:6px 9px;backdrop-filter:blur(10px) saturate(1.4);
  box-shadow:0 4px 18px rgba(0,0,0,.32);transition:opacity .22s ease;opacity:0;
  text-shadow:0 1px 2px rgba(0,0,0,.5)}
/* 全屏时页面级元素不可见，只能贴回全屏容器里（避开底部控制条） */
.pts-hud.pts-in{position:absolute;left:12px;bottom:60px}
.pts-hud .pts-sp{font-size:14px;letter-spacing:.2px;font-variant-numeric:tabular-nums}
.pts-hud .pts-sp b{font-size:17px}
.pts-hud .pts-sp i{font-style:normal;font-size:9px;opacity:.55;margin-left:1px}
.pts-hud .pts-row{display:flex;align-items:center;gap:5px;margin-top:4px}
.pts-hud .pts-row span{width:14px;font-size:8px;opacity:.55;letter-spacing:.3px}
.pts-hud .pts-bar{flex:1;height:3px;border-radius:2px;background:rgba(255,255,255,.14);overflow:hidden}
.pts-hud .pts-bar div{height:100%;width:0;border-radius:2px;transition:width .06s linear}
.pts-hud .pts-lt div{background:#fb7299}
.pts-hud .pts-rt div{background:#00aeec}
.pts-hud .pts-pad{margin-top:4px;font-size:9px;font-weight:400;opacity:.5;
  min-height:11px;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
/* 字幕关闭：整片藏掉带 subtitle 字样的容器，兜住各版本播放器的新旧类名
   （只排除控制条上的字幕按钮 / 菜单，否则按钮也会跟着消失）。
   顺带保留几个历史类名，防止播放器把字幕渲染在别的命名的层里 */
html.pts-sub-off [class*="subtitle"]:not([class*="ctrl"]):not([class*="control"]),
html.pts-sub-off .bpx-player-video-subtitle,
html.pts-sub-off .bwp-player-subtitle{display:none !important}`;

function ensureStyle() {
  if (document.getElementById('pts-style')) return;
  const s = document.createElement('style');
  s.id = 'pts-style';
  s.textContent = HUD_CSS;
  (document.head || document.documentElement).appendChild(s);
}

// 播放窗口外（页面左下角）为默认；全屏时贴回全屏容器，否则看不见
function hudAnchor(el) {
  const fs = document.fullscreenElement || document.webkitFullscreenElement;
  if (fs && fs !== document.documentElement) {
    let n = el;
    while (n) {
      if (n === fs) return fs;
      const root = n.getRootNode ? n.getRootNode() : null;
      n = n.parentElement || (root && root.host) || null;
    }
  }
  return document.body;
}

function buildHud(el, anchor) {
  removeHud();
  ensureStyle();
  if (anchor !== document.body && getComputedStyle(anchor).position === 'static') {
    anchor.style.position = 'relative';
  }
  hud = document.createElement('div');
  hud.className = 'pts-hud' + (anchor === document.body ? '' : ' pts-in');
  hud.innerHTML =
    '<div class="pts-sp"><b>1.00</b><i>x</i></div>' +
    '<div class="pts-row"><span>LT</span><div class="pts-bar pts-lt"><div></div></div></div>' +
    '<div class="pts-row"><span>RT</span><div class="pts-bar pts-rt"><div></div></div></div>' +
    '<div class="pts-pad"></div>';
  anchor.appendChild(hud);
  hudSpeed = hud.querySelector('.pts-sp b');
  hudLt = hud.querySelector('.pts-lt div');
  hudRt = hud.querySelector('.pts-rt div');
  hudPad = hud.querySelector('.pts-pad');
}

function removeHud() {
  if (hud && hud.isConnected) hud.remove();
  hud = hudSpeed = hudLt = hudRt = hudPad = null;
}

function setHud(visible, speed, lt, rt, padText) {
  if (!hud) return;
  if (hud.style.opacity !== (visible ? '1' : '0')) hud.style.opacity = visible ? '1' : '0';
  if (!visible) return;
  const t = speed.toFixed(2);
  if (hudSpeed && hudSpeed.textContent !== t) hudSpeed.textContent = t;
  if (hudLt) hudLt.style.width = (lt * 100).toFixed(1) + '%';
  if (hudRt) hudRt.style.width = (rt * 100).toFixed(1) + '%';
  if (hudPad && hudPad.textContent !== padText) hudPad.textContent = padText;
}
