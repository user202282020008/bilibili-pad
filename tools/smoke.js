// 极简 DOM 环境下的逻辑冒烟测试（不需要浏览器）
const fs = require('fs');
const vm = require('vm');
const path = require('path');

// content 脚本按 manifest 里的顺序注入、共处同一隔离作用域，这里照同样顺序拼接后再执行
const root = path.join(__dirname, '..');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
const code = manifest.content_scripts[0].js
  .map((f) => fs.readFileSync(path.join(root, f), 'utf8'))
  .join('\n;\n');

function makeCtx(overrides) {
  let clock = 0;
  const rafs = [];

  class El {
    constructor(tag) {
      this.tagName = tag; this.style = {}; this.children = []; this.listeners = {};
      this.isConnected = true; this._rate = 1; this.volume = 1; this.muted = false;
      this.currentTime = 0;
      this.duration = 100;
      this.className = ''; this.childElementCount = 0; this._parent = null;
      this.paused = false; this.textContent = ''; this.innerHTML = '';
      this.classList = { contains: () => false };
      this._cls = new Set();
      this.classList = {
        add: (c) => this._cls.add(c),
        remove: (c) => this._cls.delete(c),
        contains: (c) => this._cls.has(c),
        toggle: (c, f) => (f === undefined ? (this._cls.has(c) ? this._cls.delete(c) : this._cls.add(c)) : (f ? this._cls.add(c) : this._cls.delete(c))),
      };
      this.textTracks = [];
      this.attrs = {};
    }
    getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }
    click() { /* 默认空实现，字幕项会覆盖 */ }
    play() { this.paused = false; return Promise.resolve(); }
    pause() { this.paused = true; }
    addEventListener(t, f) { (this.listeners[t] = this.listeners[t] || []).push(f); }
    removeEventListener(t, f) { const a = this.listeners[t] || []; const i = a.indexOf(f); if (i >= 0) a.splice(i, 1); }
    dispatch(t) { (this.listeners[t] || []).slice().forEach((f) => f()); }
    get playbackRate() { return this._rate; }
    set playbackRate(v) { this._rate = v; this.dispatch('ratechange'); }
    closest() { return videoRoot; }
    getRootNode() { return ctx.document; }
    querySelector() { return null; }
    querySelectorAll() { return []; }
    appendChild(c) { this.children.push(c); return c; }
    remove() { this.isConnected = false; }
    getBoundingClientRect() { return { width: 1280, height: 720 }; }
    get readyState() { return 4; }
    get currentSrc() { return 'blob:fake'; }
    get parentElement() { return this._parent || ctx.document.body; }
    set parentElement(v) { this._parent = v; }
  }

  const video = new El('video');
  const body = new El('body');
  const head = new El('head');
  const stats = {};
  const ctrl = {};
  const subEls = [];
  const otherEls = [];      // 另一个播放器里的同名菜单项（不该被我们的逻辑碰到）
  let videoRoot = null;     // video.closest(...) 的返回值
  const toastLeaves = [];   // 模拟 B 站的提示条文字节点（供字幕提示清除逻辑查）

  // 造一条 B 站的「字幕已切换至 xx」提示：外层是 toast 壳，里层是文字
  function setSubToast(text) {
    const box = new El('div');
    box.className = 'bpx-player-toast';
    box.childElementCount = 1;
    const inner = new El('div');
    inner.className = 'bpx-player-toast-text';
    inner.textContent = text;
    inner.parentElement = box;
    toastLeaves.length = 0;
    toastLeaves.push(inner);
    return { box, inner };
  }
  // 弹幕开关桩：模拟 B 站三档循环开关（bui-danmaku-switch-state-1/2/3），
  // 真实页面里只有内层 checkbox 的 click 有效（点外层 div / label 不生效）
  const dm = { st: 1, clicks: 0 };
  dm.input = { click() { dm.clicks++; dm.st = (dm.st % 3) + 1; } };
  dm.sw = {
    get className() { return 'bpx-player-dm-switch bui bui-danmaku-switch bui-danmaku-switch-state-' + dm.st; },
    querySelector: (sel) => (String(sel).indexOf('bui-danmaku-switch-input') >= 0 ? dm.input : null),
  };

  const document = {
    body, head,
    documentElement: new El('html'),
    createElement: (t) => new El(t),
    getElementById: () => null,
    // 只有宽屏 / 全屏按钮会返回桩对象（X / Y 键用）；字幕按钮默认不存在
    querySelector: (sel) => {
      if (typeof sel === 'string' && /bpx-player-dm-switch/.test(sel)) return dm.sw;
      if (typeof sel === 'string' && /ctrl-(wide|full)|btn-(wide|full)/.test(sel)) {
        ctrl[sel] = ctrl[sel] || { clicks: 0, click() { this.clicks++; } };
        return ctrl[sel];
      }
      return null;
    },
    querySelectorAll: (s) => {
      stats[s] = (stats[s] || 0) + 1;
      if (s === 'video') return [video];
      if (s === '.bpx-player-ctrl-subtitle-language-item') return [...subEls, ...otherEls];
      if (s === 'div, span, p') return toastLeaves;
      return [];
    },
  };

  // 模拟 B 站字幕菜单项：点某个语言就是选中它（再点已选中的也不会取消，只会重复弹提示）
  const subClicks = { total: 0, byName: {} };
  const OWN_ROOT = { name: 'own-player' };
  const OTHER_ROOT = { name: 'other-player' };
  const PANEL_ROOT = { name: 'settings-panel' };
  let subMenuOpens = 0;

  function mkSubItem(it, owner) {
    const el = new El('div');
    el.textContent = it.name || '';
    el.attrs['data-lan'] = it.lan || '';
    el.closest = (sel) => {
      if (/bui-panel-item/.test(sel)) return it.panel ? PANEL_ROOT : null;   // 设置面板里的语言模板
      return owner;
    };
    el.click = () => {
      subClicks.total++;
      subClicks.byName[it.name] = (subClicks.byName[it.name] || 0) + 1;
      el._cls.add('active');
      [...subEls, ...otherEls].forEach((o) => { if (o !== el) o._cls.delete('active'); });
    };
    return el;
  }

  // list = 自己播放器的菜单项；other = 页面上别的播放器的同名项
  // 项上写 panel: true 表示它来自播放器设置面板的语言模板
  // opts.lazy: 模拟「菜单项要等字幕菜单展开后才渲染」——按钮点一下才把项挂上来
  function setSubItems(list, other, opts) {
    subEls.length = 0;
    otherEls.length = 0;
    subClicks.total = 0;
    subClicks.byName = {};
    subMenuOpens = 0;
    (other || []).forEach((it) => otherEls.push(mkSubItem(it, OTHER_ROOT)));
    videoRoot = OWN_ROOT;

    const fill = () => (list || []).forEach((it) => subEls.push(mkSubItem(it, OWN_ROOT)));
    if (opts && opts.lazy) {
      // 有字幕按钮，但菜单项还没渲染；点按钮才渲染出来
      OWN_ROOT.querySelector = (sel) => (/ctrl-subtitle|subtitle/.test(sel)
        ? { className: 'bpx-player-ctrl-subtitle', click() { subMenuOpens++; fill(); } }
        : null);
    } else {
      delete OWN_ROOT.querySelector;
      fill();
    }
  }

  const pad = {
    id: 'Test Pad (Vendor: 0000 Product: 0000)',
    connected: true,
    buttons: Array.from({ length: 16 }, () => ({ value: 0, pressed: false })),
  };

  // B 站接口桩：view 给 aid/cid，player/v2 给真实字幕轨道列表
  let apiView = null;   // { aid, cid, pages: [{ cid }] } | null = 接口失败
  let apiSub = { lan: '', subtitles: [] };   // { lan, subtitles: [{lan, lan_doc}] }
  function setSubApi(view, sub) {
    apiView = view === undefined ? { aid: 1, cid: 2, pages: [{ cid: 2 }] } : view;
    apiSub = sub === undefined ? { lan: '', subtitles: [] } : sub;
  }
  // 惰性读取：attach 时就会发起第一次请求，但 setSubApi 是之后才调的，
  // 所以接口数据要在 .json() 被调用（也就是 await 完之后）这一刻才读
  const fetchStub = (url) => {
    const u = String(url);
    const res = (get) => Promise.resolve({ json: () => Promise.resolve(get()) });
    if (u.indexOf('/x/web-interface/view') >= 0) return res(() => ({ data: apiView }));
    if (u.indexOf('/x/player/v2') >= 0) return res(() => ({ data: { subtitle: apiSub } }));
    return Promise.reject(new Error('no stub: ' + u));
  };

  const ctx = {
    console,
    Math, JSON, Number, Object, Array, String, Boolean, isFinite, performance: { now: () => clock },
    location: { pathname: '/video/BV1xx', search: '' },
    URLSearchParams,
    fetch: fetchStub,
    document,
    navigator: { getGamepads: () => [pad] },
    requestAnimationFrame: (cb) => { rafs.push(cb); return rafs.length; },
    getComputedStyle: () => ({ position: 'relative' }),
    chrome: {
      storage: {
        sync: { store: {}, get(d, cb) { cb(Object.assign({}, d, this.store, overrides || {})); },
                set(o) { Object.assign(this.store, o); } },
        local: { store: {}, get(d, cb) { cb(Object.assign({}, d, this.store)); },
                 set(o) { Object.assign(this.store, o); } },
        onChanged: {
          listeners: [],
          addListener(f) { this.listeners.push(f); },
          fire(changes, area) { this.listeners.forEach((f) => f(changes, area || 'sync')); },
        },
      },
      runtime: {
        id: 'test-extension-id',
        onMessage: {
          listeners: [],
          addListener(f) { this.listeners.push(f); },
          fire(m) { this.listeners.forEach((f) => f(m, {}, () => {})); },
        },
      },
    },
  };
  // 极简 window 事件总线（内容脚本用它在实例之间广播「接管」）
  const winEvents = {};
  ctx.Event = function Event(type) { this.type = type; };
  ctx.addEventListener = (t, f) => { (winEvents[t] = winEvents[t] || []).push(f); };
  ctx.dispatchEvent = (ev) => { (winEvents[ev.type] || []).slice().forEach((f) => f(ev)); };
  ctx.window = ctx;
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(code, ctx);

  return {
    ctx, video, pad, dm, stats, ctrl, subEls, otherEls, setSubItems, subClicks, setSubToast, setSubApi,
    getSubMenuOpens: () => subMenuOpens,
    msg: ctx.chrome.runtime.onMessage,
    step(ms) {
      clock += ms;
      const cbs = rafs.splice(0, rafs.length);
      cbs.forEach((cb) => cb(clock));
    },
    // fetch 是异步的（view → player 两次请求），帧循环是同步的，先把 promise 链跑完
    async settle() {
      for (let i = 0; i < 12; i++) await new Promise((r) => setImmediate(r));
    },
  };
}

const queue = [];
function run(name, fn) { queue.push({ name, fn }); }

async function main() {
  for (const { name, fn } of queue) {
    let ok = true;
    try { await fn(); } catch (e) { ok = false; console.error('  ' + (e && e.message || e)); }
    console.log((ok ? 'PASS ' : 'FAIL ') + name);
    if (!ok) process.exitCode = 1;
  }
}

const near = (a, b, eps = 0.02) => Math.abs(a - b) <= eps;

run('RT 半按 ≈ 1.91x（默认 3x 上限 / 死区 0.08）', () => {
  const t = makeCtx();
  t.pad.buttons[7].value = 0.5;
  for (let i = 0; i < 60; i++) t.step(16);
  const r = t.video.playbackRate;
  if (!near(r, 1.91, 0.03)) throw new Error('得到 ' + r.toFixed(3));
});

run('RT 全按 → 3.00x', () => {
  const t = makeCtx();
  t.pad.buttons[7].value = 1;
  for (let i = 0; i < 120; i++) t.step(16);
  if (!near(t.video.playbackRate, 3, 0.02)) throw new Error('得到 ' + t.video.playbackRate.toFixed(3));
});

run('LT 全按 → 0.25x 慢放', () => {
  const t = makeCtx();
  t.pad.buttons[6].value = 1;
  for (let i = 0; i < 120; i++) t.step(16);
  if (!near(t.video.playbackRate, 0.25, 0.02)) throw new Error('得到 ' + t.video.playbackRate.toFixed(3));
});

run('松开扳机回到 1x', () => {
  const t = makeCtx();
  t.pad.buttons[7].value = 1;
  for (let i = 0; i < 60; i++) t.step(16);
  t.pad.buttons[7].value = 0;
  for (let i = 0; i < 120; i++) t.step(16);
  if (!near(t.video.playbackRate, 1, 0.01)) throw new Error('得到 ' + t.video.playbackRate.toFixed(3));
});

run('死区内的轻触不改变倍速', () => {
  const t = makeCtx();
  t.pad.buttons[7].value = 0.05;
  for (let i = 0; i < 60; i++) t.step(16);
  if (!near(t.video.playbackRate, 1, 0.001)) throw new Error('得到 ' + t.video.playbackRate.toFixed(3));
});

run('双扳机同时全按互相抵消 → 1x', () => {
  const t = makeCtx();
  t.pad.buttons[6].value = 1;
  t.pad.buttons[7].value = 1;
  for (let i = 0; i < 60; i++) t.step(16);
  if (!near(t.video.playbackRate, 1, 0.001)) throw new Error('得到 ' + t.video.playbackRate.toFixed(3));
});

run('跟随 B 站自身倍速（基线 2x 时 RT 全按 → 3x）', () => {
  const t = makeCtx();
  t.video.playbackRate = 2;              // 模拟播放器自带 2x
  for (let i = 0; i < 60; i++) t.step(16);
  t.pad.buttons[7].value = 1;
  for (let i = 0; i < 120; i++) t.step(16);
  if (!near(t.video.playbackRate, 3, 0.02)) throw new Error('得到 ' + t.video.playbackRate.toFixed(3));
});

run('默认倍速 2x：打开视频即为 2x', () => {
  const t = makeCtx({ syncPlayer: false, base: 2 });
  for (let i = 0; i < 10; i++) t.step(16);
  if (!near(t.video.playbackRate, 2, 0.01)) throw new Error('得到 ' + t.video.playbackRate.toFixed(3));
});

run('默认倍速 2x：松开扳机回到 2x 而不是 1x', () => {
  const t = makeCtx({ syncPlayer: false, base: 2 });
  t.pad.buttons[7].value = 1;
  for (let i = 0; i < 90; i++) t.step(16);
  if (!near(t.video.playbackRate, 3, 0.02)) throw new Error('加速失败：' + t.video.playbackRate.toFixed(3));
  t.pad.buttons[7].value = 0;
  for (let i = 0; i < 120; i++) t.step(16);
  if (!near(t.video.playbackRate, 2, 0.01)) throw new Error('得到 ' + t.video.playbackRate.toFixed(3));
});

run('弹窗改默认倍速 → 立即生效', () => {
  const t = makeCtx({ syncPlayer: false, base: 1 });
  for (let i = 0; i < 10; i++) t.step(16);
  t.ctx.chrome.storage.onChanged.fire({ base: { newValue: 2.5 } });
  for (let i = 0; i < 10; i++) t.step(16);
  if (!near(t.video.playbackRate, 2.5, 0.01)) throw new Error('得到 ' + t.video.playbackRate.toFixed(3));
});

run('打开「同步播放器倍速」→ 改为跟随播放器', () => {
  const t = makeCtx({ syncPlayer: false, base: 2 });
  for (let i = 0; i < 10; i++) t.step(16);
  t.ctx.chrome.storage.onChanged.fire({ syncPlayer: { newValue: true } });
  for (let i = 0; i < 10; i++) t.step(16);
  // 同步模式不再强写，倍速保持在当前值（交给播放器/用户）
  if (!near(t.video.playbackRate, 2, 0.01)) throw new Error('得到 ' + t.video.playbackRate.toFixed(3));
  t.video.playbackRate = 1;               // 用户手动改回 1x
  for (let i = 0; i < 60; i++) t.step(16);
  t.pad.buttons[7].value = 1;
  for (let i = 0; i < 120; i++) t.step(16);
  if (!near(t.video.playbackRate, 3, 0.02)) throw new Error('跟随失败：' + t.video.playbackRate.toFixed(3));
});
run('方向键 ↑ 调高音量（一档 +5%）', () => {
  const t = makeCtx();
  t.video.volume = 0.5;
  t.pad.buttons[12].pressed = true;
  t.step(16);
  if (!near(t.video.volume, 0.55, 0.001)) throw new Error('得到 ' + t.video.volume.toFixed(3));
});

run('方向键 ↓ 调低音量', () => {
  const t = makeCtx();
  t.video.volume = 0.5;
  t.pad.buttons[13].pressed = true;
  t.step(16);
  if (!near(t.video.volume, 0.45, 0.001)) throw new Error('得到 ' + t.video.volume.toFixed(3));
});

run('按住方向键连续调音量（不会超出 0~1）', () => {
  const t = makeCtx();
  t.video.volume = 0.5;
  t.pad.buttons[12].pressed = true;
  for (let i = 0; i < 60; i++) t.step(16);   // 约 1 秒
  if (t.video.volume <= 0.6) throw new Error('未连发：' + t.video.volume.toFixed(3));
  for (let i = 0; i < 120; i++) t.step(16);
  if (t.video.volume > 1) throw new Error('越界：' + t.video.volume.toFixed(3));
  t.pad.buttons[13].pressed = true;
  for (let i = 0; i < 300; i++) t.step(16);
  if (t.video.volume < 0) throw new Error('越界：' + t.video.volume.toFixed(3));
});

run('关闭方向键调音量后不再响应', () => {
  const t = makeCtx({ dpadVol: false });
  t.video.volume = 0.5;
  t.pad.buttons[12].pressed = true;
  for (let i = 0; i < 30; i++) t.step(16);
  if (t.video.volume !== 0.5) throw new Error('得到 ' + t.video.volume.toFixed(3));
});

run('播放器倍速上报到 storage.local（供弹窗读取）', () => {
  const t = makeCtx();
  for (let i = 0; i < 10; i++) t.step(16);
  const v = t.ctx.chrome.storage.local.store.playerRate;
  if (!near(v, 1, 0.001)) throw new Error('得到 ' + v);
  t.video.playbackRate = 1.5;                // 模拟播放器里改成 1.5x
  for (let i = 0; i < 60; i++) t.step(16);
  if (!near(t.ctx.chrome.storage.local.store.playerRate, 1.5, 0.001)) {
    throw new Error('得到 ' + t.ctx.chrome.storage.local.store.playerRate);
  }
});

run('默认倍速（无手柄活动）被播放器改回时会掰回来', () => {
  const t = makeCtx({ syncPlayer: false, base: 2 });
  t.pad.connected = false;                   // 未检测到手柄
  for (let i = 0; i < 10; i++) t.step(16);
  if (!near(t.video.playbackRate, 2, 0.01)) throw new Error('初始失败：' + t.video.playbackRate.toFixed(3));
  t.video.playbackRate = 1;                  // B 站播放器自己改回 1x
  for (let i = 0; i < 30; i++) t.step(16);
  if (!near(t.video.playbackRate, 2, 0.02)) throw new Error('未恢复：' + t.video.playbackRate.toFixed(3));
});

run('左肩键 L1 暂停 / 继续（按住不重复触发）', () => {
  const t = makeCtx();
  t.step(16); t.step(16);
  t.pad.buttons[4].pressed = true;
  t.step(16);
  if (!t.video.paused) throw new Error('未暂停');
  for (let i = 0; i < 30; i++) t.step(16);
  if (!t.video.paused) throw new Error('按住期间不应自动恢复');
  t.pad.buttons[4].pressed = false;
  t.step(16);
  t.pad.buttons[4].pressed = true;
  t.step(16);
  if (t.video.paused) throw new Error('未恢复播放');
});

run('关闭左肩键暂停后不响应', () => {
  const t = makeCtx({ lbPause: false });
  t.step(16); t.step(16);
  t.pad.buttons[4].pressed = true;
  for (let i = 0; i < 10; i++) t.step(16);
  if (t.video.paused) throw new Error('不应暂停');
});

run('同步播放器倍速：跟随播放器里改的倍速', () => {
  const t = makeCtx();                        // syncPlayer 默认开启
  t.video.playbackRate = 1.5;                 // 播放器里设 1.5x
  for (let i = 0; i < 60; i++) t.step(16);
  t.pad.buttons[7].value = 1;
  for (let i = 0; i < 90; i++) t.step(16);
  if (!near(t.video.playbackRate, 3, 0.02)) throw new Error('加速失败：' + t.video.playbackRate.toFixed(3));
  t.pad.buttons[7].value = 0;
  for (let i = 0; i < 120; i++) t.step(16);
  if (!near(t.video.playbackRate, 1.5, 0.02)) throw new Error('未回到播放器倍速：' + t.video.playbackRate.toFixed(3));
});

// 字幕测试助手：配好接口返回的真实轨道 + 播放器里的可点菜单项
function subEnv(opts) {
  const t = makeCtx(opts.overrides);
  const tracks = opts.tracks || [];
  t.setSubApi(
    opts.view === undefined ? { aid: 1, cid: 2, pages: [{ cid: 2 }] } : opts.view,
    { lan: opts.current || '', subtitles: tracks.map((x) => ({ lan: x.lan, lan_doc: x.doc })) }
  );
  if (opts.items) t.setSubItems(opts.items.map((x) => ({ name: x.doc, lan: x.lan })), opts.other);
  const press = () => { t.pad.buttons[5].pressed = false; t.step(16); t.pad.buttons[5].pressed = true; t.step(16); };
  return { t, press };
}

run('R1 循环真实字幕轨道：关 → 中文 → English → 关（列表来自接口）', async () => {
  const { t, press } = subEnv({
    tracks: [{ lan: 'zh-CN', doc: '中文（简体）' }, { lan: 'en-US', doc: 'English(US)' }],
    items: [{ lan: 'zh-CN', doc: '中文（简体）' }, { lan: 'en-US', doc: 'English(US)' }],
  });
  t.step(16); t.step(16);
  press();                       // 第一次按：还没拉轨道列表 → 触发加载
  await t.settle();              // 等接口返回
  for (let i = 0; i < 5; i++) t.step(16);   // 主循环把这一下补上
  if (t.ctx.chrome.storage.sync.store.subIndex !== 1) throw new Error('未切到中文，subIndex=' + t.ctx.chrome.storage.sync.store.subIndex);
  if (!t.subEls[0]._cls.has('active')) throw new Error('没点中「中文（简体）」');

  press();                       // → English
  for (let i = 0; i < 3; i++) t.step(16);
  if (!t.subEls[1]._cls.has('active')) throw new Error('没点中「English」');

  press();                       // → 关（CSS 隐藏，不再点语言项）
  for (let i = 0; i < 3; i++) t.step(16);
  if (t.ctx.chrome.storage.sync.store.subIndex !== 0) throw new Error('未循环回关');
  if (!t.ctx.document.documentElement._cls.has('pts-sub-off')) throw new Error('关闭后未隐藏字幕');
  if (t.subClicks.total !== 2) throw new Error('关闭时不该再点语言项：' + t.subClicks.total);

  press();                       // 再循环 → 中文
  for (let i = 0; i < 3; i++) t.step(16);
  if (!t.subEls[0]._cls.has('active')) throw new Error('未能再次选中中文');
});

run('接口说当前已是中文 → 不再重复点击（不会重复弹提示）', async () => {
  const { t } = subEnv({
    overrides: { subIndex: 1 },
    tracks: [{ lan: 'zh-CN', doc: '中文（简体）' }],
    current: 'zh-CN',
    items: [{ lan: 'zh-CN', doc: '中文（简体）' }],
  });
  t.subEls[0]._cls.add('active');        // B 站已经是这条了
  await t.settle();
  for (let i = 0; i < 90; i++) t.step(16);   // 恢复保存的状态 + 让重试跑满
  if (t.subClicks.total !== 0) throw new Error('已是当前语言还点了 ' + t.subClicks.total + ' 次');
});

run('视频没有字幕轨（接口返回空）→ R1 退化为 关 / 开（CSS 隐藏）', async () => {
  const { t, press } = subEnv({ tracks: [] });
  t.step(16); t.step(16);
  press();
  await t.settle();
  for (let i = 0; i < 5; i++) t.step(16);
  if (t.ctx.chrome.storage.sync.store.subIndex !== 1) throw new Error('未切到开');
  if (t.ctx.document.documentElement._cls.has('pts-sub-off')) throw new Error('开状态不应隐藏');
  press();
  for (let i = 0; i < 5; i++) t.step(16);
  if (t.ctx.chrome.storage.sync.store.subIndex !== 0) throw new Error('未切回关');
  if (!t.ctx.document.documentElement._cls.has('pts-sub-off')) throw new Error('关状态未隐藏');
});

run('字幕状态持久化：加载时按接口列表恢复保存的语言', async () => {
  const { t } = subEnv({
    overrides: { subIndex: 2 },
    tracks: [{ lan: 'zh-CN', doc: '中文' }, { lan: 'en-US', doc: 'English' }],
    items: [{ lan: 'zh-CN', doc: '中文' }, { lan: 'en-US', doc: 'English' }],
  });
  await t.settle();
  for (let i = 0; i < 70; i++) t.step(16);   // 接口返回后由主循环恢复
  if (!t.subEls[1]._cls.has('active')) throw new Error('未恢复保存的第 2 条字幕');
});

run('关闭「R1 循环字幕」开关后不响应', () => {
  const t = makeCtx({ rbSub: false });
  t.setSubItems([{ name: '中文', lan: 'zh-CN' }]);
  t.step(16); t.step(16);
  t.pad.buttons[5].pressed = true;
  for (let i = 0; i < 10; i++) t.step(16);
  if (t.subEls[0]._cls.has('active')) throw new Error('关闭后仍切换了字幕');
  if (t.ctx.chrome.storage.sync.store.subIndex !== undefined) throw new Error('关闭后仍写入状态');
});

run('尚未接管时不动用户的字幕（不自动开关）', () => {
  const t = makeCtx();                          // subIndex 默认 -1
  t.setSubItems([{ name: '中文', lan: 'zh-CN' }]);
  for (let i = 0; i < 70; i++) t.step(16);
  if (t.subEls[0]._cls.has('active')) throw new Error('不该自动开启字幕');
  if (t.ctx.document.documentElement._cls.has('pts-sub-off')) throw new Error('不该自动隐藏字幕');
});

run('旧配置 useBase 迁移到 syncPlayer（自定义默认倍速不丢）', () => {
  // 模拟旧版存档：只有 useBase，没有 v2 标记
  const t = makeCtx({ v2: undefined, useBase: true, base: 2 });
  for (let i = 0; i < 10; i++) t.step(16);
  if (!near(t.video.playbackRate, 2, 0.01)) throw new Error('未沿用旧默认倍速：' + t.video.playbackRate.toFixed(3));
  if (t.ctx.chrome.storage.sync.store.syncPlayer !== false) throw new Error('未写入迁移结果');
  if (t.ctx.chrome.storage.sync.store.v2 !== true) throw new Error('未写入版本标记');
});

run('写入播放器的倍速始终是两位小数（B 站 UI 不会显示长串）', () => {
  const t = makeCtx();
  t.pad.buttons[7].value = 0.47;
  let bad = 0;
  for (let i = 0; i < 90; i++) {
    t.step(16);
    const r = t.video.playbackRate * 100;
    if (Math.abs(r - Math.round(r)) > 1e-6) bad++;
  }
  if (bad) throw new Error(bad + ' 次写入了长浮点');
});

run('同步模式：手柄插着但没碰扳机，不覆盖播放器设的倍速', () => {
  const t = makeCtx();                       // syncPlayer 默认开启
  for (let i = 0; i < 10; i++) t.step(16);
  t.video.playbackRate = 2;                  // 播放器菜单里设 2x
  for (let i = 0; i < 60; i++) t.step(16);
  if (!near(t.video.playbackRate, 2, 0.001)) throw new Error('被覆盖成 ' + t.video.playbackRate.toFixed(3));
});

run('已挂载播放器时不做全页扫描（避免每帧 querySelectorAll）', () => {
  const t = makeCtx();
  for (let i = 0; i < 120; i++) t.step(16);
  const n = t.stats.video || 0;
  if (n > 8) throw new Error('扫描次数过多：' + n + ' 次 / 120 帧');
});

run('跟随模式：播放器改倍速 → 默认倍速实时跟随并上报', () => {
  const t = makeCtx();                          // syncPlayer 默认开启
  for (let i = 0; i < 10; i++) t.step(16);
  t.video.playbackRate = 1.5;                   // 播放器里设 1.5x
  for (let i = 0; i < 5; i++) t.step(16);
  if (t.ctx.chrome.storage.local.store.playerRate !== 1.5) {
    throw new Error('未实时跟随：' + t.ctx.chrome.storage.local.store.playerRate);
  }
  t.pad.buttons[7].value = 1;                   // 从 1.5 起步加速到 3
  for (let i = 0; i < 90; i++) t.step(16);
  if (!near(t.video.playbackRate, 3, 0.02)) throw new Error('加速失败：' + t.video.playbackRate.toFixed(3));
  t.pad.buttons[7].value = 0;
  for (let i = 0; i < 120; i++) t.step(16);
  if (!near(t.video.playbackRate, 1.5, 0.02)) throw new Error('松手未回到 1.5x：' + t.video.playbackRate.toFixed(3));
});

run('弹窗关闭「启用」后，扣扳机不再变速', () => {
  const t = makeCtx();
  t.pad.buttons[7].value = 1;
  for (let i = 0; i < 60; i++) t.step(16);
  const before = t.video.playbackRate;
  if (!near(before, 3, 0.02)) throw new Error('前置失败：得到 ' + before.toFixed(3));
  t.ctx.chrome.storage.onChanged.fire({ enabled: { newValue: false } });
  for (let i = 0; i < 60; i++) t.step(16);
  if (t.video.playbackRate > before + 0.01) throw new Error('关闭后仍在变速：' + t.video.playbackRate.toFixed(3));
});

run('重新打开「启用」后恢复变速', () => {
  const t = makeCtx();
  t.ctx.chrome.storage.onChanged.fire({ enabled: { newValue: false } });
  t.pad.buttons[7].value = 1;
  for (let i = 0; i < 60; i++) t.step(16);
  if (!near(t.video.playbackRate, 1, 0.01)) throw new Error('关闭期间不应变速：' + t.video.playbackRate.toFixed(3));
  t.ctx.chrome.storage.onChanged.fire({ enabled: { newValue: true } });
  for (let i = 0; i < 120; i++) t.step(16);
  if (!near(t.video.playbackRate, 3, 0.02)) throw new Error('得到 ' + t.video.playbackRate.toFixed(3));
});

module.exports = { makeCtx };

run('X 键点击播放器的宽屏按钮（按住不重复）', () => {
  const t = makeCtx();
  t.step(16); t.step(16);
  t.pad.buttons[2].pressed = true;
  t.step(16);
  if (!t.ctrl['.bpx-player-ctrl-wide'] || t.ctrl['.bpx-player-ctrl-wide'].clicks !== 1) {
    throw new Error('未点击宽屏按钮');
  }
  for (let i = 0; i < 30; i++) t.step(16);
  if (t.ctrl['.bpx-player-ctrl-wide'].clicks !== 1) throw new Error('按住重复触发');
});

run('Y 键点击播放器的全屏按钮', () => {
  const t = makeCtx();
  t.step(16); t.step(16);
  t.pad.buttons[3].pressed = true;
  t.step(16);
  if (!t.ctrl['.bpx-player-ctrl-full'] || t.ctrl['.bpx-player-ctrl-full'].clicks !== 1) {
    throw new Error('未点击全屏按钮');
  }
});

run('关闭 X / Y 开关后不再响应', () => {
  const t = makeCtx({ xWide: false, yFull: false });
  t.step(16); t.step(16);
  t.pad.buttons[2].pressed = true;
  t.pad.buttons[3].pressed = true;
  for (let i = 0; i < 10; i++) t.step(16);
  if (t.ctrl['.bpx-player-ctrl-wide']) throw new Error('X 仍响应');
  if (t.ctrl['.bpx-player-ctrl-full']) throw new Error('Y 仍响应');
});

run('免刷新：设置变更通过 onChanged 立即生效（rtMax 3→5）', () => {
  const t = makeCtx();
  t.step(16); t.step(16);
  t.ctx.chrome.storage.onChanged.fire({ rtMax: { newValue: 5 } });
  t.pad.buttons[7].value = 1;
  for (let i = 0; i < 120; i++) t.step(16);
  if (!near(t.video.playbackRate, 5, 0.05)) throw new Error('得到 ' + t.video.playbackRate.toFixed(2));
});

run('免刷新：弹窗通知后重读 storage（不刷新页面也生效）', () => {
  const t = makeCtx();
  t.step(16); t.step(16);
  t.ctx.chrome.storage.sync.store.rtMax = 4;   // 直接改存档，但不发 onChanged
  t.msg.fire({ type: 'pts-config' });
  t.pad.buttons[7].value = 1;
  for (let i = 0; i < 120; i++) t.step(16);
  if (!near(t.video.playbackRate, 4, 0.05)) throw new Error('未重读配置：' + t.video.playbackRate.toFixed(2));
});

run('免刷新：关闭「启用」后立即停止响应扳机', () => {
  const t = makeCtx();
  t.step(16); t.step(16);
  t.ctx.chrome.storage.onChanged.fire({ enabled: { newValue: false } });
  t.pad.buttons[7].value = 1;
  for (let i = 0; i < 120; i++) t.step(16);
  if (!near(t.video.playbackRate, 1, 0.02)) throw new Error('关闭后仍变速：' + t.video.playbackRate.toFixed(2));
});

run('方向键 → 默认倍速 +0.25 并退出跟随模式', () => {
  const t = makeCtx();                          // syncPlayer 默认开
  t.step(16); t.step(16);
  t.pad.buttons[15].pressed = true;
  for (let i = 0; i < 5; i++) t.step(16);
  if (!near(t.video.playbackRate, 1.25, 0.02)) throw new Error('倍速未 +0.25：' + t.video.playbackRate.toFixed(2));
  if (t.ctx.chrome.storage.sync.store.syncPlayer !== false) throw new Error('未退出跟随模式');
  if (!near(t.ctx.chrome.storage.sync.store.base, 1.25, 0.001)) throw new Error('未保存 base');
});

run('方向键 ← 默认倍速 -0.25，按住不连发', () => {
  const t = makeCtx();
  t.step(16); t.step(16);
  t.pad.buttons[14].pressed = true;
  for (let i = 0; i < 60; i++) t.step(16);
  if (!near(t.video.playbackRate, 0.75, 0.02)) throw new Error('倍速未 -0.25：' + t.video.playbackRate.toFixed(2));
});

run('关闭「方向键 ←→ 调默认倍速」后不响应', () => {
  const t = makeCtx({ dpadRate: false, syncPlayer: false, base: 2 });
  for (let i = 0; i < 10; i++) t.step(16);
  t.pad.buttons[15].pressed = true;
  for (let i = 0; i < 30; i++) t.step(16);
  if (!near(t.video.playbackRate, 2, 0.02)) throw new Error('关闭后仍改倍速：' + t.video.playbackRate.toFixed(2));
});

// 浮窗尺寸不能随提示文字长短跳变（固定宽度 114px，字号 9px ≈ 20 个半角列）
const cols = (s) => {
  let n = 0;
  for (const ch of String(s)) {
    const c = ch.codePointAt(0);
    const wide = c === 0x00b7 || (c >= 0x1100 && (c <= 0x115f || (c >= 0x2e80 && c <= 0xa4cf)
      || (c >= 0xac00 && c <= 0xd7a3) || (c >= 0xf900 && c <= 0xfaff)
      || (c >= 0xfe30 && c <= 0xfe6f) || (c >= 0xff00 && c <= 0xff60) || (c >= 0xffe0 && c <= 0xffe6)));
    n += wide ? 2 : 1;
  }
  return n;
};

run('HUD 提示文字都放得进固定宽度（不会撑开 / 截断）', () => {
  const t = makeCtx({ swap: true });
  const notes = new Set();
  const orig = t.ctx.setHud;
  t.ctx.setHud = (visible, speed, lt, rt, padText) => {
    if (padText) notes.add(padText);
    return orig(visible, speed, lt, rt, padText);
  };
  t.setSubItems([{ name: '中文（简体）', lan: 'zh-CN' }, { name: 'English', lan: 'en-US' }]);
  const tap = (idx, frames = 4) => {
    t.pad.buttons[idx].pressed = true;
    for (let i = 0; i < frames; i++) t.step(16);
    t.pad.buttons[idx].pressed = false;
    for (let i = 0; i < frames; i++) t.step(16);
  };
  for (let i = 0; i < 10; i++) t.step(16);        // 待命 / 已连接
  t.pad.buttons[7].value = 1;
  for (let i = 0; i < 30; i++) t.step(16);        // RT 加速
  t.pad.buttons[7].value = 0;
  for (let i = 0; i < 30; i++) t.step(16);        // 松手回到待命
  t.pad.buttons[6].value = 1;
  for (let i = 0; i < 30; i++) t.step(16);        // LT 减速
  t.pad.buttons[6].value = 0;
  for (let i = 0; i < 30; i++) t.step(16);
  tap(0);     // A 快退
  tap(1);     // B 快进
  tap(12);    // 音量 +
  tap(13);    // 音量 −
  tap(15);    // 默认倍速 +
  tap(14);    // 默认倍速 −
  tap(4);     // 暂停 / 继续
  tap(5);     // 字幕
  tap(2);     // 宽屏
  tap(3);     // 全屏
  tap(11);    // 弹幕：关
  tap(11);    // 弹幕：开
  if (notes.size < 6) throw new Error('收集到的提示太少：' + [...notes].join(' | '));
  for (const n of notes) {
    if (cols(n) > 20) throw new Error("提示过长会跳尺寸（" + cols(n) + " 列）：" + n);
  }
});

run('扩展被重载后，旧脚本自动停手（不再覆盖倍速）', () => {
  const t = makeCtx();
  t.step(16); t.step(16);
  t.pad.buttons[7].value = 1;
  for (let i = 0; i < 60; i++) t.step(16);
  if (!near(t.video.playbackRate, 3, 0.05)) throw new Error('前置失败：' + t.video.playbackRate.toFixed(2));
  t.ctx.chrome.runtime.id = undefined;        // 模拟扩展被重新加载 → 上下文失效
  for (let i = 0; i < 5; i++) t.step(16);
  t.video.playbackRate = 1;                   // 之后谁都不该再写它
  for (let i = 0; i < 60; i++) t.step(16);
  if (!near(t.video.playbackRate, 1, 0.001)) {
    throw new Error('失联后仍在写倍速：' + t.video.playbackRate.toFixed(2));
  }
});

run('页面里来了新实例时，旧实例让位', () => {
  const t = makeCtx();
  t.step(16); t.step(16);
  t.pad.buttons[7].value = 1;
  for (let i = 0; i < 60; i++) t.step(16);
  if (!near(t.video.playbackRate, 3, 0.05)) throw new Error('前置失败：' + t.video.playbackRate.toFixed(2));
  // 模拟新注入的脚本接管（它会把 window.__ptsInstance 换成自己的标记再广播）
  t.ctx.__ptsInstance = { dead: false };
  t.ctx.dispatchEvent(new t.ctx.Event('pts-takeover'));
  for (let i = 0; i < 5; i++) t.step(16);
  t.video.playbackRate = 1;
  for (let i = 0; i < 60; i++) t.step(16);
  if (!near(t.video.playbackRate, 1, 0.001)) {
    throw new Error('旧实例未让位，仍在写倍速：' + t.video.playbackRate.toFixed(2));
  }
});

run('弹窗 ping 时内容脚本会回应（弹窗据此判断是否需要补注入）', () => {
  const t = makeCtx();
  t.step(16); t.step(16);
  let reply = null;
  const listeners = t.msg.listeners;
  if (!listeners.length) throw new Error('没有注册 onMessage 监听');
  listeners.forEach((f) => f({ type: 'pts-config' }, {}, (r) => { reply = r; }));
  if (!reply || reply.ok !== true) throw new Error('未回应或回应错误：' + JSON.stringify(reply));
});

run('A / B 首次快退 / 快进 5s', () => {
  const t = makeCtx();
  t.step(16); t.step(16);
  t.video.currentTime = 30;
  const tap = (idx) => { t.pad.buttons[idx].pressed = true; t.step(16); t.pad.buttons[idx].pressed = false; t.step(16); };
  tap(0);   // A → 25
  if (t.video.currentTime !== 25) throw new Error('快退失败：' + t.video.currentTime);
  tap(1);   // B → 30
  if (t.video.currentTime !== 30) throw new Error('快进失败：' + t.video.currentTime);
});

run('快退 / 快进会被夹在 0 ~ 时长之间', () => {
  const t = makeCtx();
  t.step(16); t.step(16);
  t.video.currentTime = 3;
  t.pad.buttons[0].pressed = true; t.step(16);
  if (t.video.currentTime !== 0) throw new Error('未夹到 0：' + t.video.currentTime);
  t.pad.buttons[0].pressed = false; t.step(16);
  t.video.currentTime = 95;                 // 时长 100
  t.pad.buttons[1].pressed = true; t.step(16);
  if (t.video.currentTime !== 100) throw new Error('未夹到时长：' + t.video.currentTime);
});

run('A / B 按住不连发', () => {
  const t = makeCtx();
  t.step(16); t.step(16);
  t.video.currentTime = 50;
  t.pad.buttons[1].pressed = true;
  for (let i = 0; i < 60; i++) t.step(16);
  if (t.video.currentTime !== 55) throw new Error('按住连发了：' + t.video.currentTime);
});

run('关闭「A / B 快退快进」后不响应', () => {
  const t = makeCtx({ abSeek: false });
  t.step(16); t.step(16);
  t.video.currentTime = 50;
  t.pad.buttons[0].pressed = true; t.step(16);
  t.pad.buttons[0].pressed = false;
  t.pad.buttons[1].pressed = true; t.step(16);
  if (t.video.currentTime !== 50) throw new Error('关闭后仍跳转：' + t.video.currentTime);
});

run('时长未知（直播）时 A / B 不动', () => {
  const t = makeCtx();
  t.video.duration = NaN;
  t.step(16); t.step(16);
  t.video.currentTime = 50;
  t.pad.buttons[1].pressed = true; t.step(16);
  if (t.video.currentTime !== 50) throw new Error('不该跳转：' + t.video.currentTime);
});

run('B 键连按步长递增：+5 / +6 / +7 秒', () => {
  const t = makeCtx();
  t.step(16); t.step(16);
  t.video.currentTime = 0;
  const tap = (idx) => { t.pad.buttons[idx].pressed = true; t.step(16); t.pad.buttons[idx].pressed = false; t.step(16); };
  tap(1); if (t.video.currentTime !== 5) throw new Error('第 1 次：' + t.video.currentTime);
  tap(1); if (t.video.currentTime !== 11) throw new Error('第 2 次：' + t.video.currentTime);
  tap(1); if (t.video.currentTime !== 18) throw new Error('第 3 次：' + t.video.currentTime);
});

run('A 键连按步长递增：-5 / -6 / -7 秒', () => {
  const t = makeCtx();
  t.step(16); t.step(16);
  t.video.currentTime = 50;
  const tap = (idx) => { t.pad.buttons[idx].pressed = true; t.step(16); t.pad.buttons[idx].pressed = false; t.step(16); };
  tap(0); if (t.video.currentTime !== 45) throw new Error('第 1 次：' + t.video.currentTime);
  tap(0); if (t.video.currentTime !== 39) throw new Error('第 2 次：' + t.video.currentTime);
  tap(0); if (t.video.currentTime !== 32) throw new Error('第 3 次：' + t.video.currentTime);
});

run('A / B 连按计数相互独立', () => {
  const t = makeCtx();
  t.step(16); t.step(16);
  t.video.currentTime = 20;
  const tap = (idx) => { t.pad.buttons[idx].pressed = true; t.step(16); t.pad.buttons[idx].pressed = false; t.step(16); };
  tap(1); if (t.video.currentTime !== 25) throw new Error('B1：' + t.video.currentTime);   // +5
  tap(1); if (t.video.currentTime !== 31) throw new Error('B2：' + t.video.currentTime);   // +6
  tap(0); if (t.video.currentTime !== 26) throw new Error('A1：' + t.video.currentTime);   // -5
  tap(0); if (t.video.currentTime !== 20) throw new Error('A2：' + t.video.currentTime);   // -6
  tap(1); if (t.video.currentTime !== 27) throw new Error('B3：' + t.video.currentTime);   // +7，A 未打断 B 的链
});

run('连按间隔超过 1 秒 → 步长重置回 5 秒', () => {
  const t = makeCtx();
  t.step(16); t.step(16);
  t.video.currentTime = 0;
  const tap = (idx) => { t.pad.buttons[idx].pressed = true; t.step(16); t.pad.buttons[idx].pressed = false; t.step(16); };
  tap(1);          // 0 → 5
  tap(1);          // → 11（第 2 次 +6，确认链生效）
  t.step(1100);    // 空闲超过 1 秒
  tap(1);          // 重置 → +5 → 16（未重置则是 +7 → 18）
  if (t.video.currentTime !== 16) throw new Error('超时未重置：' + t.video.currentTime);
});

run('连按间隔恰好 1000ms → 继续递增（不重置）', () => {
  const t = makeCtx();
  t.step(16); t.step(16);
  t.video.currentTime = 0;
  t.pad.buttons[1].pressed = true; t.step(16);     // 第 1 次按下沿 → +5 → 5
  t.pad.buttons[1].pressed = false; t.step(16);
  t.step(1000 - 32);                               // 下一次按下沿正好距上次 1000ms
  t.pad.buttons[1].pressed = true; t.step(16);
  if (t.video.currentTime !== 11) throw new Error('恰好 1000ms 被重置：' + t.video.currentTime);
});

run('连按间隔 1001ms → 重置回 5 秒', () => {
  const t = makeCtx();
  t.step(16); t.step(16);
  t.video.currentTime = 0;
  t.pad.buttons[1].pressed = true; t.step(16);     // 第 1 次 → +5 → 5
  t.pad.buttons[1].pressed = false; t.step(16);
  t.step(1001 - 32);
  t.pad.buttons[1].pressed = true; t.step(16);
  if (t.video.currentTime !== 10) throw new Error('超过 1 秒未重置：' + t.video.currentTime);
});

run('提示显示当前步长；位置被夹取时步长不变', () => {
  const t = makeCtx();
  let note = '';
  const orig = t.ctx.setHud;
  t.ctx.setHud = (visible, speed, lt, rt, padText) => { if (padText) note = padText; return orig(visible, speed, lt, rt, padText); };
  t.step(16); t.step(16);
  const tap = (idx) => { t.pad.buttons[idx].pressed = true; t.step(16); t.pad.buttons[idx].pressed = false; t.step(16); };
  t.video.currentTime = 95;                        // 时长 100
  tap(1);                                          // +5 → 夹到 100
  if (note !== '快进 5s · 1:40') throw new Error('提示不对：' + note);
  tap(1);                                          // +6 → 仍夹在 100，但步长是 6
  if (note !== '快进 6s · 1:40') throw new Error('提示不对：' + note);
  t.video.currentTime = 5;
  tap(0);                                          // -5 → 0
  if (note !== '快退 5s · 0:00') throw new Error('提示不对：' + note);
  tap(0);                                          // -6 → 夹到 0
  if (note !== '快退 6s · 0:00') throw new Error('提示不对：' + note);
});

run('R3 弹幕开关：全开 ⇄ 关，跳过中间档', () => {
  const t = makeCtx();
  let note = '';
  const orig = t.ctx.setHud;
  t.ctx.setHud = (visible, speed, lt, rt, padText) => { if (padText) note = padText; return orig(visible, speed, lt, rt, padText); };
  t.step(16); t.step(16);
  const tap = (idx) => { t.pad.buttons[idx].pressed = true; t.step(16); t.pad.buttons[idx].pressed = false; t.step(16); };
  if (t.dm.st !== 1) throw new Error('初始档位不对：' + t.dm.st);
  tap(11);                                 // 全屏档 → 连点两下直达关（跳过半屏档）
  if (t.dm.clicks !== 2 || t.dm.st !== 3) throw new Error('未跳过半屏档：clicks=' + t.dm.clicks + ' st=' + t.dm.st);
  if (note !== '弹幕：关') throw new Error('提示不对：' + note);
  tap(11);                                 // 关 → 一下回到全屏档
  if (t.dm.clicks !== 3 || t.dm.st !== 1) throw new Error('未回到全屏档：clicks=' + t.dm.clicks + ' st=' + t.dm.st);
  if (note !== '弹幕：开') throw new Error('提示不对：' + note);
});

run('R3 按住不重复', () => {
  const t = makeCtx();
  t.step(16); t.step(16);
  t.pad.buttons[11].pressed = true;
  for (let i = 0; i < 60; i++) t.step(16);
  if (t.dm.clicks !== 2 || t.dm.st !== 3) throw new Error('按住连发了：clicks=' + t.dm.clicks + ' st=' + t.dm.st);
});

run('关闭 R3 弹幕开关后不响应', () => {
  const t = makeCtx({ r3Dm: false });
  t.step(16); t.step(16);
  t.pad.buttons[11].pressed = true; t.step(16);
  t.pad.buttons[11].pressed = false; t.step(16);
  if (t.dm.clicks !== 0 || t.dm.st !== 1) throw new Error('关闭后仍切换：clicks=' + t.dm.clicks);
});

run('中间档（半屏）按 R3 一键关', () => {
  const t = makeCtx();
  t.step(16); t.step(16);
  t.dm.st = 2;                             // 模拟用户自己用鼠标切到了半屏档
  t.pad.buttons[11].pressed = true; t.step(16);
  t.pad.buttons[11].pressed = false; t.step(16);
  if (t.dm.st !== 3 || t.dm.clicks !== 1) throw new Error('半屏档未一键关闭：st=' + t.dm.st + ' clicks=' + t.dm.clicks);
});

run('切换字幕后抹掉 B 站自己的「字幕已切换至 xx」提示', async () => {
  const { t, press } = subEnv({
    tracks: [{ lan: 'zh-CN', doc: '中文（简体）' }, { lan: 'en-US', doc: 'English(US)' }],
    items: [{ lan: 'zh-CN', doc: '中文（简体）' }, { lan: 'en-US', doc: 'English(US)' }],
  });
  t.step(16); t.step(16);
  const toast = t.setSubToast('字幕已切换至 中文（简体）');
  press();
  await t.settle();
  for (let i = 0; i < 5; i++) t.step(16);      // 点中中文后，B 站同时弹提示
  if (toast.box.style.display !== 'none') throw new Error('提示条没被抹掉');
});

run('不误伤不含字幕切换字样的提示 / 正文', async () => {
  const { t, press } = subEnv({ tracks: [{ lan: 'zh-CN', doc: '中文' }], items: [{ lan: 'zh-CN', doc: '中文' }] });
  t.step(16); t.step(16);
  const toast = t.setSubToast('已开启弹幕');
  press();
  await t.settle();
  for (let i = 0; i < 5; i++) t.step(16);
  if (toast.box.style.display === 'none') throw new Error('误伤了其它提示');
});

run('没有 toast 外壳的普通文字不会被隐藏', async () => {
  const { t, press } = subEnv({ tracks: [{ lan: 'zh-CN', doc: '中文' }], items: [{ lan: 'zh-CN', doc: '中文' }] });
  t.step(16); t.step(16);
  const el = t.setSubToast('字幕已切换至 中文').inner;
  el.parentElement = null;                       // 没有 toast 壳，只是页面正文
  press();
  await t.settle();
  for (let i = 0; i < 5; i++) t.step(16);
  if (el.style.display === 'none') throw new Error('把正文文字隐藏了');
});

run('切换时优先点「自己这个播放器」的菜单项（同名也不点别家）', async () => {
  const { t, press } = subEnv({
    tracks: [{ lan: 'zh-CN', doc: '中文（简体）' }],
    items: [{ lan: 'zh-CN', doc: '中文（简体）' }],
    other: [{ lan: 'zh-CN', doc: '中文（中国）' }],
  });
  t.step(16); t.step(16);
  press();
  await t.settle();
  for (let i = 0; i < 5; i++) t.step(16);
  if (!t.subEls[0]._cls.has('active')) throw new Error('没选中自己播放器的语言');
  if (t.otherEls.some((e) => e._cls.has('active'))) throw new Error('点到了别的播放器的菜单项');
});

run('菜单挂到页面级（无播放器归属）时兜底全页找', async () => {
  const { t, press } = subEnv({ tracks: [{ lan: 'zh-CN', doc: '中文' }], items: [{ lan: 'zh-CN', doc: '中文' }] });
  t.subEls[0].closest = () => null;            // 菜单被 portal 到 body，没有播放器归属
  t.step(16); t.step(16);
  press();
  await t.settle();
  for (let i = 0; i < 5; i++) t.step(16);
  if (!t.subEls[0]._cls.has('active')) throw new Error('兜底没找到菜单项');
});

run('设置面板里的固定语言模板不会被循环（它不在接口的轨道列表里）', async () => {
  const { t, press } = subEnv({
    tracks: [{ lan: 'zh-CN', doc: '中文（简体）' }],   // 接口说只有 1 条真实轨道
    items: [
      { lan: 'zh-CN', doc: '中文（简体）' },          // 真实轨道
    ],
    other: [   // 设置面板里的 24 语言模板（lan 不在接口列表里）
      { lan: 'zh-Hans', doc: '中文（简体）' },
      { lan: 'en-US', doc: 'English(US)' },
      { lan: 'ase', doc: '美国手语' },
    ],
  });
  t.step(16); t.step(16);
  if (t.ctx.subTotal() !== 2) throw new Error('状态总数应为 2（关 + 中文），得到 ' + t.ctx.subTotal());
  press();                       // → 中文
  await t.settle();
  for (let i = 0; i < 5; i++) t.step(16);
  if (!t.subEls[0]._cls.has('active')) throw new Error('没点中真实的中文轨道');
  if (t.otherEls.some((e) => e._cls.has('active'))) throw new Error('点到了语言模板');
  press();                       // → 关
  for (let i = 0; i < 3; i++) t.step(16);
  if (t.ctx.chrome.storage.sync.store.subIndex !== 0) throw new Error('未循环回关');
});

run('菜单项懒渲染时：R1 自动展开菜单并把这次切换补上', async () => {
  const t = makeCtx();
  t.setSubApi({ aid: 1, cid: 2, pages: [{ cid: 2 }] },
    { lan: '', subtitles: [{ lan: 'zh-CN', lan_doc: '中文（简体）' }, { lan: 'en-US', lan_doc: 'English(US)' }] });
  t.setSubItems([{ name: '中文（简体）', lan: 'zh-CN' }, { name: 'English(US)', lan: 'en-US' }], null, { lazy: true });
  t.step(16); t.step(16);

  t.pad.buttons[5].pressed = false; t.step(16);
  t.pad.buttons[5].pressed = true; t.step(16);      // 按下 R1：先拉轨道 + 展开菜单
  await t.settle();                                  // 等接口返回
  for (let i = 0; i < 10; i++) t.step(16);           // 主循环展开菜单 + 补点

  if (t.getSubMenuOpens() < 1) throw new Error('没有去展开字幕菜单');
  if (t.ctx.chrome.storage.sync.store.subIndex !== 1) {
    throw new Error('补切没生效，subIndex=' + t.ctx.chrome.storage.sync.store.subIndex);
  }
  if (!t.subEls[0]._cls.has('active')) throw new Error('没有选中第 1 条语言');
});

run('接口返回空轨道时不去点任何东西（纯 CSS 开关）', async () => {
  const { t, press } = subEnv({ tracks: [] });
  t.step(16); t.step(16);
  press();
  await t.settle();
  for (let i = 0; i < 20; i++) t.step(16);
  if (t.subClicks.total !== 0) throw new Error('不该点任何东西：' + t.subClicks.total);
  if (t.getSubMenuOpens() !== 0) throw new Error('没有语言项可点，不该去展开菜单');
  if (t.ctx.chrome.storage.sync.store.subIndex !== 1) throw new Error('没切到开');
});

run('菜单始终渲染不出菜单项时也能干净收尾（不卡住、状态仍推进）', async () => {
  const t = makeCtx();
  t.setSubApi({ aid: 1, cid: 2, pages: [{ cid: 2 }] },
    { lan: '', subtitles: [{ lan: 'zh-CN', lan_doc: '中文' }] });
  // 有字幕按钮，但点了也渲染不出语言项
  t.setSubItems([], null, { lazy: true });
  t.step(16); t.step(16);
  t.pad.buttons[5].pressed = false; t.step(16);
  t.pad.buttons[5].pressed = true; t.step(16);
  await t.settle();
  for (let i = 0; i < 30; i++) t.step(16);           // 等重试窗口耗尽
  if (t.ctx.chrome.storage.sync.store.subIndex !== 1) {
    throw new Error('状态没推进，subIndex=' + t.ctx.chrome.storage.sync.store.subIndex);
  }
});

main();
