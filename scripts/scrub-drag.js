// In-page step for scripts/scrub-check.sh: drags the timeline playhead back and forth for ~6 s like
// a hand scrubbing, lets go at 40%, and returns the preview's box as [x, y, width, height].
(() => {
  const r = document.querySelector('.tl-ruler').getBoundingClientRect();
  const y = r.top + r.height / 2;
  const at = (f) => r.left + 8 + f * (r.width - 16);
  const fire = (t, type, x) => t.dispatchEvent(new PointerEvent(type, { bubbles: true, clientX: x, clientY: y, pointerId: 1, isPrimary: true, button: 0, buttons: type === 'pointerup' ? 0 : 1 }));
  // A hand scrubbing back and forth for 6 s, then letting go at 40%.
  const path = [0.05, 0.35, 0.15, 0.75, 0.6, 0.95, 0.4];
  const steps = 360;
  fire(document.querySelector('.tl-ruler'), 'pointerdown', at(path[0]));
  let i = 0;
  const tick = () => {
    i++;
    const p = (i / steps) * (path.length - 1);
    const k = Math.min(path.length - 2, Math.floor(p));
    fire(window, 'pointermove', at(path[k] + (path[k + 1] - path[k]) * (p - k)));
    if (i < steps) setTimeout(tick, 16);
    else fire(window, 'pointerup', at(path[path.length - 1]));
  };
  tick();
  const w = document.querySelector('.player-wrap').getBoundingClientRect();
  return [Math.round(w.left), Math.round(w.top), Math.round(w.width), Math.round(w.height)];
})()
