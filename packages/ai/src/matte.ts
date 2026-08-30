/**
 * Background removal → ProRes 4444 .mov with alpha. Two engines:
 *   person  – Apple Vision person segmentation (neon-vision helper), no green screen needed
 *   chroma  – ffmpeg chromakey for real green/blue screens
 */
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run, runOrThrow, ffmpegTime } from './exec.ts';
import { probe } from './probe.ts';
import type { ToolPaths } from './tools.ts';

export interface MatteResult {
  mode: 'person' | 'chroma';
  frames?: number;
  fps: number;
}

export async function chromaMatte(
  file: string,
  out: string,
  opts: { paths: ToolPaths; color: string; similarity: number; blend: number; onProgress?: (p: number) => void },
): Promise<MatteResult> {
  const info = await probe(opts.paths.ffprobe, file);
  const vf = `chromakey=${opts.color}:${opts.similarity}:${opts.blend},format=yuva444p10le`;
  const args = ['-v', 'error', '-stats', '-y', '-i', file, '-vf', vf, '-c:v', 'prores_ks', '-profile:v', '4444', '-pix_fmt', 'yuva444p10le'];
  if (info.hasAudio) args.push('-c:a', 'copy');
  args.push(out);
  await runOrThrow(opts.paths.ffmpeg, args, {
    onStderr: (line) => {
      const t = ffmpegTime(line);
      if (t !== null && info.durationSeconds) opts.onProgress?.(Math.min(0.99, t / info.durationSeconds));
    },
  });
  return { mode: 'chroma', fps: info.fps ?? 30 };
}

export async function personMatte(
  file: string,
  out: string,
  opts: { paths: ToolPaths; quality: 'fast' | 'balanced' | 'accurate'; onProgress?: (p: number, message?: string) => void },
): Promise<MatteResult> {
  if (!opts.paths.vision) throw new Error('Person matting needs the neon-vision helper (macOS + Xcode command line tools).');
  const info = await probe(opts.paths.ffprobe, file);
  const fps = info.fps ?? 30;
  const dir = await mkdtemp(join(tmpdir(), 'neon-matte-'));
  const inDir = join(dir, 'in');
  const outDir = join(dir, 'out');
  await mkdir(inDir, { recursive: true });
  try {
    opts.onProgress?.(0.02, 'Extracting frames');
    await runOrThrow(opts.paths.ffmpeg, ['-v', 'error', '-y', '-i', file, '-vsync', '0', join(inDir, '%06d.png')]);
    const total = Math.max(1, Math.round(info.durationSeconds * fps));
    opts.onProgress?.(0.1, 'Segmenting people (Apple Vision)');
    const seg = await run(opts.paths.vision, ['segment', inDir, outDir, opts.quality], {
      onStderr: (line) => {
        const m = /progress (\d+)\/(\d+)/.exec(line);
        if (m) opts.onProgress?.(0.1 + 0.7 * (Number(m[1]) / Math.max(1, Number(m[2]))), `Segmenting ${m[1]}/${m[2]}`);
      },
    });
    if (seg.code !== 0) throw new Error(`neon-vision failed: ${seg.stderr.slice(-300)}`);
    opts.onProgress?.(0.82, 'Encoding ProRes 4444 with alpha');
    const args = ['-v', 'error', '-stats', '-y', '-framerate', String(fps), '-i', join(outDir, '%06d.png')];
    if (info.hasAudio) args.push('-i', file, '-map', '0:v:0', '-map', '1:a:0', '-c:a', 'copy');
    args.push('-c:v', 'prores_ks', '-profile:v', '4444', '-pix_fmt', 'yuva444p10le', '-shortest', out);
    await runOrThrow(opts.paths.ffmpeg, args, {
      onStderr: (line) => {
        const t = ffmpegTime(line);
        if (t !== null && info.durationSeconds) opts.onProgress?.(0.82 + 0.17 * Math.min(1, t / info.durationSeconds));
      },
    });
    return { mode: 'person', frames: total, fps };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}
