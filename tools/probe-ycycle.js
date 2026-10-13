// @inject-content
(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  for (let i = 0; i < 60 && !document.querySelector('.bpx-player-ctrl-full'); i++) await sleep(500);
  if (!document.querySelector('.bpx-player-ctrl-full')) return JSON.stringify({ fail: 'no control bar' });
  cfg.enabled = true; cfg.yFull = true; cfg.yCycle = true;
  const pad = __FAKE_PAD__;
  const pressY = async () => {
    pad.buttons[3].pressed = true; pad.buttons[3].value = 1;
    await sleep(150);
    pad.buttons[3].pressed = false; pad.buttons[3].value = 0;
    await sleep(900);
  };
  const state = (label) => ({
    label,
    det: detectViewMode(),
    fs: !!document.fullscreenElement,
    cont: (document.querySelector('.bpx-player-container') || {}).className || '',
    wideEntered: (document.querySelector('.bpx-player-ctrl-wide') || { className: '' }).className.includes('entered'),
    webEntered: (document.querySelector('.bpx-player-ctrl-web') || { className: '' }).className.includes('entered'),
  });
  const out = [state('start')];
  for (let i = 1; i <= 5; i++) { await pressY(); out.push(state('press' + i)); }
  return JSON.stringify(out, null, 1);
})()
