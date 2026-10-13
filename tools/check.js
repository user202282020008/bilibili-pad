// 每次改完都跑：node tools/check.js
// 1) manifest 合法性 + 引用文件存在
// 2) 所有 content 脚本 + popup 的语法
// 3) 弹窗里 DEFAULTS 的每一项都有对应控件（开关/滑块），避免新增配置忘了加 UI
// 4) 冒烟测试
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const root = path.join(__dirname, '..');
let bad = 0;
const ok = (m) => console.log('  ok  ' + m);
const err = (m) => { bad++; console.log(' FAIL ' + m); };

// 1. manifest
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
ok('manifest.json 可解析');

const contentFiles = [];
for (const cs of manifest.content_scripts || []) {
  for (const f of cs.js || []) contentFiles.push(f);
}
if (!contentFiles.length) err('manifest 里没有 content script');

const refs = ['popup.html', 'popup.js', ...contentFiles, ...Object.values(manifest.icons || {})];
for (const f of refs) {
  if (fs.existsSync(path.join(root, f))) ok('文件存在 ' + f);
  else err('缺少文件 ' + f);
}

// 2. 语法
for (const f of [...contentFiles, 'popup.js']) {
  try {
    execFileSync(process.execPath, ['--check', path.join(root, f)], { stdio: 'pipe' });
    ok('语法 ' + f);
  } catch (e) { err('语法 ' + f + ': ' + e.stderr); }
}

// 3. 配置项与弹窗控件对应
const html = fs.readFileSync(path.join(root, 'popup.html'), 'utf8');
const popup = fs.readFileSync(path.join(root, 'popup.js'), 'utf8');
// content 侧是多个文件共用一个隔离作用域，拼起来当作一份源码来分析
const content = contentFiles
  .map((f) => fs.readFileSync(path.join(root, f), 'utf8'))
  .join('\n');

const m = popup.match(/const DEFAULTS = \{([\s\S]*?)\n\};/);
const keys = [...m[1].matchAll(/^\s*(\w+):/gm)].map((x) => x[1]);
for (const k of keys) {
  const hasEl = new RegExp('id="' + k + '"').test(html);
  const special = k === 'subIndex' || k === 'v2' || k === 'base';
  if (hasEl) ok('控件 ' + k);
  else if (special) ok('控件 ' + k + '（特殊处理：baseNum / subIndex 内部状态 / 版本标记）');
  else err('弹窗缺少 ' + k + ' 的控件');
  if (!content.includes(k) && k !== 'v2') err('content 未使用配置 ' + k);
}
// content 的 DEFAULTS 必须与 popup 一致
const cm = content.match(/const DEFAULTS = \{([\s\S]*?)\n\};/);
const ckeys = [...cm[1].matchAll(/^\s*(\w+):/gm)].map((x) => x[1]);
for (const k of ckeys) if (!keys.includes(k)) err('content 有但弹窗没有的配置：' + k);
for (const k of keys) if (!ckeys.includes(k)) err('弹窗有但 content 没有的配置：' + k);

// 4. HUD 尺寸稳定：宽高必须写死，否则提示文字长短变化时浮窗会跳变
const hudCss = content.match(/\.pts-hud\{[^}]*\}/);
if (!hudCss) err('找不到 .pts-hud 样式');
else if (/min-width/.test(hudCss[0])) err('.pts-hud 用了 min-width —— 提示文字变化时浮窗会跳尺寸');
else if (!/\bwidth:\s*\d+px/.test(hudCss[0])) err('.pts-hud 缺少固定 width');
else ok('HUD 宽度固定（不随提示文字伸缩）');

const padCss = content.match(/\.pts-hud \.pts-pad\{[^}]*\}/);
if (!padCss) err('找不到 .pts-pad 样式');
else if (/min-height/.test(padCss[0])) ok('HUD 提示行有固定最小高度');
else err('HUD 提示行缺少 min-height（提示为空时会塌陷）');

// 5. 权限自检：popup 用 chrome.scripting 补注入时，必须在 manifest 里声明好权限
if (/chrome\.scripting/.test(popup)) {
  if ((manifest.permissions || []).includes('scripting')) ok('manifest 声明了 scripting 权限');
  else err('popup 用了 chrome.scripting，但 manifest 缺少 "scripting" 权限');
  if ((manifest.host_permissions || []).length) ok('manifest 声明了 host_permissions');
  else err('用了 chrome.scripting，但 manifest 缺少 host_permissions');
  if (!/chrome\.runtime\.getManifest\(\)\.content_scripts/.test(popup)) {
    err('补注入的文件列表应取自 manifest.content_scripts，避免两处各写一份');
  } else ok('补注入的文件列表取自 manifest');
}

// 6. 冒烟测试
try {
  const out = execFileSync(process.execPath, [path.join(__dirname, 'smoke.js')], { encoding: 'utf8' });
  const pass = (out.match(/^PASS/gm) || []).length;
  const fail = (out.match(/^FAIL/gm) || []).length;
  if (fail) { err('冒烟测试 ' + fail + ' 项失败'); console.log(out); }
  else ok('冒烟测试 ' + pass + ' 项全通过');
} catch (e) { err('冒烟测试异常'); console.log(e.stdout || e.message); }

console.log(bad ? '\n共有 ' + bad + ' 个问题' : '\n检查全部通过');
process.exit(bad ? 1 : 0);
