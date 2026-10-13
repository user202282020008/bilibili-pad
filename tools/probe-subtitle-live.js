// @inject-content
// 在真实 B 站页面上跑一遍字幕逻辑（扩展源码已注入），用真实菜单项统计点击次数
(() => {
  const R = {};
  const html = document.documentElement;

  const hud = document.querySelector('.pts-hud');
  R.boot = {
    styleInjected: !!document.getElementById('pts-style'),
    hudExists: !!hud,
    hudWidth: hud ? getComputedStyle(hud).width : null,
    hudNote: hud && hud.querySelector('.pts-pad') ? hud.querySelector('.pts-pad').textContent : null,
  };

  const items = () => [...document.querySelectorAll('.bpx-player-ctrl-subtitle-language-item')];
  const root = playerRoot();
  R.scope = {
    pageWideItems: items().length,          // 全页同名项（含别的播放器）
    scopedItems: rawItems().length,         // 我们实际采纳的
    rootIsDocument: root === document,
    rootClass: typeof root.className === 'string' ? root.className : null,
    total: subTotal(),
  };
  R.realItems = rawItems().map((el) => ({
    name: (el.textContent || '').trim().slice(0, 20),
    lan: el.getAttribute('data-lan'),
    active: el.classList.contains('active'),
    hidden: el.offsetParent === null,
  })).slice(0, 30);

  // 谁被点了（捕获阶段统计，不管点的是哪个元素）
  let clicks = 0;
  const onClick = (e) => {
    const t = e.target;
    if (t && t.closest && t.closest('.bpx-player-ctrl-subtitle-language-item')) clicks++;
  };
  document.addEventListener('click', onClick, true);

  const snapshot = () => ({
    clicks,
    activeIdx: items().findIndex((el) => el.classList.contains('active')),
    subOff: html.classList.contains('pts-sub-off'),
    subtitleShown: (() => {
      const w = document.querySelector('.bpx-player-subtitle-wrap');
      return w ? getComputedStyle(w).display : null;
    })(),
  });

  R.step0_toFirstLang = (() => { applySubState(1); return snapshot(); })();
  R.step1_toSecondLang = (() => { applySubState(2); return snapshot(); })();
  R.step2_sameAgain = (() => { applySubState(2); return snapshot(); })();
  R.step3_toOff = (() => { applySubState(0); return snapshot(); })();
  R.step4_backOn = (() => { applySubState(1); return snapshot(); })();

  // 提示条清除（B 站真实 toast 类名）
  R.step5_toast = (() => {
    const wrap = document.createElement('div');
    wrap.className = 'bpx-player-toast-wrap';
    const box = document.createElement('div');
    box.className = 'bpx-player-toast-auto';
    const txt = document.createElement('div');
    txt.textContent = '字幕已切换至 中文（简体）';
    box.appendChild(txt); wrap.appendChild(box); document.body.appendChild(wrap);
    const other = document.createElement('div');
    other.className = 'bpx-player-toast-auto';
    const otxt = document.createElement('div');
    otxt.textContent = '已开启弹幕';
    other.appendChild(otxt); wrap.appendChild(other);

    suppressSubToast();
    const r = { subToastHidden: getComputedStyle(box).display === 'none',
                otherToastKept: getComputedStyle(other).display !== 'none' };
    wrap.remove();
    return r;
  })();

  document.removeEventListener('click', onClick, true);
  applySubState(0);                       // 收尾：字幕关掉 + CSS 隐藏，不让探针改动留在页面上
  return R;
})()
