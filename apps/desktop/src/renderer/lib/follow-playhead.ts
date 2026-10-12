/**
 * Where the timeline should scroll so the playhead stays in view, or null to leave it.
 *
 * While playing it pages: when the playhead runs off the right edge, the view jumps so it sits
 * near the left. Otherwise (a seek from the Script tab, the CLI, Home/End) the playhead is
 * brought back to the centre once it leaves the middle 60% of the view, so clicking through
 * nearby words does not make the view jitter but no jump loses your place.
 */
export function followScroll(opts: { x: number; scrollLeft: number; width: number; playing: boolean }): number | null {
  const { x, scrollLeft, width, playing } = opts;
  if (playing) {
    if (x < scrollLeft || x > scrollLeft + width - 40) return Math.max(0, x - 60);
    return null;
  }
  const margin = width * 0.2;
  if (x >= scrollLeft + margin && x <= scrollLeft + width - margin) return null;
  return Math.max(0, Math.round(x - width / 2));
}
