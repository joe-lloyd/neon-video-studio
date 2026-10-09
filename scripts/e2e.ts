#!/usr/bin/env node
/**
 * End-to-end test through the public CLI, on any OS: boots a headless app in a throwaway NEON_HOME,
 * waits for it to self-install ffmpeg, builds a project, edits it, renders it and checks the output.
 *
 *   node scripts/e2e.ts [--keep] [--no-render]
 *
 * --keep       leave the temp home + outputs in place and print where they are
 * --no-render  skip the export step (for machines where Remotion's compositor cannot run)
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const { values: opts } = parseArgs({ options: { keep: { type: 'boolean', default: false }, 'no-render': { type: 'boolean', default: false } } });
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const CLI = join(ROOT, 'apps/cli/src/main.ts');
const home = mkdtempSync(join(tmpdir(), 'neon-e2e-'));
const env = { ...process.env, NEON_HOME: home };
const exe = process.platform === 'win32' ? '.exe' : '';

let step = 0;
function log(message: string): void {
  process.stdout.write(`[e2e ${String(++step).padStart(2, '0')}] ${message}\n`);
}

/** Run a CLI command with --json and return `data`; throws with the CLI's error on failure. */
function cli<T = unknown>(...args: string[]): T {
  const r = spawnSync(process.execPath, [CLI, ...args, '--json'], { env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const line = r.stdout.trim().split('\n').filter(Boolean).join('\n');
  let parsed: { ok: boolean; data?: T; error?: { code: string; message: string } };
  try {
    parsed = JSON.parse(line) as typeof parsed;
  } catch {
    throw new Error(`neon-cli ${args.join(' ')} → exit ${r.status}, not JSON:\n${r.stdout}\n${r.stderr}`);
  }
  if (!parsed.ok) throw new Error(`neon-cli ${args.join(' ')} → ${parsed.error?.code}: ${parsed.error?.message}`);
  return parsed.data as T;
}

function assert(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error(`assertion failed: ${message}`);
}

async function until<T>(what: string, fn: () => T | undefined | null | false, timeoutMs: number): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 2000));
  }
}

function tool(name: string): string {
  const local = join(home, 'tools', name + exe);
  return existsSync(local) ? local : name;
}

interface Clip { id: string; trackId: string; startFrame: number; durationFrames: number; kind: string }

async function main(): Promise<void> {
  log(`NEON_HOME=${home}`);
  const served = cli<{ endpoint: string; pid: number }>('serve', '--detach');
  log(`headless app up on ${served.endpoint} (pid ${served.pid})`);
  try {
    await until('ffmpeg to be installed', () => {
      const s = cli<{ ffmpeg: { available: boolean } }>('ai', 'status');
      return s.ffmpeg.available;
    }, 300_000);
    log('ffmpeg + ffprobe available');

    const media = join(home, 'clip.mp4');
    const gen = spawnSync(tool('ffmpeg'), ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=duration=4:size=1280x720:rate=30', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=4', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-preset', 'veryfast', '-c:a', 'aac', '-shortest', media], { encoding: 'utf8' });
    assert(gen.status === 0, `ffmpeg test media: ${gen.stderr}`);
    log('generated 4 s test clip');

    cli('project', 'new', '--name', 'E2E', '--fps', '30', '--width', '1280', '--height', '720');
    const [imported] = cli<{ asset: { durationFrames: number }; clip: Clip }[]>('assets', 'import', media, '--at', '0');
    assert(imported, 'import returned one result');
    assert(imported.asset.durationFrames === 120, `probed duration 120 frames, got ${imported.asset.durationFrames}`);
    log('project created, clip imported (120 frames)');

    const text = cli<Clip>('timeline', 'insert', '--component', 'TextOverlay', '--props', '{"text":"E2E"}', '--at', '1s', '--duration', '2s');
    assert(text.startFrame === 30 && text.durationFrames === 60, `TextOverlay at 30 for 60, got ${text.startFrame}+${text.durationFrames}`);
    log('TextOverlay inserted at 1 s');

    // `timeline cut` ripples by default: the 4 s timeline loses 1 s.
    cli('timeline', 'cut', '--from', '1s', '--to', '2s');
    const after = cli<{ durationFrames: number }>('state', 'dump');
    assert(after.durationFrames === 90, `ripple cut leaves 90 frames, got ${after.durationFrames}`);
    log('ripple cut removed 1 s (90 frames left)');

    if (!opts['no-render']) {
      const out = join(home, 'e2e.mp4');
      const job = cli<{ status: string; error?: string; outputPath: string }>('render', '--output', out, '--preset', 'draft');
      assert(job.status === 'done', `render finished: ${job.status} ${job.error ?? ''}`);
      const probe = spawnSync(tool('ffprobe'), ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', out], { encoding: 'utf8' });
      const seconds = Number(probe.stdout.trim());
      assert(Math.abs(seconds - 3) < 0.2, `rendered 3 s, got ${probe.stdout.trim()}`);
      log(`rendered ${out} (${seconds.toFixed(2)} s)`);
    }
  } finally {
    try {
      cli('stop');
      log('headless app stopped');
    } catch (err) {
      process.stderr.write(`stop failed: ${(err as Error).message}\n`);
    }
  }
}

main()
  .then(() => {
    process.stdout.write('E2E OK\n');
  })
  .catch((err: unknown) => {
    process.stderr.write(`E2E FAILED: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  })
  .finally(() => {
    if (opts.keep) process.stdout.write(`kept ${home}\n`);
    else {
      // The stopped app may still be flushing for a moment; give the rm a few tries.
      for (let i = 0; i < 5; i++) {
        try {
          rmSync(home, { recursive: true, force: true });
          break;
        } catch {
          spawnSync(process.execPath, ['-e', 'setTimeout(()=>{},500)']);
        }
      }
    }
  });
