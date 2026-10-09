// In-page check for scripts/ui-shot.ts: presses Play and reports every time the preview's frame
// counter stood still for more than 200 ms (headless Chrome jitters up to ~170 ms). A smooth timeline plays in about its own length.
//   node scripts/ui-shot.ts "http://localhost:5173/?port=…&token=…" out.png --step "$(cat scripts/playback-stalls.js)"
(async () => {
  const chip = document.querySelector('.preview-chip');
  const fps = Number(/(\d+(?:\.\d+)?) fps/.exec(chip?.textContent ?? '')?.[1] ?? 30);
  const frame = () => Number((chip?.querySelector('span:nth-child(2)')?.textContent ?? 'f -1').slice(2));
  const startFrame = frame();
  document.querySelector('button[title^="Play / Pause"]').click();
  const t0 = performance.now();
  const stalls = [];
  let last = startFrame;
  let end = startFrame;
  let lastChange = t0;
  while (performance.now() - lastChange < 2000 && performance.now() - t0 < 300000) {
    await new Promise((r) => setTimeout(r, 20));
    const f = frame();
    const now = performance.now();
    if (f === last) continue;
    if (now - lastChange > 200) stalls.push({ atFrame: last, ms: Math.round(now - lastChange) });
    last = f;
    end = Math.max(end, f);
    lastChange = now;
  }
  return { frames: end - startFrame, playedMs: Math.round(lastChange - t0), expectedMs: Math.round(((end - startFrame) / fps) * 1000), stalls };
})()
