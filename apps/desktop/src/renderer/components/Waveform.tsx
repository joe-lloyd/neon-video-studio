import { useEffect, useRef } from 'react';
import { peakBetween } from '../lib/waveforms.ts';

/** Canvases wider than this are drawn at reduced resolution and stretched by CSS (browser limits). */
const MAX_CANVAS_PX = 8192;

/**
 * Draws the slice of an asset's peaks that a clip shows: source frames
 * [trimBefore, trimBefore + durationFrames) across the clip's pixel width. Audio clips get a
 * symmetric waveform, video clips a low bar strip so the name stays readable.
 */
export function Waveform({ peaks, trimBefore, durationFrames, fps, widthPx, color, mode }: {
  peaks: Uint8Array;
  trimBefore: number;
  durationFrames: number;
  fps: number;
  widthPx: number;
  color: string;
  mode: 'audio' | 'video';
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  const width = Math.max(1, Math.min(MAX_CANVAS_PX, Math.round(widthPx)));
  const height = mode === 'audio' ? 40 : 14;
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = color;
    ctx.globalAlpha = mode === 'audio' ? 0.55 : 0.45;
    const secondsPerPx = durationFrames / fps / width;
    const startSeconds = trimBefore / fps;
    const mid = height / 2;
    for (let x = 0; x < width; x++) {
      const t0 = startSeconds + x * secondsPerPx;
      const peak = peakBetween(peaks, t0, t0 + secondsPerPx) / 255;
      if (peak <= 0) continue;
      if (mode === 'audio') {
        const h = Math.max(1, peak * (height - 2));
        ctx.fillRect(x, mid - h / 2, 1, h);
      } else {
        const h = Math.max(1, peak * height);
        ctx.fillRect(x, height - h, 1, h);
      }
    }
  }, [peaks, trimBefore, durationFrames, fps, width, height, color, mode]);
  return <canvas ref={ref} className={`wave-canvas ${mode}`} style={{ width: '100%', height }} />;
}
