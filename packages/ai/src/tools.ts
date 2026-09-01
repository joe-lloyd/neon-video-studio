/** Locate the external engines the AI features rely on. Everything is optional and reported honestly. */
import { access, readdir } from 'node:fs/promises';
import { constants } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import type { AiCapabilities } from '@neon/core';
import { neonHome } from '@neon/core/node';
import { run } from './exec.ts';

export interface ToolPaths {
  ffmpeg: string;
  ffprobe: string;
  ytdlp?: string;
  whisper?: string;
  whisperModel?: string;
  rnnoiseModel?: string;
  deepFilter?: string;
  vision?: string;
}

const IS_WIN = process.platform === 'win32';
// PATH is often incomplete inside a bundled app, so also look in the usual install spots —
// and always in ~/.neon-video/tools, where `ai setup` drops binaries it downloads directly.
const SEARCH_DIRS = IS_WIN
  ? [join(homedir(), 'AppData', 'Local', 'Microsoft', 'WinGet', 'Links')]
  : ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin'];

async function exists(path: string, mode = constants.F_OK): Promise<boolean> {
  return access(path, mode).then(() => true, () => false);
}

export async function which(name: string): Promise<string | undefined> {
  const dirs = [...(process.env.PATH ?? '').split(delimiter), ...SEARCH_DIRS, toolsDir()].filter(Boolean);
  const names = IS_WIN && !/\.[a-z0-9]+$/i.test(name) ? [`${name}.exe`, `${name}.cmd`, `${name}.bat`, name] : [name];
  for (const dir of dirs) {
    for (const n of names) {
      const candidate = join(dir, n);
      // X_OK is meaningless on Windows — existence is the best signal there.
      if (await exists(candidate, IS_WIN ? constants.F_OK : constants.X_OK)) return candidate;
    }
  }
  return undefined;
}

export function modelsDir(): string {
  return join(neonHome(), 'models');
}

export function toolsDir(): string {
  return join(neonHome(), 'tools');
}

export function transcriptsDir(): string {
  return join(neonHome(), 'transcripts');
}

/** Compile the Swift Vision helper on demand (needs Xcode command line tools). */
export async function ensureVisionTool(): Promise<string | undefined> {
  const bin = join(toolsDir(), 'neon-vision');
  if (await exists(bin, constants.X_OK)) return bin;
  if (process.platform !== 'darwin') return undefined;
  const swiftc = await which('swiftc');
  if (!swiftc) return undefined;
  const src = join(dirname(fileURLToPath(import.meta.url)), '..', 'native', 'neon-vision.swift');
  if (!(await exists(src))) return undefined;
  const { mkdir } = await import('node:fs/promises');
  await mkdir(toolsDir(), { recursive: true });
  const r = await run(swiftc, ['-O', '-o', bin, src, '-framework', 'Vision', '-framework', 'CoreImage', '-framework', 'AppKit']);
  return r.code === 0 ? bin : undefined;
}

export async function detectTools(opts: { compileVision?: boolean } = {}): Promise<{ paths: ToolPaths; capabilities: AiCapabilities }> {
  const ffmpeg = (await which('ffmpeg')) ?? 'ffmpeg';
  const ffprobe = (await which('ffprobe')) ?? 'ffprobe';
  const whisper = (await which('whisper-cli')) ?? (await which('whisper-cpp')) ?? (await which('main'));
  let whisperModel: string | undefined;
  try {
    const files = (await readdir(modelsDir())).filter((f) => /^ggml-.*\.bin$/.test(f));
    const order = ['ggml-small.en.bin', 'ggml-base.en.bin', 'ggml-tiny.en.bin', 'ggml-small.bin', 'ggml-base.bin'];
    whisperModel = files.sort((a, b) => (order.indexOf(a) === -1 ? 99 : order.indexOf(a)) - (order.indexOf(b) === -1 ? 99 : order.indexOf(b)))[0];
    if (whisperModel) whisperModel = join(modelsDir(), whisperModel);
  } catch {
    /* no models dir */
  }
  let rnnoiseModel: string | undefined;
  try {
    const files = (await readdir(modelsDir())).filter((f) => f.endsWith('.rnnn'));
    if (files[0]) rnnoiseModel = join(modelsDir(), files[0]);
  } catch {
    /* ignore */
  }
  const deepFilter = await which('deep-filter');
  const ytdlp = await which('yt-dlp');
  const vision = opts.compileVision === false ? ((await exists(join(toolsDir(), 'neon-vision'))) ? join(toolsDir(), 'neon-vision') : undefined) : await ensureVisionTool();
  const claudeKey = Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN) || (await exists(join(homedir(), '.config', 'anthropic')));
  const paths: ToolPaths = { ffmpeg, ffprobe, ytdlp, whisper, whisperModel, rnnoiseModel, deepFilter, vision };
  const capabilities: AiCapabilities = {
    whisper: { available: Boolean(whisper && whisperModel), binary: whisper, model: whisperModel },
    rnnoise: { available: Boolean(rnnoiseModel), model: rnnoiseModel },
    deepfilter: { available: Boolean(deepFilter), binary: deepFilter },
    vision: { available: Boolean(vision), binary: vision },
    ytdlp: { available: Boolean(ytdlp), binary: ytdlp },
    ffmpeg: { available: await exists(ffmpeg, constants.X_OK) },
    claude: { available: claudeKey, model: claudeKey ? 'claude-opus-5' : undefined },
  };
  return { paths, capabilities };
}

const MODEL_URL = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin';
const RNNOISE_URL = 'https://raw.githubusercontent.com/GregorR/rnnoise-models/master/somnolent-hogwash-2018-09-01/sh.rnnn';

/** Copy-able install commands for the platform this process runs on (the app and CLI are always local). */
export function setupHints(platform: NodeJS.Platform = process.platform): Record<'whisper' | 'rnnoise' | 'deepfilter' | 'vision' | 'ytdlp' | 'ffmpeg' | 'claude', string> {
  const shared = {
    deepfilter: 'optional: install DeepFilterNet (deep-filter) from https://github.com/Rikorose/DeepFilterNet/releases',
    claude: 'optional: export ANTHROPIC_API_KEY=… (or `ant auth login`) to let Claude pick B-roll concepts',
  };
  if (platform === 'win32') {
    return {
      ...shared,
      whisper: 'use “Install automatically” in the AI panel (or `neon-cli ai setup`) — it downloads whisper-cli and the speech model for you',
      rnnoise: `curl.exe -L -o %USERPROFILE%\\.neon-video\\models\\std.rnnn ${RNNOISE_URL}`,
      vision: 'macOS only — person matting is unavailable on Windows',
      ytdlp: 'winget install yt-dlp.yt-dlp (or let “Install automatically” download it)',
      ffmpeg: 'winget install Gyan.FFmpeg',
    };
  }
  if (platform === 'linux') {
    return {
      ...shared,
      whisper: 'use “Install automatically” in the AI panel (or `neon-cli ai setup`) — it downloads whisper-cli and the speech model for you',
      rnnoise: `curl -L -o ~/.neon-video/models/std.rnnn ${RNNOISE_URL}`,
      vision: 'macOS only — person matting is unavailable on Linux',
      ytdlp: 'sudo apt install yt-dlp (or let “Install automatically” download it)',
      ffmpeg: 'sudo apt install ffmpeg',
    };
  }
  return {
    ...shared,
    whisper: `brew install whisper-cpp && curl -L -o ~/.neon-video/models/ggml-base.en.bin ${MODEL_URL}`,
    rnnoise: `curl -L -o ~/.neon-video/models/std.rnnn ${RNNOISE_URL}`,
    vision: 'macOS only: xcode-select --install (the helper compiles itself on first use)',
    ytdlp: 'brew install yt-dlp',
    ffmpeg: 'brew install ffmpeg',
  };
}

export const SETUP_HINTS = setupHints();
