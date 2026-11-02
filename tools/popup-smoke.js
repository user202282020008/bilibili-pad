// 弹窗事件与 storage 生命周期回归，不依赖浏览器或第三方包。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'popup.html'), 'utf8');
const source = fs.readFileSync(path.join(root, 'popup.js'), 'utf8');

function popup() {
  const elements = {};
  for (const match of html.matchAll(/<(\w+)\b([^>]*\bid="([^"]+)"[^>]*)>/g)) {
    elements[match[3]] = {
      tagName: match[1].toUpperCase(), type: (match[2].match(/type="([^"]+)"/) || [])[1],
      checked: false, value: '', disabled: false, events: {}, dataset: {},
      classList: { toggle() {} },
      addEventListener(name, fn) { this.events[name] = fn; },
    };
  }
  const listeners = [], timers = new Map(), store = {}, writes = [];
  let timerId = 0;
  let failNext = false;
  const change = (patch, area = 'sync') => {
    const changes = Object.fromEntries(Object.entries(patch).map(([k, v]) => [k, { newValue: v }]));
    listeners.forEach(fn => fn(changes, area));
  };
  const ctx = {
    document: { getElementById: id => elements[id], addEventListener() {} },
    window: { addEventListener() {} },
    setTimeout(fn) { timers.set(++timerId, fn); return timerId; },
    clearTimeout(id) { timers.delete(id); },
    chrome: {
      runtime: {},
      tabs: { query(filter, cb) { cb([]); } },
      storage: {
        sync: {
          get(defaults, cb) { cb({ ...defaults, ...store }); },
          set(patch, cb) {
            if (failNext) {
              failNext = false;
              ctx.chrome.runtime.lastError = { message: 'quota exceeded' };
              if (cb) cb();
              delete ctx.chrome.runtime.lastError;
              return;
            }
            writes.push({ ...patch }); Object.assign(store, patch);
            change(patch); if (cb) cb();
          },
        },
        local: { get(defaults, cb) { cb({ playerRate: 1.5 }); } },
        onChanged: { addListener(fn) { listeners.push(fn); } },
      },
    },
  };
  vm.runInNewContext(source, ctx);
  return {
    elements, store, writes, change,
    failNextSave() { failNext = true; },
    event(id, type, value) {
      const el = elements[id];
      if (value !== undefined) el[/^(checkbox|radio)$/.test(el.type) ? 'checked' : 'value'] = value;
      el.events[type]({ target: el, currentTarget: el });
    },
    flush() {
      const callbacks = [...timers.values()]; timers.clear();
      callbacks.forEach(fn => fn());
    },
  };
}

const cases = [
  ['启用开关立即保存，无需等待定时器或关闭事件', () => {
    const p = popup();
    p.event('enabled', 'input', false);
    assert.equal(p.store.enabled, false);
    p.event('enabled', 'input', true);
    assert.equal(p.store.enabled, true);
  }],
  ['跟随模式禁用两个默认值控件，更新基准不会关闭跟随', () => {
    const p = popup();
    assert.equal(p.elements.base.disabled, true);
    assert.equal(p.elements.baseNum.disabled, true);
    p.change({ playerRate: 2.25 }, 'local');
    assert.equal(p.elements.baseNum.value, '2.25');
    p.event('baseNum', 'change', '3');
    p.flush();
    assert.equal(p.elements.syncPlayer.checked, true);
    assert.equal(p.writes.length, 0);
  }],
  ['手动关闭跟随后才允许保存自定义值', () => {
    const p = popup();
    p.event('fixedBase', 'input', true);
    assert.equal(p.store.syncPlayer, false);
    assert.equal(p.elements.baseNum.disabled, false);
    p.event('baseNum', 'change', '2.5');
    p.flush();
    assert.equal(p.store.base, 2.5);
    assert.equal(p.store.syncPlayer, false);
  }],
  ['外部设置变化同步到弹窗开关', () => {
    const p = popup();
    p.change({ enabled: false, syncPlayer: false, base: 2 });
    assert.equal(p.elements.enabled.checked, false);
    assert.equal(p.elements.syncPlayer.checked, false);
    assert.equal(p.elements.baseNum.value, '2');
  }],
  ['恢复默认取消尚未保存的滑块改动', () => {
    const p = popup();
    p.event('rtMax', 'input', 5);
    p.event('reset', 'click');
    p.flush();
    assert.equal(p.store.rtMax, 3);
  }],
  ['两种默认倍速模式可双向切换且保留固定值', () => {
    const p = popup();
    p.event('fixedBase', 'input', true);
    p.event('baseNum', 'change', '2.5'); p.flush();
    p.event('syncPlayer', 'input', true);
    assert.equal(p.elements.fixedBase.checked, false);
    assert.equal(p.elements.fixedRate.hidden, true);
    p.event('fixedBase', 'input', true);
    assert.equal(p.elements.baseNum.value, '2.5');
    assert.equal(p.elements.followRate.hidden, true);
  }],
  ['失效的扳机设置同时禁用精确输入和滑块', () => {
    const p = popup();
    p.event('rtMaxRel', 'input', true);
    p.event('ltAccel', 'input', true);
    assert.equal(p.elements.rtMax.disabled, true);
    assert.equal(p.elements.rtMaxV.disabled, true);
    assert.equal(p.elements.ltMinV.disabled, true);
    assert.equal(p.elements.relativeCap.hidden, false);
    assert.equal(p.elements.slowRate.hidden, true);
  }],
  ['保存失败显示重试并重新保存实际设置', () => {
    const p = popup();
    p.failNextSave();
    p.event('enabled', 'input', false);
    assert.equal(p.elements.saveStatus.dataset.state, 'error');
    assert.equal(p.elements.save.hidden, false);
    p.event('save', 'click');
    assert.equal(p.store.enabled, false);
    assert.equal(p.elements.save.hidden, true);
    assert.equal(p.elements.saveStatus.dataset.state, 'normal');
  }],
];
for (const [name, test] of cases) {
  try { test(); console.log('PASS ' + name); }
  catch (error) { console.error('FAIL ' + name, error); process.exitCode = 1; }
}
