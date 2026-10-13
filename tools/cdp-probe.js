// 用 Chrome DevTools Protocol 开一个独立实例（临时 profile，不动你自己的浏览器），
// 加载真实页面后执行一段 JS 把结果打回来。用来核对 B 站播放器的真实 DOM 类名。
//
// 用法：node tools/cdp-probe.js <url> <js表达式文件路径>
//   node tools/cdp-probe.js "https://www.bilibili.com/video/BV1xx411c7mD" tools/probe-example.js
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const CHROME = process.env.CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = Number(process.env.CDP_PORT || 9333);
const PROFILE = path.join(os.tmpdir(), 'pts-cdp-profile');
const EXT = path.join(__dirname, '..');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// PTS_SRC 可以指向另一个项目目录，用来对比新旧实现（默认就是本项目）
const SRC_DIR = process.env.PTS_SRC || EXT;

function manifestJsFiles() {
  const m = JSON.parse(fs.readFileSync(path.join(SRC_DIR, 'manifest.json'), 'utf8'));
  return m.content_scripts[0].js;
}

// 假手柄：注入内容脚本之前先替换 navigator.getGamepads，
// 这样就能在真实页面上真的「按扳机 / 按键」驱动扩展
const FAKE_PAD = `(() => {
  const pad = { id: 'Fake Pad (PROBE)', connected: true, index: 0, mapping: 'standard',
    buttons: Array.from({ length: 17 }, () => ({ pressed: false, value: 0, touched: false })),
    axes: [0, 0, 0, 0], timestamp: 0, vibrationActuator: null };
  window.__fakePad = pad;
  try { navigator.getGamepads = () => [pad]; } catch (e) { /* ignore */ }
})()`;

async function json(pathname) {
  const r = await fetch('http://127.0.0.1:' + PORT + pathname);
  return r.json();
}

class CDP {
  constructor(ws) { this.ws = ws; this.seq = 0; this.pending = new Map(); }
  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('WS 连接失败')); });
    const c = new CDP(ws);
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      const p = m.id && c.pending.get(m.id);
      if (!p) return;
      c.pending.delete(m.id);
      if (m.error) p.reject(new Error(JSON.stringify(m.error)));
      else p.resolve(m.result);
    };
    return c;
  }
  send(method, params) {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params: params || {} }));
    });
  }
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', {
      expression, returnByValue: true, awaitPromise: true,
    });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception && r.exceptionDetails.exception.description);
    return r.result && r.result.value;
  }
}

async function main() {
  const url = process.argv[2];
  const exprFile = process.argv[3];
  if (!url || !exprFile) {
    console.error('用法: node tools/cdp-probe.js <url> <表达式文件>');
    process.exit(2);
  }
  let expr = fs.readFileSync(exprFile, 'utf8');
  // 探针首行写 // @inject-content 时，先把 content 源码整份注入页面（模拟内容脚本），
  // 然后再执行剩下的表达式。用来在真实站点上端到端验证 DOM 相关的逻辑。
  const inject = /^\/\/\s*@inject-content\b/.test(expr);
  if (inject) expr = expr.replace(/^\/\/\s*@inject-content\b[^\n]*\n/, '');
  // 探针里可以用 __HUD_CSS__ 拿到扩展真实注入的样式，避免手抄一份对不上
  if (expr.includes('__HUD_CSS__')) {
    const src = fs.readFileSync(path.join(EXT, 'src', '20-hud.js'), 'utf8');
    const m = src.match(/const HUD_CSS = `([\s\S]*?)`;/);
    expr = expr.replace(/__HUD_CSS__/g, JSON.stringify(m ? m[1] : ''));
  }

  fs.rmSync(PROFILE, { recursive: true, force: true });
  const chrome = spawn(CHROME, [
    '--headless=new',
    '--remote-debugging-port=' + PORT,
    '--user-data-dir=' + PROFILE,
    '--no-first-run', '--no-default-browser-check', '--disable-gpu',
    '--window-size=1400,900',
    '--autoplay-policy=no-user-gesture-required',
    // Chrome 137+ 默认禁掉了 --load-extension，这个开关把它放回来
    '--disable-features=DisableLoadExtensionCommandLineSwitch',
    '--enable-unsafe-extension-debugging',
    '--disable-extensions-except=' + EXT,
    '--load-extension=' + EXT,
    '--enable-logging=stderr',
    'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'] });

  // 收集 Chrome 自己的日志，方便排查「扩展没加载」这类问题
  const logs = [];
  chrome.stderr.on('data', (b) => {
    for (const line of String(b).split('\n')) {
      if (/extension|manifest|Failed to load|Invalid/i.test(line)) logs.push(line.trim());
    }
  });

  try {
    let up = false;
    for (let i = 0; i < 60 && !up; i++) {
      try { await json('/json/version'); up = true; } catch (e) { await sleep(250); }
    }
    if (!up) throw new Error('Chrome 调试端口没起来');

    const res = await fetch('http://127.0.0.1:' + PORT + '/json/new?' + encodeURIComponent(url), { method: 'PUT' });
    const target = await res.json();
    const cdp = await CDP.connect(target.webSocketDebuggerUrl);
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');

    // 等播放器挂上来
    for (let i = 0; i < 80; i++) {
      const ok = await cdp.eval('!!document.querySelector("video, .bpx-player-container, #bilibili-player")');
      if (ok) break;
      await sleep(500);
    }
    await sleep(2500);   // 再给播放器一点时间把各面板建出来

    if (inject) {
      if (expr.includes('__FAKE_PAD__') || /@fake-gamepad/.test(expr)) {
        // 探针里用 window.__fakePad 驱动按键；这里先把手柄接口换成假的
        await cdp.eval(FAKE_PAD);
        expr = expr.replace(/__FAKE_PAD__/g, 'window.__fakePad');
      }
      const src = manifestJsFiles().map((f) => fs.readFileSync(path.join(SRC_DIR, f), 'utf8')).join('\n;\n');
      await cdp.eval(src);          // CDP 求值不受页面 CSP 限制，当作内容脚本跑
      await sleep(800);
    }

    const out = await cdp.eval(expr);
    console.log(typeof out === 'string' ? out : JSON.stringify(out, null, 2));

    // 环境变量 SHOT=1 时顺手把当前页面截个图（可调式地截给定的 CSS 选择器区域）
    if (process.env.SHOT) {
      const shotDir = path.join(EXT, 'tools', 'preview');
      fs.mkdirSync(shotDir, { recursive: true });
      const clip = await cdp.eval(`(() => {
        const sel = ${JSON.stringify(process.env.SHOT_SEL || '')};
        if (!sel) return null;
        const el = document.querySelector(sel);
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { x: r.left - 8, y: r.top - 8, width: r.width + 16, height: r.height + 16, scale: 3 };
      })()`);
      const img = await cdp.send('Page.captureScreenshot', {
        format: 'png', ...(clip ? { clip } : {}),
      });
      const name = process.env.SHOT_NAME || 'probe-shot';
      fs.writeFileSync(path.join(shotDir, name + '.png'), Buffer.from(img.data, 'base64'));
      console.error('截图 → tools/preview/' + name + '.png');
    }
    if (logs.length) console.error('\n[chrome 日志]\n' + logs.slice(-15).join('\n'));
  } finally {
    try { chrome.kill(); } catch (e) { /* ignore */ }
  }
}

main().catch((e) => { console.error('ERR ' + e.message); process.exitCode = 1; });
