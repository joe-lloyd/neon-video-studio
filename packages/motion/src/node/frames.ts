/**
 * Frame server: exact decoded video frames over HTTP for `<Video>` in render mode.
 *
 *   GET /frame?src=<absolute url>&t=<seconds>[&alpha=1]
 *
 * returns the frame of `src` that is on screen at media time `t` — the last frame whose
 * presentation time is <= t (+1e-4 s for float error); before the first frame → the first frame,
 * past the end → the last frame. Opaque frames are uncompressed BMP, `alpha=1` gives RGBA PNG.
 *
 * How frames are found exactly: a decode session is one long-lived ffmpeg process per source that
 * input-seeks to a keyframe (`-ss … -noaccurate_seek`, `-copyts` so timestamps stay the source's
 * own) and streams every following frame in presentation order to stdout, while `showinfo` logs
 * each frame's pts on stderr. Pairing the n-th image with the n-th pts gives a window of
 * *consecutive* decoded frames with known timestamps, and a request is answered only when two
 * consecutive frames bracket it (or the stream provably starts/ends there). If a seek lands after
 * the requested time, the session is restarted further back — so an answer is never a guess.
 *
 * Sequential renders reuse the session (it reads a few frames ahead and keeps a few behind for the
 * other tabs, which request frames slightly out of order); backward or far jumps start a new one.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { defaultBinaries, ffmpegInput, probeMedia, type FfmpegBinaries } from './probe.ts';

/** Tolerance for float error between the composition clock and source timestamps (seconds). */
export const FRAME_EPSILON = 1e-4;

// ---- image stream splitting -----------------------------------------------------------------

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * Splits a concatenated stream of BMP or PNG images (ffmpeg image2pipe) into whole files without
 * re-copying the stream for every chunk.
 */
export class ImageStreamSplitter {
  readonly format: 'bmp' | 'png';
  private chunks: Buffer[] = [];
  private length = 0;
  /** PNG: offset of the next chunk header within the current image. */
  private pngOffset = 0;
  /** PNG: total size of the current image once its IEND header has been seen. */
  private pngTotal: number | null = null;

  constructor(format: 'bmp' | 'png') {
    this.format = format;
  }

  get buffered(): number {
    return this.length;
  }

  push(chunk: Buffer): Buffer[] {
    if (chunk.length) {
      this.chunks.push(chunk);
      this.length += chunk.length;
    }
    const out: Buffer[] = [];
    for (;;) {
      const size = this.format === 'bmp' ? this.bmpSize() : this.pngSize();
      if (size === null || this.length < size) break;
      out.push(this.take(size));
    }
    return out;
  }

  private peek(offset: number, n: number): Buffer | null {
    if (offset + n > this.length) return null;
    const out = Buffer.allocUnsafe(n);
    let pos = 0;
    let skip = offset;
    for (const c of this.chunks) {
      if (skip >= c.length) {
        skip -= c.length;
        continue;
      }
      const copied = c.copy(out, pos, skip, Math.min(c.length, skip + n - pos));
      pos += copied;
      skip = 0;
      if (pos === n) break;
    }
    return out;
  }

  private take(n: number): Buffer {
    const all = this.chunks.length === 1 ? this.chunks[0]! : Buffer.concat(this.chunks, this.length);
    const image = Buffer.from(all.subarray(0, n));
    const rest = all.subarray(n);
    this.chunks = rest.length ? [rest] : [];
    this.length = rest.length;
    this.pngOffset = 0;
    this.pngTotal = null;
    return image;
  }

  private bmpSize(): number | null {
    const head = this.peek(0, 6);
    if (!head) return null;
    if (head[0] !== 0x42 || head[1] !== 0x4d) throw new Error('Frame stream is not BMP');
    return head.readUInt32LE(2);
  }

  private pngSize(): number | null {
    if (this.pngTotal !== null) return this.pngTotal;
    if (this.pngOffset === 0) {
      const sig = this.peek(0, 8);
      if (!sig) return null;
      if (!sig.equals(PNG_SIGNATURE)) throw new Error('Frame stream is not PNG');
      this.pngOffset = 8;
    }
    for (;;) {
      const header = this.peek(this.pngOffset, 8);
      if (!header) return null;
      const len = header.readUInt32BE(0);
      const type = header.toString('latin1', 4, 8);
      this.pngOffset += 12 + len;
      if (type === 'IEND') return (this.pngTotal = this.pngOffset);
    }
  }
}

// ---- showinfo parsing -----------------------------------------------------------------------

/** `config in time_base: 1/15360` → seconds per tick. */
export function parseShowinfoTimebase(line: string): number | null {
  const m = /config in time_base:\s*(\d+)\/(\d+)/.exec(line);
  if (!m) return null;
  const num = Number(m[1]);
  const den = Number(m[2]);
  return num > 0 && den > 0 ? num / den : null;
}

/** `n:  12 pts:  6144 pts_time:0.4 …` → frame index and integer pts. */
export function parseShowinfoFrame(line: string): { n: number; pts: number | null; ptsTime: number | null } | null {
  const m = /\bn:\s*(\d+)\s+pts:\s*(-?\d+|NOPTS)\s+pts_time:\s*(\S+)/.exec(line);
  if (!m) return null;
  const pts = m[2] === 'NOPTS' ? null : Number(m[2]);
  const ptsTime = Number(m[3]);
  return { n: Number(m[1]), pts, ptsTime: Number.isFinite(ptsTime) ? ptsTime : null };
}

// ---- frame selection ------------------------------------------------------------------------

export type FrameSelection = { kind: 'hit'; index: number } | { kind: 'more' } | { kind: 'miss' };

/**
 * Pick the frame on screen at `target` from a window of consecutive decoded frames (ascending pts).
 *  - `atStart`: window[0] is the first frame of the stream (targets before it resolve to it)
 *  - `ended`:   the stream ended after the last frame (targets past it resolve to it)
 * `more` = the answer may come later in this stream; `miss` = this window can never answer.
 */
export function selectFrame(pts: readonly number[], target: number, state: { atStart: boolean; ended: boolean }, eps = FRAME_EPSILON): FrameSelection {
  const t = target + eps;
  if (pts.length === 0) return state.ended ? { kind: 'miss' } : { kind: 'more' };
  if (pts[0]! > t) return state.atStart ? { kind: 'hit', index: 0 } : { kind: 'miss' };
  // Last index with pts <= t.
  let lo = 0;
  let hi = pts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (pts[mid]! <= t) lo = mid;
    else hi = mid - 1;
  }
  if (lo < pts.length - 1 || state.ended) return { kind: 'hit', index: lo };
  return { kind: 'more' };
}

// ---- decode sessions ------------------------------------------------------------------------

interface DecodedFrame {
  /** Presentation time in seconds, in the source's own timeline (start time included). */
  pts: number;
  data: Buffer;
}

interface SessionLimits {
  keepBehind: number;
  readAhead: number;
}

class DecodeSession {
  readonly src: string;
  readonly alpha: boolean;
  /** Input seek position, seconds of media time (ffmpeg's -ss is relative to the container start). */
  readonly seekTime: number;
  /** The same position as a source timestamp (comparable with frame pts). */
  readonly seekPts: number;
  readonly proc: ChildProcess;
  frames: DecodedFrame[] = [];
  atStart: boolean;
  ended = false;
  error: Error | null = null;
  /** Highest target this session has been asked for; frames at or before it are "behind". */
  cursor = -Infinity;
  lastUsed = Date.now();
  waiters = 0;
  private limits: SessionLimits;
  private images: Buffer[] = [];
  private ptsQueue: number[] = [];
  private timebase: number | null = null;
  private lastPts = -Infinity;
  private stderrTail: string[] = [];
  private listeners = new Set<() => void>();
  private killed = false;
  private paused = false;

  constructor(src: string, alpha: boolean, seekTime: number, startTime: number, bins: FfmpegBinaries, limits: SessionLimits) {
    this.src = src;
    this.alpha = alpha;
    this.seekTime = seekTime;
    this.seekPts = startTime + seekTime;
    this.atStart = seekTime <= 0;
    this.limits = limits;
    const args = [
      '-hide_banner', '-nostdin', '-nostats', '-loglevel', 'info',
      '-copyts',
      ...(seekTime > 0 ? ['-ss', seekTime.toFixed(6), '-noaccurate_seek'] : []),
      '-i', ffmpegInput(src),
      '-map', '0:v:0', '-an', '-sn', '-dn',
      '-vf', 'showinfo=checksum=0',
      '-fps_mode', 'passthrough',
      '-f', 'image2pipe',
      ...(alpha ? ['-c:v', 'png', '-pix_fmt', 'rgba', '-compression_level', '1'] : ['-c:v', 'bmp', '-pix_fmt', 'bgr24']),
      'pipe:1',
    ];
    this.proc = spawn(bins.ffmpeg, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const splitter = new ImageStreamSplitter(alpha ? 'png' : 'bmp');
    this.proc.stdout!.on('data', (chunk: Buffer) => {
      try {
        for (const image of splitter.push(chunk)) this.images.push(image);
      } catch (err) {
        this.fail(err instanceof Error ? err : new Error(String(err)));
        return;
      }
      this.pair();
    });
    let partial = '';
    this.proc.stderr!.setEncoding('utf8');
    this.proc.stderr!.on('data', (chunk: string) => {
      partial += chunk;
      let nl: number;
      while ((nl = partial.search(/[\r\n]/)) >= 0) {
        const line = partial.slice(0, nl);
        partial = partial.slice(nl + 1);
        if (line) this.onStderrLine(line);
      }
    });
    this.proc.on('error', (err) => this.fail(new Error(`Could not start ffmpeg (${bins.ffmpeg}): ${err.message}`)));
    this.proc.on('close', (code) => {
      if (partial) this.onStderrLine(partial);
      this.pair();
      if (this.killed) {
        // Killed before EOF: the last frame is NOT the end of the stream, so never answer "past the end" from it.
        this.error ??= new Error(`Decode session for ${src} was stopped`);
      } else if (code !== 0 && this.frames.length === 0 && !this.error) {
        this.fail(new Error(`Could not decode ${src}: ${this.stderrTail.slice(-3).join(' | ') || `ffmpeg exited with ${code}`}`));
      }
      this.ended = true;
      this.notify();
    });
  }

  private onStderrLine(line: string): void {
    if (line.includes('showinfo')) {
      const tb = parseShowinfoTimebase(line);
      if (tb !== null) {
        this.timebase ??= tb;
        return;
      }
      const f = parseShowinfoFrame(line);
      if (f) {
        // Exact seconds from the integer pts; fall back to the printed time, then to "just after the previous frame".
        let pts = f.pts !== null && this.timebase !== null ? f.pts * this.timebase : f.ptsTime;
        if (pts === null || !Number.isFinite(pts)) pts = this.lastPts + 1e-3;
        this.lastPts = pts;
        this.ptsQueue.push(pts);
        this.pair();
      }
      return;
    }
    this.stderrTail.push(line.trim());
    if (this.stderrTail.length > 20) this.stderrTail.shift();
  }

  private pair(): void {
    let added = false;
    while (this.images.length && this.ptsQueue.length) {
      const pts = this.ptsQueue.shift()!;
      const data = this.images.shift()!;
      const last = this.frames[this.frames.length - 1];
      // Out-of-order timestamps would break the "consecutive frames" invariant; drop them.
      if (last && pts <= last.pts) continue;
      this.frames.push({ pts, data });
      added = true;
    }
    if (added) {
      this.trim();
      this.notify();
    }
  }

  private fail(err: Error): void {
    if (this.error) return;
    this.error = err;
    this.kill();
    this.notify();
  }

  private notify(): void {
    for (const l of [...this.listeners]) l();
  }

  /** Drop frames far behind the cursor and apply read-ahead backpressure. */
  trim(): void {
    let behind = 0;
    for (const f of this.frames) if (f.pts <= this.cursor + FRAME_EPSILON) behind++;
    const drop = behind - this.limits.keepBehind;
    if (drop > 0) {
      this.frames.splice(0, drop);
      this.atStart = false;
    }
    const ahead = this.frames.length - Math.min(behind, this.limits.keepBehind);
    const stdout = this.proc.stdout;
    if (!stdout || this.ended) return;
    if (ahead >= this.limits.readAhead && !this.paused) {
      stdout.pause();
      this.paused = true;
    } else if (ahead < this.limits.readAhead && this.paused) {
      stdout.resume();
      this.paused = false;
    }
  }

  select(target: number): FrameSelection {
    if (this.error) return { kind: 'miss' };
    return selectFrame(this.frames.map((f) => f.pts), target, { atStart: this.atStart, ended: this.ended });
  }

  /** Could waiting on this session answer `target`? */
  canReach(target: number, maxAhead: number): boolean {
    if (this.error || this.ended) return false;
    const first = this.frames[0];
    const last = this.frames[this.frames.length - 1];
    if (!first || !last) return target + FRAME_EPSILON >= this.seekPts && target - this.seekPts <= maxAhead;
    if (first.pts > target + FRAME_EPSILON) return false;
    return target - last.pts <= maxAhead;
  }

  /** Wait until `target` resolves to a hit or a miss on this session. */
  async resolve(target: number): Promise<DecodedFrame | null> {
    this.waiters++;
    this.lastUsed = Date.now();
    try {
      for (;;) {
        if (this.error) throw this.error;
        const sel = this.select(target);
        if (sel.kind === 'hit') {
          const frame = this.frames[sel.index]!;
          if (target > this.cursor) this.cursor = target;
          this.trim();
          return frame;
        }
        if (sel.kind === 'miss') return null;
        // Need more frames: everything up to the target is now "behind".
        if (target > this.cursor) {
          this.cursor = target;
          this.trim();
        }
        await new Promise<void>((resolve) => {
          const wake = () => {
            this.listeners.delete(wake);
            resolve();
          };
          this.listeners.add(wake);
        });
      }
    } finally {
      this.waiters--;
      this.lastUsed = Date.now();
    }
  }

  kill(): void {
    this.killed = true;
    this.error ??= new Error(`Decode session for ${this.src} was stopped`);
    this.notify();
    if (this.proc.exitCode === null && this.proc.signalCode === null) this.proc.kill('SIGKILL');
  }
}

// ---- server ---------------------------------------------------------------------------------

export interface FrameServerOptions {
  binaries?: FfmpegBinaries;
  /** Concurrent decode sessions across all sources (default 8). */
  maxSessions?: number;
  /** Frames kept behind the furthest request per session, for tabs that lag (default 12). */
  keepBehind?: number;
  /** Frames decoded ahead of the furthest request per session (default 6). */
  readAhead?: number;
  /** Bytes of recently served frames kept for repeated requests (default 96 MB). */
  cacheBytes?: number;
  /** Reuse a session for targets up to this far past its newest frame instead of seeking (default 3 s). */
  maxSequentialGap?: number;
  onLog?: (line: string) => void;
}

export interface FrameResult {
  data: Buffer;
  contentType: string;
  /** Presentation time of the returned frame, seconds from the source's start. */
  time: number;
}

export interface FrameServerStats {
  requests: number;
  cacheHits: number;
  sessionsStarted: number;
}

const SEEK_BACKOFF_SECONDS = [0, 2, 10];

export class FrameServer {
  private bins: FfmpegBinaries;
  private sessions: DecodeSession[] = [];
  private cache = new Map<string, FrameResult>();
  private cacheSize = 0;
  private opts: Required<Omit<FrameServerOptions, 'binaries' | 'onLog'>>;
  private onLog: ((line: string) => void) | undefined;
  private errors: string[] = [];
  private closed = false;
  readonly stats: FrameServerStats = { requests: 0, cacheHits: 0, sessionsStarted: 0 };

  constructor(opts: FrameServerOptions = {}) {
    this.bins = opts.binaries ?? defaultBinaries();
    this.onLog = opts.onLog;
    this.opts = {
      maxSessions: opts.maxSessions ?? 8,
      keepBehind: opts.keepBehind ?? 12,
      readAhead: opts.readAhead ?? 6,
      cacheBytes: opts.cacheBytes ?? 96 * 1024 * 1024,
      maxSequentialGap: opts.maxSequentialGap ?? 3,
    };
  }

  /** The most recent failures (for render error messages). */
  recentErrors(): string[] {
    return [...this.errors];
  }

  async getFrame(src: string, time: number, alpha = false): Promise<FrameResult> {
    if (this.closed) throw new Error('Frame server is closed');
    this.stats.requests++;
    const t = Math.max(0, time);
    const key = `${alpha ? 'a' : 'o'}|${t.toFixed(6)}|${src}`;
    const cached = this.cache.get(key);
    if (cached) {
      this.stats.cacheHits++;
      this.cache.delete(key);
      this.cache.set(key, cached);
      return cached;
    }
    const probe = await probeMedia(src, this.bins);
    if (!probe.video) throw new Error(`${src} has no video stream`);
    const target = probe.startTime + t;
    const frame = await this.decode(src, alpha, target, probe.startTime);
    const result: FrameResult = { data: frame.data, contentType: alpha ? 'image/png' : 'image/bmp', time: frame.pts - probe.startTime };
    this.remember(key, result);
    return result;
  }

  private async decode(src: string, alpha: boolean, target: number, startTime: number): Promise<DecodedFrame> {
    const mine = () => this.sessions.filter((s) => s.src === src && s.alpha === alpha);
    // 1. A window that already brackets the target, 2. a session that will reach it soon.
    for (const s of mine()) {
      if (s.select(target).kind === 'hit') {
        const f = await s.resolve(target);
        if (f) return f;
      }
    }
    const reachable = mine()
      .filter((s) => s.canReach(target, this.opts.maxSequentialGap))
      .sort((a, b) => (b.frames.at(-1)?.pts ?? b.seekPts) - (a.frames.at(-1)?.pts ?? a.seekPts))[0];
    if (reachable) {
      const f = await reachable.resolve(target);
      if (f) return f;
    }
    // 3. Seek: start a new session, backing off further when the keyframe lands after the target.
    let lastError: Error | null = null;
    const mediaTime = target - startTime;
    const attempts = [...new Set([...SEEK_BACKOFF_SECONDS.map((b) => Math.max(0, mediaTime - b)), 0])];
    for (const rel of attempts) {
      const session = this.startSession(src, alpha, rel, startTime);
      try {
        const f = await session.resolve(target);
        if (f) return f;
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        this.drop(session);
        break;
      }
      if (session.frames.length === 0) this.drop(session);
      if (rel === 0) break;
    }
    throw lastError ?? new Error(`No decodable video frame in ${src} at ${target.toFixed(3)} s`);
  }

  private startSession(src: string, alpha: boolean, seekTime: number, startTime: number): DecodeSession {
    // Evict least recently used idle sessions over the cap (busy ones finish first).
    const idle = this.sessions.filter((s) => s.waiters === 0).sort((a, b) => a.lastUsed - b.lastUsed);
    while (this.sessions.length >= this.opts.maxSessions && idle.length) this.drop(idle.shift()!);
    for (const s of this.sessions.filter((s) => s.ended && s.waiters === 0 && s.src === src && s.alpha === alpha && s.frames.length === 0)) this.drop(s);
    const session = new DecodeSession(src, alpha, seekTime, startTime, this.bins, { keepBehind: this.opts.keepBehind, readAhead: this.opts.readAhead });
    this.sessions.push(session);
    this.stats.sessionsStarted++;
    this.onLog?.(`frame server: decode ${src} from ${seekTime.toFixed(3)} s${alpha ? ' (alpha)' : ''}`);
    return session;
  }

  private drop(session: DecodeSession): void {
    session.kill();
    this.sessions = this.sessions.filter((s) => s !== session);
  }

  private remember(key: string, result: FrameResult): void {
    if (result.data.length > this.opts.cacheBytes / 4) return;
    this.cache.set(key, result);
    this.cacheSize += result.data.length;
    for (const [k, v] of this.cache) {
      if (this.cacheSize <= this.opts.cacheBytes) break;
      this.cache.delete(k);
      this.cacheSize -= v.data.length;
    }
  }

  /** node:http handler for `/frame?src=…&t=…[&alpha=1]`. */
  handle(req: IncomingMessage, res: ServerResponse): void {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const src = url.searchParams.get('src');
    const t = Number(url.searchParams.get('t'));
    const alpha = url.searchParams.get('alpha') === '1';
    if (!src || !Number.isFinite(t)) {
      res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8', 'Access-Control-Allow-Origin': '*' }).end('Expected /frame?src=<url>&t=<seconds>');
      return;
    }
    this.getFrame(src, t, alpha).then(
      (frame) => {
        res.writeHead(200, {
          'Content-Type': frame.contentType,
          'Content-Length': String(frame.data.length),
          'Cache-Control': 'no-store',
          'Access-Control-Allow-Origin': '*',
          'X-Frame-Time': frame.time.toFixed(6),
        });
        res.end(req.method === 'HEAD' ? undefined : frame.data);
      },
      (err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        this.errors.push(message);
        if (this.errors.length > 10) this.errors.shift();
        this.onLog?.(`frame server: ${message}`);
        if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
        res.end(message);
      },
    );
  }

  close(): void {
    this.closed = true;
    for (const s of this.sessions) s.kill();
    this.sessions = [];
    this.cache.clear();
    this.cacheSize = 0;
  }
}
