import { runOrThrow, ffmpegTime } from './exec.ts';
import type { ToolPaths } from './tools.ts';

export type DenoiseEngine = 'rnnoise' | 'afftdn' | 'deepfilter';

export function chooseDenoiseEngine(paths: ToolPaths, requested: 'auto' | DenoiseEngine): DenoiseEngine {
  if (requested !== 'auto') return requested;
  if (paths.deepFilter) return 'deepfilter';
  if (paths.rnnoiseModel) return 'rnnoise';
  return 'afftdn';
}

/**
 * Produce a denoised copy of `file` at `out`. Video streams are copied untouched; only audio is
 * re-encoded (AAC). `strength` 0..1 blends between dry and fully processed signal.
 */
export async function denoise(
  file: string,
  out: string,
  opts: { paths: ToolPaths; engine: DenoiseEngine; strength: number; hasVideo: boolean; durationSeconds?: number; onProgress?: (p: number) => void },
): Promise<{ engine: DenoiseEngine; filter: string }> {
  const strength = Math.max(0, Math.min(1, opts.strength));
  let filter: string;
  if (opts.engine === 'deepfilter' && opts.paths.deepFilter) {
    // DeepFilterNet works on wav files; run it, then remux.
    const { mkdtemp, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = await mkdtemp(join(tmpdir(), 'neon-df-'));
    try {
      const wav = join(dir, 'in.wav');
      await runOrThrow(opts.paths.ffmpeg, ['-v', 'error', '-y', '-i', file, '-vn', '-ac', '1', '-ar', '48000', wav]);
      await runOrThrow(opts.paths.deepFilter, ['-o', dir, wav]);
      const cleaned = join(dir, 'in_DeepFilterNet3.wav');
      const args = opts.hasVideo
        ? ['-v', 'error', '-y', '-i', file, '-i', cleaned, '-map', '0:v:0', '-map', '1:a:0', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-shortest', out]
        : ['-v', 'error', '-y', '-i', cleaned, '-c:a', 'aac', '-b:a', '192k', out];
      await runOrThrow(opts.paths.ffmpeg, args);
      return { engine: 'deepfilter', filter: 'DeepFilterNet3' };
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  }
  if (opts.engine === 'rnnoise' && opts.paths.rnnoiseModel) {
    // arnndn wants 48 kHz mono/stereo; mix controls dry/wet.
    filter = `aresample=48000,arnndn=m='${opts.paths.rnnoiseModel.replace(/'/g, "\\'")}':mix=${strength.toFixed(2)}`;
  } else {
    // Spectral FFT denoiser: nr = noise reduction in dB (up to ~30), nf = noise floor estimate.
    filter = `afftdn=nr=${Math.round(6 + strength * 24)}:nf=-${Math.round(28 + strength * 14)}:tn=1`;
    opts.engine = 'afftdn';
  }
  const args = ['-v', 'error', '-stats', '-y', '-i', file, '-af', filter];
  if (opts.hasVideo) args.push('-map', '0:v:0', '-map', '0:a:0', '-c:v', 'copy');
  args.push('-c:a', 'aac', '-b:a', '192k', out);
  await runOrThrow(opts.paths.ffmpeg, args, {
    onStderr: (line) => {
      const t = ffmpegTime(line);
      if (t !== null && opts.durationSeconds) opts.onProgress?.(Math.min(0.99, t / opts.durationSeconds));
    },
  });
  return { engine: opts.engine, filter };
}
