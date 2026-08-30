/** Timecode helpers. All conversions are frame-accurate integers. */

export function framesToTimecode(frames: number, fps: number, opts: { showFrames?: boolean } = {}): string {
  const showFrames = opts.showFrames ?? true;
  const safe = Math.max(0, Math.floor(frames));
  const totalSeconds = Math.floor(safe / fps);
  const ff = safe - totalSeconds * fps;
  const hh = Math.floor(totalSeconds / 3600);
  const mm = Math.floor((totalSeconds % 3600) / 60);
  const ss = totalSeconds % 60;
  const pad = (n: number) => n.toString().padStart(2, '0');
  const base = `${pad(hh)}:${pad(mm)}:${pad(ss)}`;
  return showFrames ? `${base}:${pad(ff)}` : base;
}

export function framesToSeconds(frames: number, fps: number): number {
  return frames / fps;
}

export function secondsToFrames(seconds: number, fps: number): number {
  return Math.round(seconds * fps);
}

/**
 * Parse a flexible time expression into frames.
 *   "00:02:15"      → HH:MM:SS
 *   "00:02:15:12"   → HH:MM:SS:FF
 *   "02:15"         → MM:SS
 *   "02:15.5"       → MM:SS.fraction
 *   "12.5s" / "12.5"→ seconds
 *   "300f"          → frames
 *   300 (number)    → frames
 */
export function parseTimecode(input: string | number, fps: number): number {
  if (typeof input === 'number') {
    if (!Number.isFinite(input) || input < 0) throw new Error(`Invalid frame value: ${input}`);
    return Math.round(input);
  }
  const value = input.trim().toLowerCase();
  if (value === '') throw new Error('Empty timecode');

  const framesMatch = /^(\d+)f$/.exec(value);
  if (framesMatch) return Number(framesMatch[1]);

  const secondsMatch = /^(\d+(?:\.\d+)?)s?$/.exec(value);
  if (secondsMatch) return secondsToFrames(Number(secondsMatch[1]), fps);

  const parts = value.split(':');
  if (parts.length < 2 || parts.length > 4 || parts.some((p) => p === '' || !/^\d+(\.\d+)?$/.test(p))) {
    throw new Error(`Unrecognised timecode "${input}". Use HH:MM:SS[:FF], MM:SS, 12.5s or 300f.`);
  }
  const nums = parts.map(Number) as number[];
  let hh = 0;
  let mm = 0;
  let ss = 0;
  let ff = 0;
  if (nums.length === 2) [mm, ss] = nums as [number, number];
  else if (nums.length === 3) [hh, mm, ss] = nums as [number, number, number];
  else [hh, mm, ss, ff] = nums as [number, number, number, number];
  if (mm >= 60 || ss >= 60 || ff >= fps) {
    throw new Error(`Timecode "${input}" out of range for ${fps} fps`);
  }
  const wholeSeconds = hh * 3600 + mm * 60 + Math.floor(ss);
  const fractionalFrames = Math.round((ss - Math.floor(ss)) * fps);
  return wholeSeconds * fps + fractionalFrames + Math.round(ff);
}

/** Human friendly duration, e.g. "1m 12s" or "4.5s". */
export function formatDuration(frames: number, fps: number): string {
  const seconds = frames / fps;
  if (seconds < 60) return `${Number(seconds.toFixed(seconds < 10 ? 2 : 1))}s`;
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds - m * 60);
  return `${m}m ${s}s`;
}
