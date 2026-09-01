/** Install the local speech/denoise engines (package manager where one exists + direct downloads). */
import { chmod, copyFile, mkdir, mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
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

/**
 * Static ffmpeg + ffprobe builds per OS: BtbN GitHub builds (win x64 / linux x64, one archive with
 * bin/ffmpeg + bin/ffprobe) and Martin Riedl (macOS arm64, one single-binary zip per tool).
 */
const FFMPEG_DOWNLOADS: Partial<Record<NodeJS.Platform, { url: string; archive: string }[]>> = {
  darwin: [
    { url: 'https://ffmpeg.martin-riedl.de/redirect/latest/macos/arm64/release/ffmpeg.zip', archive: 'ffmpeg.zip' },
    { url: 'https://ffmpeg.martin-riedl.de/redirect/latest/macos/arm64/release/ffprobe.zip', archive: 'ffprobe.zip' },
  ],
  linux: [{ url: 'https://github.com/BtbN/FFmpeg-Builds/releases/latest/download/ffmpeg-master-latest-linux64-gpl.tar.xz', archive: 'ffmpeg.tar.xz' }],
  win32: [{ url: 'https://github.com/BtbN/FFmpeg-Builds/releases/latest/download/ffmpeg-master-latest-win64-gpl.zip', archive: 'ffmpeg.zip' }],
};

/** Find files named like the wanted binaries anywhere in an extracted tree. */
async function findBinaries(dir: string, names: Set<string>, found: Map<string, string>): Promise<void> {
  for (const entry of await readdir(dir)) {
    const full = join(dir, entry);
    const s = await stat(full);
    if (s.isDirectory()) await findBinaries(full, names, found);
    else if (names.has(entry) && !found.has(entry)) found.set(entry, full);
  }
}

/**
 * Make sure ffmpeg AND ffprobe are available — the app's core media engines (import probing,
 * rip merging/conversion, denoise/enhance, voice-over recording). Installs the official static
 * builds into ~/.neon-video/tools when missing; no package manager needed on any platform.
 * Returns a short description of how they got there, or null when this platform has no build.
 */
export async function ensureFfmpeg(opts: { onProgress?: (p: number, message: string) => void; onLog?: (line: string) => void } = {}): Promise<string | null> {
  if ((await which('ffmpeg')) && (await which('ffprobe'))) return 'already installed';
  const downloads = FFMPEG_DOWNLOADS[process.platform];
  if (!downloads) return null;
  const wanted = process.platform === 'win32' ? new Set(['ffmpeg.exe', 'ffprobe.exe']) : new Set(['ffmpeg', 'ffprobe']);
  const curl = (await which('curl')) ?? 'curl';
  const tar = (await which('tar')) ?? 'tar'; // bsdtar: extracts zip AND tar.xz on mac/win/linux
  await mkdir(toolsDir(), { recursive: true });
  const work = await mkdtemp(join(tmpdir(), 'neon-ffmpeg-'));
  try {
    const found = new Map<string, string>();
    for (const [i, dl] of downloads.entries()) {
      const archive = join(work, dl.archive);
      opts.onProgress?.(0.1 + i * 0.35, `Downloading ${dl.archive.replace(/\.(zip|tar\.xz)$/, '')} (static build)…`);
      await runOrThrow(curl, ['-fL', '--retry', '3', '-o', archive, dl.url], { onStderr: opts.onLog });
      const out = join(work, `x${i}`);
      await mkdir(out, { recursive: true });
      await runOrThrow(tar, ['-xf', archive, '-C', out], { onStderr: opts.onLog });
    }
    await findBinaries(work, wanted, found);
    if (found.size !== wanted.size) throw new Error(`archive did not contain ${[...wanted].join(' + ')}`);
    opts.onProgress?.(0.9, 'Installing ffmpeg + ffprobe…');
    for (const [name, src] of found) {
      const target = join(toolsDir(), name);
      await copyFile(src, target);
      if (process.platform !== 'win32') await chmod(target, 0o755);
    }
    return `→ ${toolsDir()}`;
  } finally {
    await rm(work, { recursive: true, force: true }).catch(() => undefined);
  }
}

/**
 * Make sure yt-dlp is available: package manager when one exists (brew / winget), otherwise the
 * official static binary into ~/.neon-video/tools. Used by `ai setup` and on demand by the first
 * rip. Returns a short description of how it got there, or null when nothing worked.
 */
export async function ensureYtdlp(opts: { onProgress?: (p: number, message: string) => void; onLog?: (line: string) => void } = {}): Promise<string | null> {
  if (await which('yt-dlp')) return 'already installed';
  const pm = process.platform === 'darwin' ? await which('brew') : process.platform === 'win32' ? await which('winget') : undefined;
  if (pm) {
    const pmName = pm.split(/[\\/]/).pop() ?? pm;
    const args = process.platform === 'darwin'
      ? ['install', 'yt-dlp']
      : ['install', '--id', 'yt-dlp.yt-dlp', '-e', '--accept-source-agreements', '--accept-package-agreements', '--disable-interactivity'];
    opts.onProgress?.(0.1, `${pmName} install yt-dlp…`);
    const r = await run(pm, args, { onStderr: opts.onLog, onStdout: opts.onLog });
    if (r.code === 0 && (await which('yt-dlp'))) return `via ${pmName}`;
    opts.onLog?.(`package-manager install failed (${r.code}) — falling back to direct download`);
  }
  const dl = YTDLP_DOWNLOADS[process.platform];
  if (!dl) return null;
  await mkdir(toolsDir(), { recursive: true });
  const target = join(toolsDir(), dl.file);
  const curl = (await which('curl')) ?? 'curl';
  opts.onProgress?.(0.4, `Downloading yt-dlp (${dl.url.split('/').pop()})…`);
  await runOrThrow(curl, ['-fL', '--retry', '3', '-o', target, dl.url], { onStderr: opts.onLog });
  if (process.platform !== 'win32') await chmod(target, 0o755);
  return `→ ${target}`;
}

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
  ffmpeg?: boolean;
  model: keyof typeof WHISPER_MODELS;
  onProgress?: (p: number, message: string) => void;
  onLog?: (line: string) => void;
}

export async function runSetup(opts: SetupOptions): Promise<{ installed: string[]; skipped: string[] }> {
  const installed: string[] = [];
  const skipped: string[] = [];
  await mkdir(modelsDir(), { recursive: true });
  const curl = (await which('curl')) ?? 'curl';

  if (opts.ffmpeg) {
    const how = await ensureFfmpeg({ onProgress: (p, m) => opts.onProgress?.(0.02 + p * 0.1, m), onLog: opts.onLog }).catch((err) => {
      opts.onLog?.(String((err as Error).message ?? err));
      return null;
    });
    if (how === 'already installed') skipped.push('ffmpeg + ffprobe (already installed)');
    else if (how) installed.push(`ffmpeg + ffprobe (${how})`);
    else opts.onLog?.(`ffmpeg could not be installed automatically — ${setupHints().ffmpeg}`);
  }

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
      const how = await ensureYtdlp({ onProgress: (p, m) => opts.onProgress?.(0.75 + p * 0.1, m), onLog: opts.onLog }).catch((err) => {
        opts.onLog?.(String((err as Error).message ?? err));
        return null;
      });
      if (how) installed.push(`yt-dlp (${how})`);
      else opts.onLog?.(`yt-dlp could not be installed automatically — ${setupHints().ytdlp}`);
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
