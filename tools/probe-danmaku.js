// @inject-content
// 端到端验证 R3 弹幕开关：注入扩展本体 + 假手柄按 R3，看真实开关档位与 HUD 提示。
// 依据实机探针结论（2026-10）：弹幕开关三档循环（全屏 → 半屏 → 关），
// 只有内层 checkbox 的 click 有效；R3 应做「全开 ⇄ 关」两态切换（跳过半屏档）。
// 用法：node tools/cdp-probe.js "https://www.bilibili.com/video/BV1xx411c7mD" tools/probe-danmaku.js
(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  for (let i = 0; i < 60 && !document.querySelector('.bpx-player-container'); i++) await sleep(500);
  const root = document.querySelector('.bpx-player-container');
  if (!root) return JSON.stringify({ fail: 'no player' });
  await sleep(2500);   // 等播放器挂稳 + 扩展注入后跑几帧

  cfg.enabled = true;
  const pad = __FAKE_PAD__;

  const stOf = () => {
    const m = ((root.querySelector('.bpx-player-dm-switch') || {}).className || '')
      .match(/bui-danmaku-switch-state-(\d)/);
    return m ? Number(m[1]) : null;
  };
  const isOpen = () => { try { return window.player.danmaku.isOpen(); } catch (e) { return 'err'; } };
  const note = () => {
    const el = document.querySelector('.pts-hud .pts-pad');
    return el ? el.textContent : '(no hud)';
  };
  const pressR3 = async () => {
    pad.buttons[11].pressed = true; pad.buttons[11].value = 1;
    await sleep(250);                       // 按住几帧，让主循环吃到按下沿
    const n = note();                       // 在提示还亮着时读 HUD
    pad.buttons[11].pressed = false; pad.buttons[11].value = 0;
    await sleep(400);
    return n;
  };

  const out = [{ step: 'start', st: stOf(), isOpen: isOpen(), note: note() }];
  for (let i = 1; i <= 3; i++) {
    const n = await pressR3();
    out.push({ step: 'R3#' + i, st: stOf(), isOpen: isOpen(), note: n });
  }
  // 期望：1 →(关) 3 →(开) 1 →(关) 3，HUD 提示对应 关/开/关
  const ok = out[1].st === 3 && out[1].note === '弹幕：关' &&
    out[2].st === 1 && out[2].note === '弹幕：开' &&
    out[3].st === 3 && out[3].note === '弹幕：关';
  return JSON.stringify({ ok, out }, null, 1);
})()
