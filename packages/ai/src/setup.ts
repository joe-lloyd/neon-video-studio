/** Install the local speech/denoise engines (whisper.cpp via Homebrew + model downloads). */
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { run, runOrThrow } from './exec.ts';
import { modelsDir, which } from './tools.ts';

export const WHISPER_MODELS: Record<string, { url: string; sizeMb: number }> = {
  'tiny.en': { url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-tiny.en.bin', sizeMb: 78 },
  'base.en': { url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin', sizeMb: 148 },
  'small.en': { url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.en.bin', sizeMb: 488 },
};
export const RNNOISE_MODEL_URL = 'https://raw.githubusercontent.com/GregorR/rnnoise-models/master/somnolent-hogwash-2018-09-01/sh.rnnn';

/** Copy-able commands for manual installation. */
export function setupCommands(model: keyof typeof WHISPER_MODELS = 'base.en'): string[] {
  return [
    'brew install whisper-cpp',
    `mkdir -p ~/.neon-video/models && curl -fL -o ~/.neon-video/models/ggml-${model}.bin ${WHISPER_MODELS[model]!.url}`,
    `curl -fL -o ~/.neon-video/models/std.rnnn ${RNNOISE_MODEL_URL}`,
  ];
}

export interface SetupOptions {
  whisper: boolean;
  rnnoise: boolean;
  ytdlp?: boolean;
  model: keyof typeof WHISPER_MODELS;
  onProgress?: (p: number, message: string) => void;
  onLog?: (line: string) => void;
}

export async function runSetup(opts: SetupOptions): Promise<{ installed: string[]; skipped: string[] }> {
  const installed: string[] = [];
  const skipped: string[] = [];
  await mkdir(modelsDir(), { recursive: true });
  const curl = (await which('curl')) ?? 'curl';

  if (opts.whisper) {
    if (await which('whisper-cli')) {
      skipped.push('whisper-cpp (already installed)');
    } else {
      const brew = await which('brew');
      if (!brew) throw new Error('Homebrew is required to install whisper-cpp automatically — run: ' + setupCommands(opts.model).join(' && '));
      opts.onProgress?.(0.05, 'brew install whisper-cpp (a few minutes)…');
      const r = await run(brew, ['install', 'whisper-cpp'], { onStderr: opts.onLog, onStdout: opts.onLog });
      if (r.code !== 0) throw new Error(`brew install whisper-cpp failed: ${r.stderr.slice(-200)}`);
      installed.push('whisper-cpp');
    }
    const target = join(modelsDir(), `ggml-${opts.model}.bin`);
    const exists = await import('node:fs/promises').then((fs) => fs.access(target).then(() => true, () => false));
    if (exists) {
      skipped.push(`ggml-${opts.model}.bin (already downloaded)`);
    } else {
      opts.onProgress?.(0.5, `Downloading Whisper model ${opts.model} (~${WHISPER_MODELS[opts.model]!.sizeMb} MB)…`);
      await runOrThrow(curl, ['-fL', '--retry', '3', '-o', target, WHISPER_MODELS[opts.model]!.url], { onStderr: opts.onLog });
      installed.push(`ggml-${opts.model}.bin`);
    }
  }
  if (opts.ytdlp) {
    if (await which('yt-dlp')) skipped.push('yt-dlp (already installed)');
    else {
      const brew = await which('brew');
      if (brew) {
        opts.onProgress?.(0.75, 'brew install yt-dlp…');
        const r = await run(brew, ['install', 'yt-dlp'], { onStderr: opts.onLog, onStdout: opts.onLog });
        if (r.code === 0) installed.push('yt-dlp');
        else opts.onLog?.(`yt-dlp install failed: ${r.stderr.slice(-150)}`);
      } else opts.onLog?.('Homebrew missing — install yt-dlp manually: brew install yt-dlp');
    }
  }
  if (opts.rnnoise) {
    const target = join(modelsDir(), 'std.rnnn');
    const exists = await import('node:fs/promises').then((fs) => fs.access(target).then(() => true, () => false));
    if (exists) skipped.push('rnnoise model (already downloaded)');
    else {
      opts.onProgress?.(0.9, 'Downloading RNNoise model…');
      await runOrThrow(curl, ['-fL', '--retry', '3', '-o', target, RNNOISE_MODEL_URL]);
      installed.push('std.rnnn');
    }
  }
  return { installed, skipped };
}
