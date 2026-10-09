// In-page check for scripts/ui-shot.ts: drags the timeline playhead like a person scrubbing and
// reports how often the preview had no picture during each drag and how long the picture took to
// appear after letting go. "Picture" means a visible <video> holding a decoded frame, not seeking.
//   node scripts/ui-shot.ts "http://localhost:5173/?port=…&token=…" out.png --step "$(cat scripts/scrub-check.js)"
(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const ruler = document.querySelector('.tl-ruler').getBoundingClientRect();
  const y = ruler.top + ruler.height / 2;
  const at = (f) => ruler.left + 8 + f * (ruler.width - 16);
  const picture = () => [...document.querySelectorAll('.player-wrap video')].some((v) => v.checkVisibility({ opacityProperty: true, visibilityProperty: true }) && v.readyState >= 2 && !v.seeking);
  const fire = (target, type, x) => target.dispatchEvent(new PointerEvent(type, { bubbles: true, clientX: x, clientY: y, pointerId: 1, isPrimary: true, button: 0, buttons: type === 'pointerup' ? 0 : 1 }));
  // Each drag: [from, to] as fractions of the visible ruler, swept in ~1.2 s like a hand.
  const drags = [[0.05, 0.3], [0.3, 0.12], [0.12, 0.7], [0.7, 0.66], [0.66, 0.95], [0.95, 0.4]];
  const results = [];
  for (const [a, b] of drags) {
    fire(document.querySelector('.tl-ruler'), 'pointerdown', at(a));
    let blank = 0;
    let samples = 0;
    for (let i = 1; i <= 72; i++) {
      fire(window, 'pointermove', at(a + ((b - a) * i) / 72));
      await sleep(16);
      samples++;
      if (!picture()) blank++;
    }
    fire(window, 'pointerup', at(b));
    const t0 = performance.now();
    while (!picture() && performance.now() - t0 < 10000) await sleep(10);
    results.push({ to: b, blankDuringDragPct: Math.round((100 * blank) / samples), msToPictureAfterRelease: Math.round(performance.now() - t0), gotPicture: picture() });
    await sleep(300);
  }
  return results;
})()
