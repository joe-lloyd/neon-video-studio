import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { neonHome } from '@neon/core/node';
import { runOrThrow } from './exec.ts';
import { STUDIO_VOICE_RUNNER } from './studio-voice-runner.ts';

export function studioVoiceRuntime() {
  const root = join(neonHome(), 'tools', 'studio-voice-runtime');
  return { root, python: join(root, process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python'), runner: join(root, 'studio_voice.py') };
}
export async function studioVoiceStatus(): Promise<{ available: boolean; provider: 'voicefixer'; device?: string }> {
  const runtime = studioVoiceRuntime();
  try {
    await access(runtime.python);
    const ready = JSON.parse(await readFile(join(runtime.root, 'ready.json'), 'utf8')) as { device?: string };
    return { available: true, provider: 'voicefixer', device: ready.device };
  } catch { return { available: false, provider: 'voicefixer' }; }
}
export async function restoreStudioVoice(input: string, output: string, onProgress?: (progress: number, message: string) => void): Promise<void> {
  const runtime = studioVoiceRuntime();
  if (!(await studioVoiceStatus()).available) throw new Error('Install the local Studio Voice model first (scripts/install-studio-voice.ps1).');
  await mkdir(runtime.root, { recursive: true });
  await writeFile(runtime.runner, STUDIO_VOICE_RUNNER);
  await runOrThrow(runtime.python, ['-u', runtime.runner, '--input', input, '--output', output], {
    env: { HF_HUB_OFFLINE: '1', HF_DATASETS_OFFLINE: '1' },
    onStdout: line => {
      if (line.startsWith('NEON_PROGRESS ')) onProgress?.(Number(line.slice(14)), 'Restoring voice locally…');
      else if (/Loading local|Restoring on|complete/.test(line)) onProgress?.(0, line);
    },
  });
}
