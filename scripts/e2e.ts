#!/usr/bin/env node
/**
 * End-to-end test through the public CLI, on any OS: boots a headless app in a throwaway NEON_HOME,
 * waits for it to self-install ffmpeg, builds a project, edits it, renders it and checks the output,
 * then renders a still and a contact sheet and checks their PNG headers.
 *
 *   node scripts/e2e.ts [--keep] [--no-render]
 *
 * --keep       leave the temp home + outputs in place and print where they are
 * --no-render  skip the export step (for machines where Remotion's compositor cannot run)
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
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
interface Still { path: string; frames: number[]; width: number; height: number }

/** Width and height from a PNG's IHDR chunk, plus the file size. */
function png(file: string): { width: number; height: number; bytes: number } {
  const data = readFileSync(file);
  assert(data.toString('latin1', 1, 4) === 'PNG', `${file} is a PNG`);
  return { width: data.readUInt32BE(16), height: data.readUInt32BE(20), bytes: data.length };
}

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

    // Re-time the first second to 2×: 30 frames become 15, everything after ripples left.
    const first = cli<{ project: { clips: Clip[] } }>('state', 'dump').project.clips.filter((c) => c.kind === 'video').sort((a, b) => a.startFrame - b.startFrame)[0];
    assert(first, 'a video clip is on the timeline');
    const fast = cli<Clip & { speed?: number }>('timeline', 'speed', first.id, '2', '--from', '0', '--to', '1s');
    assert(fast.speed === 2 && fast.durationFrames === 15, `2× over 1 s → 15 frames, got ${fast.speed}× ${fast.durationFrames}f`);
    const timed = cli<{ durationFrames: number }>('state', 'dump');
    assert(timed.durationFrames === 75, `speed-up leaves 75 frames, got ${timed.durationFrames}`);
    log('first second re-timed to 2× (75 frames left)');

    const zoomed = cli<Clip & { zooms?: { start: number; end: number; zoom: number }[] }>('zoom', 'add', fast.id, '--from', '0', '--to', '15f', '--center', '0.25,0.25', '--zoom', '2');
    assert(zoomed.zooms?.length === 1 && zoomed.zooms[0]!.start === 0 && zoomed.zooms[0]!.end === 30, `zoom stored in source frames 0–30, got ${JSON.stringify(zoomed.zooms)}`);
    log('zoom added (stored as source frames 0–30)');

    if (!opts['no-render']) {
      const out = join(home, 'e2e.mp4');
      const job = cli<{ status: string; error?: string; outputPath: string }>('render', '--output', out, '--preset', 'draft');
      assert(job.status === 'done', `render finished: ${job.status} ${job.error ?? ''}`);
      const probe = spawnSync(tool('ffprobe'), ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', out], { encoding: 'utf8' });
      const seconds = Number(probe.stdout.trim());
      assert(Math.abs(seconds - 2.5) < 0.2, `rendered 2.5 s, got ${probe.stdout.trim()}`);
      log(`rendered ${out} (${seconds.toFixed(2)} s)`);

      // Stills: the PNG header must match the size asked for; a few KB at most means a blank frame.
      const still = cli<Still>('still', '--at', '1s', '--width', '640', '--out', join(home, 'still.png'));
      const stillPng = png(still.path);
      assert(still.frames[0] === 30 && stillPng.width === 640 && stillPng.height === 360, `still 640×360 at frame 30, got ${JSON.stringify(still)} / ${stillPng.width}×${stillPng.height}`);
      assert(stillPng.bytes > 20_000, `still has picture content (${stillPng.bytes} bytes)`);
      log(`still ${still.path} (${stillPng.width}×${stillPng.height})`);

      // 6 frames over the 75-frame timeline in a 3-column grid: 312×176 cells + 20 px labels, 6 px gaps.
      const sheet = cli<Still>('sheet', '--count', '6', '--cols', '3', '--width', '960', '--out', join(home, 'sheet.png'));
      const sheetPng = png(sheet.path);
      assert(JSON.stringify(sheet.frames) === '[6,18,31,43,56,68]', `sheet frames, got ${JSON.stringify(sheet.frames)}`);
      assert(sheetPng.width === 960 && sheetPng.height === 410 && sheet.height === 410, `sheet 960×410, got ${sheetPng.width}×${sheetPng.height}`);
      assert(sheetPng.bytes > 50_000, `sheet has picture content (${sheetPng.bytes} bytes)`);
      log(`sheet ${sheet.path} (${sheetPng.width}×${sheetPng.height}, ${sheet.frames.length} frames)`);
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
