/**
 * End-to-end: render a hand-built project directory through the real CLI (`render --headless`),
 * i.e. worker → esbuild bundle → Timeline composition in Chrome → FFmpeg. The project has a video
 * clip with its own audio, a separate audio clip with fades, built-in templates and a component
 * from an installed FX pack (copied into a temporary NEON_HOME, with one import rewritten to
 * `remotion` to cover the alias). Skips without ffmpeg or Chrome.
 *
 * Set NEON_E2E_KEEP=<dir> to keep the project and output for inspection.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveBrowserExecutable } from '@neon/motion/node';
import { ProjectSchema } from '@neon/core';

/** The compatibility import name external packs may use (kept out of literal `from '…'` form so migration scripts leave it alone). */
const COMPAT_NAME = ['re', 'motion'].join('');

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));

function has(cmd: string): boolean {
  return spawnSync(cmd, ['-version'], { stdio: 'ignore' }).status === 0;
}

async function chromeAvailable(): Promise<boolean> {
  try {
    await resolveBrowserExecutable({ allowDownload: false });
    return true;
  } catch {
    return false;
  }
}

function ffmpeg(args: string[]): Buffer {
  const r = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], { maxBuffer: 256 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`ffmpeg ${args.join(' ')} failed: ${r.stderr.toString()}`);
  return r.stdout;
}

async function addAsset(assetsDir: string, file: string, ext: string, meta: { name: string; kind: 'video' | 'audio'; mime: string; durationFrames: number; width?: number; height?: number; fps?: number }) {
  const data = await readFile(file);
  const id = createHash('sha256').update(data).digest('hex');
  await rename(file, join(assetsDir, `${id}.${ext}`));
  return { id, size: data.length, importedAt: new Date(0).toISOString(), ...meta };
}

/** Build <dir>/project.json + <dir>/assets/<sha256>.<ext>. */
export async function makeProjectFixture(dir: string): Promise<void> {
  const assets = join(dir, 'assets');
  await mkdir(assets, { recursive: true });
  const videoTmp = join(dir, 'video.tmp.mp4');
  const toneTmp = join(dir, 'tone.tmp.wav');
  ffmpeg(['-f', 'lavfi', '-i', 'testsrc2=s=640x360:r=30:d=4', '-f', 'lavfi', '-i', 'sine=frequency=330:duration=4', '-shortest', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', videoTmp]);
  ffmpeg(['-f', 'lavfi', '-i', 'sine=frequency=660:duration=5', '-c:a', 'pcm_s16le', toneTmp]);
  const video = await addAsset(assets, videoTmp, 'mp4', { name: 'testsrc.mp4', kind: 'video', mime: 'video/mp4', durationFrames: 120, width: 640, height: 360, fps: 30 });
  const tone = await addAsset(assets, toneTmp, 'wav', { name: 'tone.wav', kind: 'audio', mime: 'audio/wav', durationFrames: 150 });
  const now = new Date(0).toISOString();
  // Component props are complete, as the app stores them (it fills schema defaults on insert).
  const media = { volume: 1, fit: 'cover' as const, fadeIn: 0, fadeOut: 0, trimBefore: 0 };
  const project = {
    meta: { id: 'e2e', name: 'E2E', fps: 30, width: 640, height: 360, background: '#000000', createdAt: now, updatedAt: now, schemaVersion: 1, packs: ['boba-expressive'] },
    tracks: [
      { id: 'v', name: 'Video', kind: 'video', order: 0, muted: false, locked: false, hidden: false },
      { id: 'a', name: 'Audio', kind: 'audio', order: 1, muted: false, locked: false, hidden: false },
      { id: 'o', name: 'Overlay', kind: 'overlay', order: 2, muted: false, locked: false, hidden: false },
    ],
    clips: [
      { ...media, id: 'c-video', trackId: 'v', name: 'Video', kind: 'video', assetId: video.id, startFrame: 0, durationFrames: 90, trimBefore: 15, volume: 0.5 },
      { ...media, id: 'c-tone', trackId: 'a', name: 'Tone', kind: 'audio', assetId: tone.id, startFrame: 30, durationFrames: 90, fadeIn: 15, fadeOut: 15 },
      { id: 'c-boba', trackId: 'o', name: 'Boba', kind: 'component', componentName: 'BobaTitle', startFrame: 0, durationFrames: 60, props: { title: 'Neon Motion', subtitle: 'own render engine', textColor: '#ffffff', accentColor: '#deb8f7', background: 'none', align: 'left', size: 64 } },
      { id: 'c-lower', trackId: 'o', name: 'Lower third', kind: 'component', componentName: 'LowerThird', startFrame: 60, durationFrames: 30, props: { title: 'Ada Lovelace', subtitle: 'Engine · Analytical', accentColor: '#FF007F', textColor: '#FFFFFF', side: 'left' } },
      { id: 'c-title', trackId: 'o', name: 'Title', kind: 'component', componentName: 'TitleCard', startFrame: 90, durationFrames: 60, props: { title: 'Chapter Two', subtitle: 'Rendered headlessly', background: '#09090B', accentColor: '#00F3FF', textColor: '#FFFFFF' } },
    ],
    assets: [video, tone],
    transcripts: [],
  };
  ProjectSchema.parse(project);
  await writeFile(join(dir, 'project.json'), JSON.stringify(project, null, 2));
}

/** NEON_HOME with the example Boba pack installed; BobaTitle imports from '@neon/motion' to exercise the alias. */
async function makeNeonHome(dir: string): Promise<string> {
  const pack = join(dir, 'packs', 'boba-expressive');
  await cp(join(repoRoot, 'examples/packs/boba-expressive'), pack, { recursive: true, filter: (src) => !src.includes('node_modules') });
  const title = join(pack, 'BobaTitle.tsx');
  await writeFile(title, (await readFile(title, 'utf8')).replace("from '@neon/motion'", `from '${COMPAT_NAME}'`));
  return dir;
}

function runCli(args: string[], env: Record<string, string>): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--no-warnings', join(repoRoot, 'apps/cli/src/main.ts'), ...args], { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c: Buffer) => (stdout += c.toString()));
    child.stderr.on('data', (c: Buffer) => (stderr += c.toString()));
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

const skip = !has('ffmpeg') || !has('ffprobe') ? 'ffmpeg/ffprobe not available' : !(await chromeAvailable()) ? 'Chrome not available' : false;

test('neon-cli render --headless renders the Timeline composition', { skip, timeout: 300_000 }, async () => {
  const keep = process.env['NEON_E2E_KEEP'];
  const root = keep ?? (await mkdtemp(join(tmpdir(), 'neon-headless-e2e-')));
  try {
    const projectDir = join(root, 'project');
    await rm(projectDir, { recursive: true, force: true });
    await makeProjectFixture(projectDir);
    const neonHome = await makeNeonHome(join(root, 'home'));
    const out = join(root, 'out.mp4');
    const started = Date.now();
    const r = await runCli(['render', '--headless', '--project', projectDir, '--output', out], { NEON_HOME: neonHome });
    const seconds = (Date.now() - started) / 1000;
    assert.equal(r.code, 0, `CLI failed:\n${r.stderr}\n${r.stdout}`);
    console.log(`headless e2e: 150 frames in ${seconds.toFixed(1)} s wall (incl. bundling) — ${r.stdout.trim()}`);

    const probe = JSON.parse(spawnSync('ffprobe', ['-v', 'error', '-count_frames', '-show_entries', 'stream=codec_type,codec_name,width,height,nb_read_frames:format=duration', '-of', 'json', out]).stdout.toString()) as {
      streams: { codec_type: string; codec_name: string; width?: number; height?: number; nb_read_frames?: string }[];
    };
    const v = probe.streams.find((s) => s.codec_type === 'video')!;
    const a = probe.streams.find((s) => s.codec_type === 'audio');
    assert.equal(v.width, 640);
    assert.equal(v.height, 360);
    assert.equal(Number(v.nb_read_frames), 150);
    assert.equal(a?.codec_name, 'aac');
    assert.ok((await stat(out)).size > 10_000);

    // Audio: the video's own 330 Hz at 0.5 for the first 3 s, the 660 Hz tone from 1 s to 4 s, silence after 4 s.
    const pcm = ffmpeg(['-i', out, '-map', '0:a:0', '-ac', '1', '-ar', '48000', '-f', 'f32le', 'pipe:1']);
    const s = new Float32Array(pcm.buffer, pcm.byteOffset, pcm.length / 4);
    const rms = (a0: number, a1: number) => {
      let acc = 0;
      for (let i = Math.floor(a0 * 48000); i < Math.floor(a1 * 48000); i++) acc += s[i]! ** 2;
      return Math.sqrt(acc / ((a1 - a0) * 48000));
    };
    assert.ok(rms(0.2, 0.8) > 0.02, `video audio audible (${rms(0.2, 0.8)})`);
    assert.ok(rms(1.8, 2.6) > rms(0.2, 0.8), 'tone adds to the mix');
    assert.ok(rms(4.2, 4.9) < 0.003, `silence at the end (${rms(4.2, 4.9)})`);

    // Pictures: the Title Card section is a dark full-frame card; the video section is colourful.
    const frameAt = (sec: number) => ffmpeg(['-ss', sec.toFixed(3), '-i', out, '-frames:v', '1', '-vf', 'scale=64:36,format=rgb24', '-f', 'rawvideo', 'pipe:1']);
    const meanSat = (rgb: Buffer) => {
      let sat = 0;
      for (let i = 0; i < rgb.length; i += 3) sat += Math.max(rgb[i]!, rgb[i + 1]!, rgb[i + 2]!) - Math.min(rgb[i]!, rgb[i + 1]!, rgb[i + 2]!);
      return sat / (rgb.length / 3);
    };
    assert.ok(meanSat(frameAt(2.5)) > 40, 'testsrc2 colours visible under the lower third');
    assert.ok(meanSat(frameAt(4.0)) < meanSat(frameAt(2.5)), 'title card replaces the video');
  } finally {
    if (!keep) await rm(root, { recursive: true, force: true });
  }
});
