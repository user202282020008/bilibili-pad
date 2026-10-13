// @inject-content
(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  for (let i = 0; i < 60 && !document.querySelector('video'); i++) await sleep(500);
  if (!document.querySelector('video')) return JSON.stringify({ fail: 'no video' });
  cfg.enabled = true; cfg.syncPlayer = false; cfg.base = 1; forceBase = true;
  await sleep(500);
  const v = document.querySelector('video');
  const before = v.playbackRate;
  // 模拟 B 站官方：长按 → 触发 keydown，播放器把倍速拉到 3
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
  await sleep(100);
  const boostFlag = kbdBoost;
  v.playbackRate = 3;
  await sleep(500);               // 若干帧：扩展不该把 3 盖回 1
  const during = v.playbackRate;
  // 松开 →，B 站恢复之前倍速
  window.dispatchEvent(new KeyboardEvent('keyup', { key: 'ArrowRight', bubbles: true }));
  v.playbackRate = 1;
  await sleep(500);
  const after = v.playbackRate;
  return JSON.stringify({ before, boostFlag, during, after, pass: during === 3 && after === 1 });
})()
