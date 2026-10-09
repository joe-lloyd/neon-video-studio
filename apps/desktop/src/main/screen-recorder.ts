/**
 * Screen recording in the main process via ffmpeg (argument building lives in @neon/ai capture.ts).
 *
 * A take is written to a .mkv in its own temp dir (a crash still leaves a playable file), stopped by
 * sending `q` on stdin, remuxed to a faststart .mp4 without re-encoding, imported into the project and
 * the temp dir deleted, whatever happened. Only one capture runs at a time, and never alongside the
 * microphone-only voice-over recorder (both would fight over the same mic).
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildCaptureArgs,
  buildRemuxArgs,
  captureFailureHint,
  capturePlatform,
  encoderCandidates,
  encoderProbeArgs,
  linuxCaptureDisplay,
  parseAvfoundationDevices,
  parseDshowAudioDevices,
  parseWindowsScreens,
  resolveCaptureTarget,
  run,
  summarizeDevices,
  which,
  windowsScreensCommand,
  type CapturePlatform,
  type CaptureTarget,
  type DeviceInventory,
  type VideoEncoder,
} from '@neon/ai';
import { CaptureStartRequestSchema, CaptureStopRequestSchema, ORIGIN_API, clipEnd, framesToTimecode, parseTimecode, type CaptureDevices, type CaptureSource, type CaptureStartRequest, type ActivitySource, type CaptureState, type ImportAssetResponse, type Project, type Track } from '@neon/core';
import type { MainContext } from './context.ts';

/** How long a fresh ffmpeg gets to fail (denied permission, bad device) before we call it recording. */
const STARTUP_GRACE_MS = 1200;
const IS_WIN = process.platform === 'win32';

type Live =
  | { status: 'idle' }
  | { status: 'recording'; child: ChildProcess; exited: Promise<void>; dir: string; file: string; startedAt: Date; source: CaptureSource; mic: string | null; encoder: VideoEncoder; fps: number; stderr: string[] }
  | { status: 'finishing'; startedAt: Date };

/** Where a finished take lands: `at` / `track` from the request, else appended to the first video track. */
export type CapturePlacement = { trackId: string; startFrame: number } | { trackId: null; startFrame: number };

/** Pure placement rule (tested): end of the chosen (or first) video track; `trackId: null` = create "V1". */
export function capturePlacement(project: Pick<Project, 'tracks' | 'clips'>, req: { at?: number; track?: string }): CapturePlacement {
  const tracks = [...project.tracks].sort((a, b) => a.order - b.order);
  let track: Track | undefined;
  if (req.track !== undefined) {
    const ref = req.track;
    track = tracks.find((t) => t.id === ref) ?? tracks.find((t) => t.name.toLowerCase() === ref.toLowerCase()) ?? tracks.find((t) => t.id.startsWith(ref));
    if (!track) throw new Error(`Track ${ref} not found`);
    if (track.kind === 'audio') throw new Error(`Track ${track.name} is an audio track; a screen recording needs a video track`);
  } else {
    track = tracks.find((t) => t.kind === 'video' && t.name === 'V1') ?? tracks.find((t) => t.kind === 'video');
  }
  if (!track) return { trackId: null, startFrame: req.at ?? 0 };
  const id = track.id;
  const end = project.clips.filter((c) => c.trackId === id).reduce((max, c) => Math.max(max, clipEnd(c)), 0);
  return { trackId: id, startFrame: req.at ?? end };
}

function waitForExit(child: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) resolve();
    else child.once('close', () => resolve());
  });
}

/** Run ffmpeg briefly; resolves true when it exits 0 within `ms`. */
function probe(cmd: string, args: string[], ms: number): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: 'ignore' });
    const timer = setTimeout(() => child.kill(), ms);
    child.on('error', () => resolve(false));
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve(code === 0);
    });
  });
}

function stamp(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function tail(lines: string[], n = 3): string {
  return lines.filter((l) => l.trim() && !/^\s*(frame|size)=/.test(l)).slice(-n).join(' | ');
}

export class ScreenRecorder {
  private live: Live = { status: 'idle' };
  private readonly encoders = new Map<string, Promise<VideoEncoder>>();
  private readonly ctx: Pick<MainContext, 'assets' | 'store' | 'events' | 'recorder'>;

  constructor(ctx: Pick<MainContext, 'assets' | 'store' | 'events' | 'recorder'>) {
    this.ctx = ctx;
  }

  /** Non-null while a capture is running or finishing (the voice recorder checks this). */
  busy(): string | null {
    return this.live.status === 'idle' ? null : 'A screen recording is running; stop it first (neon-cli capture stop)';
  }

  state(): CaptureState {
    const live = this.live;
    switch (live.status) {
      case 'idle':
        return { status: 'idle' };
      case 'recording':
        return { status: 'recording', startedAt: live.startedAt.toISOString(), source: live.source, mic: live.mic, encoder: live.encoder, fps: live.fps };
      case 'finishing':
        return { status: 'finishing', startedAt: live.startedAt.toISOString() };
      default: {
        const exhaustive: never = live;
        return exhaustive;
      }
    }
  }

  async devices(): Promise<CaptureDevices> {
    const { inv } = await this.inventory();
    return summarizeDevices(inv);
  }

  private async platformAndFfmpeg(): Promise<{ platform: CapturePlatform; ffmpeg: string }> {
    const platform = capturePlatform(process.platform);
    if (!platform) throw new Error(`Screen capture is not supported on ${process.platform}`);
    const ffmpeg = await which('ffmpeg');
    if (!ffmpeg) throw new Error('ffmpeg is not installed yet. The app installs it automatically in a few seconds (watch neon-cli ai jobs), or run neon-cli ai setup');
    return { platform, ffmpeg };
  }

  private async inventory(): Promise<{ inv: DeviceInventory; ffmpeg: string }> {
    const { platform, ffmpeg } = await this.platformAndFfmpeg();
    switch (platform) {
      case 'darwin': {
        const r = await run(ffmpeg, ['-hide_banner', '-f', 'avfoundation', '-list_devices', 'true', '-i', '']);
        return { inv: { platform, ...parseAvfoundationDevices(r.stderr) }, ffmpeg };
      }
      case 'win32': {
        const ps = windowsScreensCommand();
        const [screens, audio] = await Promise.all([run(ps.cmd, ps.args), run(ffmpeg, ['-hide_banner', '-list_devices', 'true', '-f', 'dshow', '-i', 'dummy'])]);
        if (screens.code !== 0) throw new Error(`Could not list monitors (PowerShell exited ${screens.code}): ${screens.stderr.trim().slice(0, 300)}`);
        return { inv: { platform, screens: parseWindowsScreens(screens.stdout), audio: parseDshowAudioDevices(audio.stderr) }, ffmpeg };
      }
      case 'linux':
        return { inv: { platform, display: linuxCaptureDisplay(process.env), audio: ['default'] }, ffmpeg };
      default: {
        const exhaustive: never = platform;
        return exhaustive;
      }
    }
  }

  /** First encoder that survives a one-frame test encode on this machine (cached per ffmpeg binary). */
  private encoderFor(platform: CapturePlatform, ffmpeg: string): Promise<VideoEncoder> {
    let pick = this.encoders.get(ffmpeg);
    if (!pick) {
      pick = (async () => {
        for (const enc of encoderCandidates(platform)) if (enc === 'libx264' || (await probe(ffmpeg, encoderProbeArgs(enc), 10_000))) return enc;
        return 'libx264';
      })();
      this.encoders.set(ffmpeg, pick);
    }
    return pick;
  }

  async start(req: CaptureStartRequest): Promise<CaptureState> {
    if (this.live.status !== 'idle') throw new Error('A screen recording is already running; stop or cancel it first');
    if (this.ctx.recorder.state().recording) throw new Error('A voice-over is recording; stop it before recording the screen');
    const { inv, ffmpeg } = await this.inventory();
    const target: CaptureTarget = resolveCaptureTarget(inv, req.source, req.mic);
    const encoder = await this.encoderFor(inv.platform, ffmpeg);
    // Re-check: device listing and the encoder probe take a moment, and a second start may have raced in.
    if (this.live.status !== 'idle') throw new Error('A screen recording is already running; stop or cancel it first');

    const dir = await mkdtemp(join(tmpdir(), 'neon-capture-'));
    const startedAt = new Date();
    const file = join(dir, `screen-${stamp(startedAt)}.mkv`);
    const child = spawn(ffmpeg, buildCaptureArgs(target, { fps: req.fps, cursor: req.cursor, encoder, output: file }), { stdio: ['pipe', 'ignore', 'pipe'], windowsHide: true });
    const stderr: string[] = [];
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (d: string) => {
      stderr.push(...d.split(/\r?\n|\r/));
      if (stderr.length > 200) stderr.splice(0, stderr.length - 200);
    });
    child.on('error', (err) => stderr.push(err.message));
    const exited = waitForExit(child);
    const mic = target.audioDevice === null ? null : typeof target.audioDevice === 'string' ? target.audioDevice : target.audioDevice.name;
    this.live = { status: 'recording', child, exited, dir, file, startedAt, source: req.source, mic, encoder, fps: req.fps, stderr };

    // ffmpeg exits at once when the OS refuses the screen/mic or the device is wrong.
    const early = await Promise.race([exited.then(() => true), new Promise<false>((r) => setTimeout(() => r(false), STARTUP_GRACE_MS))]);
    if (early) {
      this.live = { status: 'idle' };
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
      throw new Error(`Screen recording failed to start (${tail(stderr) || `ffmpeg exited with ${child.exitCode}`}). ${captureFailureHint(inv.platform, stderr.join('\n'))}`);
    }
    void exited.then(() => {
      // Still "recording" after ffmpeg died on its own: tell the user; stop() will rescue what was written.
      if (this.live.status === 'recording' && this.live.child === child) {
        this.ctx.events.activity('system', 'capture.interrupted', `Screen recording stopped unexpectedly (${tail(stderr) || 'ffmpeg exited'}); run capture stop to keep what was recorded`);
      }
    });
    return this.state();
  }

  /** Finish the take, import it and place it on the timeline. */
  async stop(req: { at?: string | number; track?: string } = {}): Promise<ImportAssetResponse & { durationMs: number }> {
    const live = this.live;
    if (live.status !== 'recording') throw new Error(live.status === 'finishing' ? 'The recording is already being finished' : 'Not recording the screen');
    this.live = { status: 'finishing', startedAt: live.startedAt };
    const durationMs = Date.now() - live.startedAt.getTime();
    try {
      await this.finishProcess(live.child, live.exited);
      const written = await stat(live.file).catch(() => null);
      if (!written || written.size < 1024) throw new Error(`The recording is empty (${tail(live.stderr) || 'no frames were written'})`);
      const { ffmpeg } = await this.platformAndFfmpeg();
      const mp4 = live.file.replace(/\.mkv$/, '.mp4');
      const remux = await run(ffmpeg, buildRemuxArgs(live.file, mp4));
      if (remux.code !== 0) throw new Error(`Could not finalise the recording: ${remux.stderr.trim().split('\n').slice(-2).join(' | ')}`);

      const doc = this.ctx.store.doc;
      const fps = doc.fps;
      const at = req.at === undefined ? undefined : parseTimecode(req.at, fps);
      const place = capturePlacement(doc.toJSON(), { at, track: req.track });
      const trackId = place.trackId ?? doc.addTrack('video', 'V1', ORIGIN_API).id;
      const result = await this.ctx.assets.import(mp4, { insertAt: place.startFrame, trackId, origin: ORIGIN_API });
      return { ...result, durationMs };
    } finally {
      this.live = { status: 'idle' };
      await rm(live.dir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  /** Throw the take away. Safe to call when idle (shutdown does). */
  async cancel(): Promise<boolean> {
    const live = this.live;
    if (live.status !== 'recording') return false;
    this.live = { status: 'idle' };
    live.child.kill(IS_WIN ? undefined : 'SIGKILL');
    await live.exited;
    await rm(live.dir, { recursive: true, force: true }).catch(() => undefined);
    return true;
  }

  /** `q` lets ffmpeg flush and close the file; signals only if it does not listen. Windows has no SIGINT. */
  private async finishProcess(child: ChildProcess, exited: Promise<void>): Promise<void> {
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.stdin?.write('q');
    child.stdin?.end();
    const within = (ms: number) => Promise.race([exited.then(() => true), new Promise<false>((r) => setTimeout(() => r(false), ms))]);
    if (await within(5000)) return;
    child.kill(IS_WIN ? undefined : 'SIGINT');
    if (await within(3000)) return;
    child.kill('SIGKILL');
    await exited;
  }
}

// ---- entry points shared by the control API and the desktop RPC ---------------------------

function describe(source: CaptureSource): string {
  switch (source.kind) {
    case 'display':
      return `display ${source.display}`;
    case 'region':
      return `a ${source.rect.width}×${source.rect.height} region of display ${source.display}`;
    case 'window':
      return `the window “${source.title}”`;
    default: {
      const exhaustive: never = source;
      return exhaustive;
    }
  }
}

export async function startCapture(ctx: MainContext, body: unknown, source: ActivitySource): Promise<CaptureState> {
  const state = await ctx.capture.start(CaptureStartRequestSchema.parse(body ?? {}));
  if (state.status === 'recording') {
    ctx.events.activity(source, 'capture.start', `Recording ${describe(state.source)}${state.mic ? ` with “${state.mic}”` : ' without a microphone'} (${state.encoder}, ${state.fps} fps)`);
  }
  return state;
}

export async function stopCapture(ctx: MainContext, body: unknown, source: ActivitySource): Promise<ImportAssetResponse & { durationMs: number }> {
  const result = await ctx.capture.stop(CaptureStopRequestSchema.parse(body ?? {}));
  const clip = result.clip;
  const where = clip ? ` and placed it on ${ctx.store.doc.getTrack(clip.trackId)?.name ?? 'the timeline'} at ${framesToTimecode(clip.startFrame, ctx.store.doc.fps)}` : '';
  ctx.events.activity(source, 'capture.done', `Recorded the screen for ${(result.durationMs / 1000).toFixed(1)} s (“${result.asset.name}”)${where}`, { assetIds: [result.asset.id], clipIds: clip ? [clip.id] : [] });
  return result;
}

export async function cancelCapture(ctx: MainContext, source: ActivitySource): Promise<{ cancelled: boolean }> {
  const cancelled = await ctx.capture.cancel();
  if (cancelled) ctx.events.activity(source, 'capture.cancel', 'Screen recording discarded');
  return { cancelled };
}
