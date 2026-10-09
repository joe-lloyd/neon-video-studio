/**
 * `neon-cli capture …`: record the screen (and narration) in the running app.
 *
 *   capture devices
 *   capture start [--display N] [--region x,y,w,h] [--window "Title"] [--fps 30] [--mic NAME|--no-mic]
 *                 [--no-cursor] [--countdown 3] [--duration T]
 *   capture stop [--at T] [--track REF] | capture cancel | capture status
 *
 * With --duration, start blocks, then stops by itself (Ctrl-C stops early and keeps the take).
 */
import { framesToTimecode, parseTimecode, type CaptureDevices, type CaptureStartBody, type CaptureState } from '@neon/core';
import { ApiError, type NeonClient } from './client.ts';
import { table } from './format.ts';

export const CAPTURE_USAGE = 'capture devices | capture start [--display N] [--region x,y,w,h] [--window "Title"] [--fps 30] [--mic NAME|--no-mic] [--no-cursor] [--countdown 3] [--duration T] | capture stop [--at T] [--track REF] | capture cancel | capture status';

/** The flags this command reads; `mic` is false after --no-mic on Node versions that negate string options. */
export interface CaptureFlags {
  display?: string;
  region?: string;
  window?: string;
  fps?: string;
  mic?: string | boolean;
  'no-mic'?: boolean;
  cursor?: boolean;
  countdown?: string;
  duration?: string;
  at?: string;
  track?: string;
}

function int(raw: string | undefined, flag: string, min: number): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min) throw new ApiError('USAGE', `--${flag} expects a whole number ≥ ${min}, got "${raw}"`);
  return n;
}

/** Map CLI flags onto the POST /api/capture/start body (the server validates the rest). */
export function captureStartBody(flags: CaptureFlags): CaptureStartBody {
  const noMic = flags['no-mic'] === true || flags.mic === false;
  if (noMic && typeof flags.mic === 'string') throw new ApiError('USAGE', 'Use --mic NAME or --no-mic, not both');
  return {
    display: int(flags.display, 'display', 0),
    region: flags.region,
    window: flags.window,
    fps: int(flags.fps, 'fps', 1),
    mic: noMic ? false : typeof flags.mic === 'string' ? flags.mic : undefined,
    cursor: flags.cursor,
  };
}

function elapsed(startedAt: string): string {
  const s = Math.max(0, Math.round((Date.now() - Date.parse(startedAt)) / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export function describeState(state: CaptureState): string {
  switch (state.status) {
    case 'idle':
      return 'Not recording the screen';
    case 'finishing':
      return `Finishing a recording started ${elapsed(state.startedAt)} ago`;
    case 'recording': {
      const src = state.source;
      const what = src.kind === 'display' ? `display ${src.display}` : src.kind === 'region' ? `region ${src.rect.x},${src.rect.y},${src.rect.width},${src.rect.height} of display ${src.display}` : `window “${src.title}”`;
      return `Recording ${what} for ${elapsed(state.startedAt)} · mic ${state.mic ?? 'off'} · ${state.encoder} @ ${state.fps} fps`;
    }
    default: {
      const exhaustive: never = state;
      return exhaustive;
    }
  }
}

function describeDevices(d: CaptureDevices): string {
  const displays = d.displays.length === 0 ? '  (none visible; on macOS grant Screen Recording permission, see docs/cli.md)' : table(
    d.displays.map((s) => [String(s.index), s.name, s.primary ? 'primary' : '', s.bounds ? `${s.bounds.width}×${s.bounds.height} at ${s.bounds.x},${s.bounds.y}` : '']),
    ['display', 'name', '', 'bounds'],
  );
  const mics = d.mics.length ? d.mics.map((m) => `  ${m}${m === d.defaultMic ? '  (default)' : ''}`).join('\n') : '  (none)';
  return `DISPLAYS (--display N)\n${displays}\n\nMICROPHONES (--mic NAME)\n${mics}\n\nWindow capture (--window): ${d.windowCapture ? 'yes' : 'not on this OS'}`;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Wait `ms`, or less if the user presses Ctrl-C (the take is kept either way). */
function waitOrInterrupt(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      process.off('SIGINT', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    process.once('SIGINT', done);
  });
}

type Io = { json: boolean; out: (data: unknown, human: () => string) => void };

async function stop(api: NeonClient, flags: CaptureFlags, io: Io): Promise<void> {
  const r = await api.captureStop({ at: flags.at, track: flags.track });
  const fps = (await api.status()).project.fps;
  io.out(r, () => `Recorded ${(r.durationMs / 1000).toFixed(1)} s → “${r.asset.name}”${r.clip ? ` at ${framesToTimecode(r.clip.startFrame, fps)} (clip ${r.clip.id})` : ''}`);
}

export async function captureCommand(api: NeonClient, sub: string | undefined, flags: CaptureFlags, io: Io): Promise<void> {
  const say = (line: string) => {
    if (!io.json) process.stderr.write(`${line}\n`);
  };
  switch (sub) {
    case 'devices': {
      const d = await api.captureDevices();
      io.out(d, () => describeDevices(d));
      return;
    }
    case 'status': {
      const s = await api.captureState();
      io.out(s, () => describeState(s));
      return;
    }
    case 'cancel': {
      const r = await api.captureCancel();
      io.out(r, () => (r.cancelled ? 'Screen recording discarded' : 'Nothing was recording'));
      return;
    }
    case 'stop': {
      await stop(api, flags, io);
      return;
    }
    case 'start': {
      const body = captureStartBody(flags);
      const countdown = int(flags.countdown, 'countdown', 0) ?? 0;
      // Validate --duration before the countdown so a typo does not cost a take.
      const durationMs = flags.duration === undefined ? undefined : (parseTimecode(flags.duration, body.fps ?? 30) / (body.fps ?? 30)) * 1000;
      if (durationMs !== undefined && !(durationMs > 0)) throw new ApiError('USAGE', `--duration must be longer than zero, got "${flags.duration}"`);
      for (let n = countdown; n > 0; n--) {
        say(`${n}…`);
        await sleep(1000);
      }
      const state = await api.captureStart(body);
      if (durationMs === undefined) {
        io.out(state, () => `${describeState(state)}\nStop with: neon-cli capture stop [--at T] [--track REF]`);
        return;
      }
      say(`${describeState(state)} · stopping in ${(durationMs / 1000).toFixed(1)} s (Ctrl-C stops now)`);
      await waitOrInterrupt(durationMs);
      await stop(api, flags, io);
      return;
    }
    default:
      throw new ApiError('USAGE', CAPTURE_USAGE);
  }
}
