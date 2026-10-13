// @inject-content @fake-gamepad
// 量浮窗在「未激发 / 扣扳机 / 刚松开 / 再次待命」四种状态下的实际尺寸
(async () => {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const read = (label) => {
    const h = document.querySelector('.pts-hud');
    if (!h) return { label, hud: 'MISSING' };
    const r = h.getBoundingClientRect();
    const cs = getComputedStyle(h);
    const sp = h.querySelector('.pts-sp b');
    const pad = h.querySelector('.pts-pad');
    return {
      label,
      w: Math.round(r.width), h: Math.round(r.height),
      opacity: cs.opacity,
      speed: sp ? sp.textContent : null,
      note: pad ? pad.textContent : null,
      padHeight: pad ? Math.round(pad.getBoundingClientRect().height) : null,
      padWidth: pad ? Math.round(pad.getBoundingClientRect().width) : null,
    };
  };
  const pad = __FAKE_PAD__;
  const out = [];
  await wait(1400);                     // 待命：手柄连接提示过去之后
  out.push(read('idle'));
  pad.buttons[7].value = 1; pad.buttons[7].pressed = true;
  await wait(700);
  out.push(read('RT held'));
  pad.buttons[7].value = 0; pad.buttons[7].pressed = false;
  await wait(200);
  out.push(read('just released'));
  await wait(1600);
  out.push(read('idle again'));
  return out;
})()
