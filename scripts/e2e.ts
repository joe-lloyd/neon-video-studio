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
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

interface Envelope<T> { ok: boolean; data?: T; error?: { code: string; message: string }; failedAt?: number; results?: unknown[] }

/** Run a CLI command with --json and return its parsed output and exit code. */
function run<T>(args: string[]): { status: number | null; parsed: Envelope<T> } {
  const r = spawnSync(process.execPath, [CLI, ...args, '--json'], { env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const line = r.stdout.trim().split('\n').filter(Boolean).join('\n');
  try {
    return { status: r.status, parsed: JSON.parse(line) as Envelope<T> };
  } catch {
    throw new Error(`neon-cli ${args.join(' ')} → exit ${r.status}, not JSON:\n${r.stdout}\n${r.stderr}`);
  }
}

/** Run a CLI command with --json and return `data`; throws with the CLI's error on failure. */
function cli<T = unknown>(...args: string[]): T {
  const { parsed } = run<T>(args);
  if (!parsed.ok) throw new Error(`neon-cli ${args.join(' ')} → ${parsed.error?.code}: ${parsed.error?.message}`);
  return parsed.data as T;
}

/** Run a CLI command that must fail: returns the failure envelope (exit 1 + ok:false). */
function cliFails(...args: string[]): Envelope<never> {
  const { status, parsed } = run<never>(args);
  if (parsed.ok || status !== 1) throw new Error(`neon-cli ${args.join(' ')} should fail with exit 1, got exit ${status}: ${JSON.stringify(parsed)}`);
  return parsed;
}

/** JSON with sorted object keys, to compare project documents. */
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) => (v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b))) : v));
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

  // The agent surface that needs no app: the route catalogue and plan checks.
  const routes = cli<{ route: string; method: string; body?: unknown }[]>('schema');
  assert(routes.some((r) => r.route === '/api/batch' && r.body) && routes.length > 40, `schema lists the routes offline, got ${routes.length}`);
  const ops = [
    { route: '/api/timeline/insert', body: { kind: 'component', componentName: 'TextOverlay', props: { text: 'Batch' }, at: 0, duration: '1s' } },
    { route: '/api/timeline/update', body: { id: '$0.id', patch: { name: 'Batched title' } } },
  ];
  const plan = join(home, 'plan.json');
  writeFileSync(plan, JSON.stringify(ops));
  cli('apply', plan, '--dry-run');
  log(`schema lists ${routes.length} routes and apply --dry-run checks a plan, both without the app`);

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
    const [imported] = cli<{ asset: { id: string; durationFrames: number }; clip: Clip }[]>('assets', 'import', media, '--at', '0');
    assert(imported, 'import returned one result');
    assert(imported.asset.durationFrames === 120, `probed duration 120 frames, got ${imported.asset.durationFrames}`);
    log('project created, clip imported (120 frames)');

    // The preview plays a quick-seek proxy instead; it must hold the same frames at the same times.
    const assetId = imported.asset.id;
    await until('the preview proxy', () => cli<{ proxies: { ready: string[] } }>('status').proxies.ready.includes(assetId), 120_000);
    const proxy = join(home, 'proxies', `${assetId}.mp4`);
    const probeLines = (file: string, args: string[]) => spawnSync(tool('ffprobe'), ['-v', 'error', '-select_streams', 'v:0', ...args, '-of', 'csv=p=0', file], { encoding: 'utf8' }).stdout.trim().split(/\s+/).filter(Boolean);
    const packets = (file: string) => probeLines(file, ['-count_packets', '-show_entries', 'stream=nb_read_packets'])[0];
    const keyframes = probeLines(proxy, ['-skip_frame', 'nokey', '-show_entries', 'frame=pts_time']).length;
    assert(packets(proxy) === packets(media), `proxy has ${packets(proxy)} frames, source ${packets(media)}`);
    assert(keyframes >= 12, `proxy keyframe every 10 frames (12+ in 4 s), got ${keyframes}`);
    log(`preview proxy matches the source frame for frame (${packets(proxy)} frames, ${keyframes} keyframes)`);

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

    // apply: a plan is one unit. A failing op rolls back the ops before it.
    const before = canonical(cli<{ project: unknown }>('state', 'dump').project);
    writeFileSync(plan, JSON.stringify({ ops: [...ops, { route: '/api/timeline/update', body: { id: 'clip_missing', patch: { name: 'never' } } }] }));
    const failed = cliFails('apply', plan);
    assert(failed.failedAt === 2 && failed.results?.length === 2 && failed.error?.code === 'NOT_FOUND', `third op fails after two ran: ${JSON.stringify(failed)}`);
    assert(canonical(cli<{ project: unknown }>('state', 'dump').project) === before, 'the failed batch left the project unchanged');
    log('apply: the failing third op rolled back the first two');

    writeFileSync(plan, JSON.stringify(ops));
    const applied = cli<{ results: (Clip & { name: string })[] }>('apply', plan);
    const [inserted, renamed] = applied.results;
    assert(inserted && renamed && renamed.id === inserted.id && renamed.name === 'Batched title', `"$0.id" reached op 1: ${JSON.stringify(applied.results)}`);
    const view = cli<{ tracks: { name: string; items: { type: string; id?: string; name?: string; component?: string; start: number; end: number }[] }[] }>('timeline', 'show');
    const shown = view.tracks.flatMap((t) => t.items).find((i) => i.id === renamed.id);
    assert(shown?.name === 'Batched title' && shown.component === 'TextOverlay' && shown.start === 0 && shown.end === 30, `timeline show lists the batched clip: ${JSON.stringify(shown)}`);
    log('apply: a valid plan landed and timeline show reflects it');

    cli('history', 'undo');
    assert(canonical(cli<{ project: unknown }>('state', 'dump').project) === before, 'one history undo reverts the whole batch');
    log('history undo reverted the batch in one step');

    if (!opts['no-render']) {
      const out = join(home, 'e2e.mp4');
      const job = cli<{ status: string; error?: string; outputPath: string }>('render', '--output', out, '--preset', 'draft');
      assert(job.status === 'done', `render finished: ${job.status} ${job.error ?? ''}`);
      const probe = spawnSync(tool('ffprobe'), ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', out], { encoding: 'utf8' });
      const seconds = Number(probe.stdout.trim());
      assert(Math.abs(seconds - 2.5) < 0.2, `rendered 2.5 s, got ${probe.stdout.trim()}`);
      log(`rendered ${out} (${seconds.toFixed(2)} s)`);

      // Frame 15 is the first frame after a cut join: it must show the picture, not dip to black.
      const luma = spawnSync(tool('ffmpeg'), ['-v', 'error', '-i', out, '-vf', 'select=eq(n\\,15),scale=1:1', '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'gray', '-'], { maxBuffer: 1024 });
      const level = luma.stdout[0] ?? 0;
      assert(level > 60, `frame after the cut is lit (mean luma ${level}), not a flash to black`);
      log(`cut join keeps the picture (frame 15 mean luma ${level})`);

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
