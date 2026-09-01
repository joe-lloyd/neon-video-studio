/** Install the local speech/denoise engines (package manager where one exists + direct downloads). */
import { chmod, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { run, runOrThrow } from './exec.ts';
import { modelsDir, setupHints, toolsDir, which } from './tools.ts';

export const WHISPER_MODELS: Record<string, { url: string; sizeMb: number }> = {
  'tiny.en': { url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-tiny.en.bin', sizeMb: 78 },
  'base.en': { url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin', sizeMb: 148 },
  'small.en': { url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.en.bin', sizeMb: 488 },
};
export const RNNOISE_MODEL_URL = 'https://raw.githubusercontent.com/GregorR/rnnoise-models/master/somnolent-hogwash-2018-09-01/sh.rnnn';

/** Official static yt-dlp binaries — the fallback when no package manager is available. */
const YTDLP_DOWNLOADS: Partial<Record<NodeJS.Platform, { url: string; file: string }>> = {
  darwin: { url: 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_macos', file: 'yt-dlp' },
  linux: { url: 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux', file: 'yt-dlp' },
  win32: { url: 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe', file: 'yt-dlp.exe' },
};

/** Copy-able commands for manual installation (platform-aware). */
export function setupCommands(model: keyof typeof WHISPER_MODELS = 'base.en'): string[] {
  const hints = setupHints();
  if (process.platform === 'darwin') {
    return [
      'brew install whisper-cpp',
      `mkdir -p ~/.neon-video/models && curl -fL -o ~/.neon-video/models/ggml-${model}.bin ${WHISPER_MODELS[model]!.url}`,
      `curl -fL -o ~/.neon-video/models/std.rnnn ${RNNOISE_MODEL_URL}`,
    ];
  }
  return [hints.whisper, hints.rnnoise];
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
    } else if (process.platform === 'darwin') {
      const brew = await which('brew');
      if (!brew) throw new Error('Homebrew is required to install whisper-cpp automatically — run: ' + setupCommands(opts.model).join(' && '));
      opts.onProgress?.(0.05, 'brew install whisper-cpp (a few minutes)…');
      const r = await run(brew, ['install', 'whisper-cpp'], { onStderr: opts.onLog, onStdout: opts.onLog });
      if (r.code !== 0) throw new Error(`brew install whisper-cpp failed: ${r.stderr.slice(-200)}`);
      installed.push('whisper-cpp');
    } else {
      // No trustworthy unattended install path off-macOS — models still download below once it's there.
      throw new Error(`whisper-cli can't be installed automatically on this platform — ${setupHints().whisper}`);
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
      // Prefer the platform package manager (gets updates), fall back to the official static binary.
      let done = false;
      const pm = process.platform === 'darwin' ? await which('brew') : process.platform === 'win32' ? await which('winget') : undefined;
      if (pm) {
        const args = process.platform === 'darwin'
          ? ['install', 'yt-dlp']
          : ['install', '--id', 'yt-dlp.yt-dlp', '-e', '--accept-source-agreements', '--accept-package-agreements', '--disable-interactivity'];
        opts.onProgress?.(0.75, `${pm.split(/[\\/]/).pop()} install yt-dlp…`);
        const r = await run(pm, args, { onStderr: opts.onLog, onStdout: opts.onLog });
        if (r.code === 0) {
          installed.push('yt-dlp');
          done = true;
        } else opts.onLog?.(`package-manager install failed (${r.code}) — falling back to direct download`);
      }
      const dl = YTDLP_DOWNLOADS[process.platform];
      if (!done && dl) {
        await mkdir(toolsDir(), { recursive: true });
        const target = join(toolsDir(), dl.file);
        opts.onProgress?.(0.78, `Downloading yt-dlp (${dl.url.split('/').pop()})…`);
        await runOrThrow(curl, ['-fL', '--retry', '3', '-o', target, dl.url], { onStderr: opts.onLog });
        if (process.platform !== 'win32') await chmod(target, 0o755);
        installed.push(`yt-dlp (→ ${target})`);
        done = true;
      }
      if (!done) opts.onLog?.(`yt-dlp could not be installed automatically — ${setupHints().ytdlp}`);
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
