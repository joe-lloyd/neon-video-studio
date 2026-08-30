/**
 * One-click voice enhancement: high-pass → (optional light neural denoise) → de-esser →
 * compressor → EBU R128 loudness normalisation. Produces a new asset like denoise does.
 */
import { ffmpegTime, runOrThrow } from './exec.ts';
import type { ToolPaths } from './tools.ts';

export interface EnhanceOptions {
  paths: ToolPaths;
  /** Target integrated loudness (LUFS), e.g. -16 for voice-over, -14 for social. */
  lufs: number;
  denoise: boolean;
  /** 0..1 – how hard the denoiser works when enabled. */
  strength: number;
  hasVideo: boolean;
  durationSeconds?: number;
  onProgress?: (p: number) => void;
}

export function buildEnhanceFilter(opts: Pick<EnhanceOptions, 'lufs' | 'denoise' | 'strength'> & { rnnoiseModel?: string }): string {
  const chain: string[] = ['highpass=f=75'];
  if (opts.denoise) {
    if (opts.rnnoiseModel) chain.push(`aresample=48000`, `arnndn=m='${opts.rnnoiseModel.replace(/'/g, "\\'")}':mix=${Math.min(0.9, 0.3 + opts.strength * 0.5).toFixed(2)}`);
    else chain.push(`afftdn=nr=${Math.round(6 + opts.strength * 10)}:nf=-32:tn=1`);
  }
  chain.push(
    'deesser=i=0.4',
    'acompressor=threshold=-18dB:ratio=3:attack=5:release=120:makeup=2',
    `loudnorm=I=${opts.lufs}:TP=-1.5:LRA=11`,
  );
  return chain.join(',');
}

export async function enhanceVoice(file: string, out: string, opts: EnhanceOptions): Promise<{ filter: string }> {
  const filter = buildEnhanceFilter({ lufs: opts.lufs, denoise: opts.denoise, strength: opts.strength, rnnoiseModel: opts.paths.rnnoiseModel });
  const args = ['-v', 'error', '-stats', '-y', '-i', file, '-af', filter];
  if (opts.hasVideo) args.push('-map', '0:v:0', '-map', '0:a:0', '-c:v', 'copy');
  args.push('-c:a', 'aac', '-b:a', '192k', out);
  await runOrThrow(opts.paths.ffmpeg, args, {
    onStderr: (line) => {
      const t = ffmpegTime(line);
      if (t !== null && opts.durationSeconds) opts.onProgress?.(Math.min(0.99, t / opts.durationSeconds));
    },
  });
  return { filter };
}
