/**
 * Headless export: N Chrome tabs render frames of a bundled composition in parallel, screenshots
 * are re-ordered and piped into ffmpeg (H.264), the per-frame audio reports are mixed offline and
 * muxed in as AAC. Output is written to a temp file and renamed into place on success.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { availableParallelism, cpus, tmpdir } from 'node:os';
import { mkdir, mkdtemp, rename, rm } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import type { AudioFrameEntry, RenderInit } from './protocol.ts';
import { launchBrowser, type Browser } from './browser.ts';
import type { CdpSession } from './cdp.ts';
import { mixAudio, MIX_CHANNELS, MIX_SAMPLE_RATE } from './audio.ts';
import { defaultBinaries, type FfmpegBinaries } from './probe.ts';
import { startRenderServer, type RenderServer } from './server.ts';

export interface RenderProgress {
  /** 0–1 over the whole job (frames, audio mix, mux). */
  progress: number;
  renderedFrames: number;
  encodedFrames: number;
}

export interface RenderComposition {
  id?: string;
  width: number;
  height: number;
  fps: number;
  durationInFrames: number;
}

export interface RenderMediaOptions {
  /** Directory with index.html, from bundleComposition(). */
  bundleDir: string;
  props: Record<string, unknown>;
  composition: RenderComposition;
  /** Inclusive [from, to] in composition frames; null/undefined = all frames. */
  frameRange?: [number, number] | null;
  outputPath: string;
  /** x264 CRF (default 18). */
  crf?: number;
  /** x264 preset (default "medium"). */
  x264Preset?: string;
  /** Parallel tabs: a number, a percentage of CPU cores ("50%"), or null for the default. */
  concurrency?: number | string | null;
  browserExecutable?: string | null;
  signal?: AbortSignal;
  onProgress?: (progress: RenderProgress) => void;
  onLog?: (line: string) => void;
  /** Per-frame limit in ms (default 60 s; delayRender() handles time out after 30 s on their own). */
  frameTimeoutMs?: number;
  /** JPEG quality of the intermediate screenshots (default 92). */
  jpegQuality?: number;
  binaries?: FfmpegBinaries;
}

export interface RenderMediaResult {
  outputPath: string;
  frames: number;
  durationMs: number;
  /** Frames rendered per second of wall time (rendering + encoding only). */
  renderFps: number;
}

export function defaultConcurrency(): number {
  const cores = typeof availableParallelism === 'function' ? availableParallelism() : cpus().length;
  return Math.min(8, Math.max(1, Math.floor(cores / 2)));
}

export function resolveConcurrency(value: number | string | null | undefined): number {
  const cores = typeof availableParallelism === 'function' ? availableParallelism() : cpus().length;
  if (typeof value === 'number' && Number.isFinite(value) && value >= 1) return Math.floor(value);
  if (typeof value === 'string') {
    const pct = /^(\d+(?:\.\d+)?)%$/.exec(value.trim());
    if (pct) return Math.max(1, Math.floor((cores * Number(pct[1])) / 100));
    const n = Number(value);
    if (Number.isFinite(n) && n >= 1) return Math.floor(n);
  }
  return defaultConcurrency();
}

/** ffmpeg rate string: exact rationals for the NTSC family, plain numbers otherwise. */
export function fpsToRational(fps: number): string {
  for (const base of [24, 30, 60, 120, 48]) {
    if (Math.abs(fps - (base * 1000) / 1001) < 1e-3) return `${base * 1000}/1001`;
  }
  if (Number.isInteger(fps)) return String(fps);
  return String(Math.round(fps * 1000)) + '/1000';
}

export function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error('Render cancelled');
}

export interface Tab {
  session: CdpSession;
}

interface EvalResult {
  result?: { value?: unknown };
  exceptionDetails?: { text?: string; exception?: { description?: string; value?: unknown } };
}

export async function evaluate<T>(session: CdpSession, expression: string, timeoutMs: number): Promise<T> {
  const r = await session.send<EvalResult>('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, timeoutMs);
  if (r.exceptionDetails) {
    const d = r.exceptionDetails;
    const message = d.exception?.description ?? (typeof d.exception?.value === 'string' ? d.exception.value : undefined) ?? d.text ?? 'Unknown page error';
    throw new Error(message);
  }
  return r.result?.value as T;
}

const WAIT_FOR_ROOT = `new Promise((resolve, reject) => {
  const started = Date.now();
  const check = () => {
    if (window.__neonMotionError) return reject(new Error(window.__neonMotionError));
    if (window.__neonMotion) return resolve(true);
    if (Date.now() - started > 30000) return reject(new Error('The render page never called registerRenderRoot()'));
    setTimeout(check, 10);
  };
  check();
})`;

export async function openTab(browser: Browser, url: string, init: RenderInit, onLog?: (line: string) => void, opts: { deviceScaleFactor?: number; transparent?: boolean } = {}): Promise<Tab> {
  const { session } = await browser.newPage();
  await Promise.all([session.send('Page.enable'), session.send('Runtime.enable')]);
  let logged = 0;
  session.on('Runtime.consoleAPICalled', (p) => {
    const type = p['type'] as string;
    if ((type !== 'error' && type !== 'warning') || logged++ > 40) return;
    const args = (p['args'] as { value?: unknown; description?: string }[] | undefined) ?? [];
    onLog?.(`[page ${type}] ${args.map((a) => (a.value !== undefined ? String(a.value) : a.description ?? '')).join(' ')}`);
  });
  session.on('Runtime.exceptionThrown', (p) => {
    const d = p['exceptionDetails'] as { exception?: { description?: string }; text?: string } | undefined;
    if (logged++ <= 40) onLog?.(`[page exception] ${d?.exception?.description ?? d?.text ?? ''}`);
  });
  await session.send('Emulation.setDeviceMetricsOverride', { width: init.config.width, height: init.config.height, deviceScaleFactor: opts.deviceScaleFactor ?? 1, mobile: false });
  // Opaque black wherever the composition draws nothing (JPEG/H.264 have no alpha); PNG stills may keep it.
  await session.send('Emulation.setDefaultBackgroundColorOverride', { color: { r: 0, g: 0, b: 0, a: opts.transparent ? 0 : 1 } });
  const loaded = session.waitFor('Page.loadEventFired', { timeoutMs: 60_000 });
  const nav = await session.send<{ errorText?: string }>('Page.navigate', { url });
  if (nav.errorText) throw new Error(`Could not load the render page ${url}: ${nav.errorText}`);
  await loaded;
  await evaluate(session, WAIT_FOR_ROOT, 40_000);
  await evaluate(session, `window.__neonMotion.init(${JSON.stringify(init)})`, 60_000);
  return { session };
}

function spawnEncoder(bins: FfmpegBinaries, opts: { fps: number; width: number; height: number; crf: number; preset: string; out: string }): ChildProcess {
  const rate = fpsToRational(opts.fps);
  const filters: string[] = [];
  // yuv420p needs even dimensions: drop the odd last row/column rather than rescaling.
  if (opts.width % 2 || opts.height % 2) filters.push('crop=trunc(iw/2)*2:trunc(ih/2)*2:0:0');
  // Screenshots are sRGB; encode with the BT.709 matrix in limited range and tag it so players agree.
  filters.push('scale=out_color_matrix=bt709:out_range=tv', 'format=yuv420p', 'setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=tv');
  const args = [
    '-hide_banner', '-nostdin', '-loglevel', 'error', '-y',
    '-f', 'image2pipe', '-c:v', 'mjpeg', '-framerate', rate, '-i', 'pipe:0',
    '-vf', filters.join(','),
    '-c:v', 'libx264', '-preset', opts.preset, '-crf', String(opts.crf),
    '-pix_fmt', 'yuv420p', '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-color_range', 'tv',
    '-r', rate, '-an',
    opts.out,
  ];
  return spawn(bins.ffmpeg, args, { stdio: ['pipe', 'ignore', 'pipe'] });
}

function waitForExit(child: ChildProcess, what: string, stderr: () => string): Promise<void> {
  return new Promise((resolve, reject) => {
    if (child.exitCode !== null) {
      if (child.exitCode === 0) resolve();
      else reject(new Error(`${what} failed (exit ${child.exitCode}): ${stderr().trim().split('\n').slice(-3).join(' | ')}`));
      return;
    }
    child.once('error', (err) => reject(new Error(`${what}: ${err.message}`)));
    child.once('close', (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`${what} failed (${signal ?? `exit ${code}`}): ${stderr().trim().split('\n').slice(-3).join(' | ')}`));
    });
  });
}

export async function renderMedia(opts: RenderMediaOptions): Promise<RenderMediaResult> {
  const started = Date.now();
  const bins = opts.binaries ?? defaultBinaries();
  const { width, height, fps, durationInFrames } = opts.composition;
  if (!(width > 0 && height > 0 && fps > 0 && durationInFrames > 0)) throw new Error(`Invalid composition ${width}x${height} @ ${fps} fps, ${durationInFrames} frames`);
  const from = opts.frameRange ? Math.max(0, Math.floor(opts.frameRange[0])) : 0;
  const to = opts.frameRange ? Math.min(durationInFrames - 1, Math.floor(opts.frameRange[1])) : durationInFrames - 1;
  if (to < from) throw new Error(`Empty frame range [${opts.frameRange?.join(', ')}] for ${durationInFrames} frames`);
  const total = to - from + 1;
  const concurrency = Math.min(total, resolveConcurrency(opts.concurrency));
  const frameTimeoutMs = opts.frameTimeoutMs ?? 60_000;
  const quality = opts.jpegQuality ?? 92;
  const log = opts.onLog ?? (() => undefined);

  // Internal controller: external cancel and internal failures both stop everything.
  const ctrl = new AbortController();
  const onExternalAbort = () => ctrl.abort(abortError(opts.signal!));
  if (opts.signal?.aborted) throw abortError(opts.signal);
  opts.signal?.addEventListener('abort', onExternalAbort, { once: true });

  await mkdir(dirname(opts.outputPath), { recursive: true });
  const work = await mkdtemp(join(tmpdir(), 'neon-render-'));
  const videoPath = join(work, 'video.mp4');
  const audioPath = join(work, 'audio.f32');
  const partialPath = join(dirname(opts.outputPath), `.${basename(opts.outputPath)}.${process.pid}.partial`);

  let server: RenderServer | null = null;
  let browser: Browser | null = null;
  let encoder: ChildProcess | null = null;
  const children = new Set<ChildProcess>();
  const killAll = () => {
    for (const c of children) if (c.exitCode === null && c.signalCode === null) c.kill('SIGKILL');
    void browser?.close();
  };
  ctrl.signal.addEventListener('abort', killAll, { once: true });

  try {
    server = await startRenderServer({
      bundleDir: opts.bundleDir,
      frames: { binaries: bins, keepBehind: Math.max(8, concurrency * 2 + 2), readAhead: Math.max(4, concurrency + 2), onLog: log },
    });
    browser = await launchBrowser({ executablePath: opts.browserExecutable, onLog: log });
    if (ctrl.signal.aborted) throw abortError(ctrl.signal);
    log(`renderer: ${basename(browser.executablePath)}, ${concurrency} tab${concurrency === 1 ? '' : 's'}, ${total} frames at ${width}x${height} @ ${fps} fps`);
    let browserDone = false;
    void browser.exited.then(() => {
      if (!browserDone && !ctrl.signal.aborted) ctrl.abort(new Error('Chrome exited unexpectedly during the render'));
    });

    const init: RenderInit = {
      props: opts.props,
      config: { id: opts.composition.id ?? 'Composition', width, height, fps, durationInFrames },
      frameServerUrl: server.url,
    };
    const pageUrl = `${server.url}/index.html`;
    const tabs = await Promise.all(Array.from({ length: concurrency }, () => openTab(browser!, pageUrl, init, log)));
    if (ctrl.signal.aborted) throw abortError(ctrl.signal);

    let encoderStderr = '';
    encoder = spawnEncoder(bins, { fps, width, height, crf: opts.crf ?? 18, preset: opts.x264Preset ?? 'medium', out: videoPath });
    children.add(encoder);
    encoder.stderr!.on('data', (c: Buffer) => {
      encoderStderr = (encoderStderr + c.toString('utf8')).slice(-8000);
    });
    encoder.stdin!.on('error', () => undefined); // EPIPE surfaces through the exit code below
    const encoderDone = waitForExit(encoder, 'Video encoding', () => encoderStderr);
    encoderDone.catch((err: unknown) => {
      if (!ctrl.signal.aborted) ctrl.abort(err);
    });

    const audioFrames: AudioFrameEntry[][] = new Array(total);
    const ready = new Map<number, Buffer>();
    let nextToRender = 0;
    let nextToWrite = 0;
    let rendered = 0;
    let writing = false;
    let lastProgress = 0;
    const renderStart = Date.now();

    const report = (force = false) => {
      const now = Date.now();
      if (!force && now - lastProgress < 100) return;
      lastProgress = now;
      opts.onProgress?.({ progress: Math.min(0.9, (0.9 * (rendered + nextToWrite)) / (2 * total)), renderedFrames: rendered, encodedFrames: nextToWrite });
    };

    const writeChunk = (buf: Buffer) =>
      new Promise<void>((resolve, reject) => {
        const stdin = encoder!.stdin!;
        if (ctrl.signal.aborted) return reject(abortError(ctrl.signal));
        if (stdin.write(buf)) return resolve();
        const onDrain = () => {
          ctrl.signal.removeEventListener('abort', onAbort);
          resolve();
        };
        const onAbort = () => {
          stdin.off('drain', onDrain);
          reject(abortError(ctrl.signal));
        };
        stdin.once('drain', onDrain);
        ctrl.signal.addEventListener('abort', onAbort, { once: true });
      });

    const flush = async () => {
      if (writing) return;
      writing = true;
      try {
        while (ready.has(nextToWrite)) {
          const buf = ready.get(nextToWrite)!;
          ready.delete(nextToWrite);
          await writeChunk(buf);
          nextToWrite++;
          report(nextToWrite === total);
        }
      } finally {
        writing = false;
      }
    };

    const frameError = async (tab: Tab, frame: number, err: unknown): Promise<Error> => {
      const base = err instanceof Error ? err.message : String(err);
      let detail = '';
      if (/timed out/.test(base)) {
        const state = await evaluate<{ pending: string[]; error: string | null }>(
          tab.session,
          'JSON.parse(JSON.stringify({ pending: window.__neonMotion ? window.__neonMotion.pendingDelayRenders() : [], error: window.__neonMotionError || null }))',
          5_000,
        ).catch(() => null);
        detail = `Frame ${frame} did not finish rendering within ${frameTimeoutMs} ms.`;
        if (state?.pending.length) detail += ` Still waiting on delayRender(): ${state.pending.map((p) => `"${p}"`).join(', ')}.`;
        if (state?.error) detail += ` Page error: ${state.error}`;
      } else {
        detail = `Frame ${frame} failed: ${base}`;
      }
      const frameErrors = server?.frames.recentErrors() ?? [];
      if (frameErrors.length) detail += `\nFrame server: ${frameErrors.slice(-3).join(' | ')}`;
      return new Error(detail);
    };

    const runTab = async (tab: Tab) => {
      for (;;) {
        if (ctrl.signal.aborted) throw abortError(ctrl.signal);
        // Don't let a fast tab run far ahead of a stuck one (bounded reorder buffer).
        while (nextToRender - nextToWrite > concurrency * 4 && !ctrl.signal.aborted) await new Promise((r) => setTimeout(r, 5));
        const index = nextToRender++;
        if (index >= total) return;
        const frame = from + index;
        try {
          const result = await evaluate<{ audio: AudioFrameEntry[] }>(tab.session, `window.__neonMotion.renderFrame(${frame})`, frameTimeoutMs);
          audioFrames[index] = result?.audio ?? [];
          const shot = await tab.session.send<{ data: string }>('Page.captureScreenshot', {
            format: 'jpeg',
            quality,
            clip: { x: 0, y: 0, width, height, scale: 1 },
            fromSurface: true,
            captureBeyondViewport: false,
            optimizeForSpeed: true,
          }, frameTimeoutMs);
          ready.set(index, Buffer.from(shot.data, 'base64'));
        } catch (err) {
          if (ctrl.signal.aborted) throw abortError(ctrl.signal);
          throw await frameError(tab, frame, err);
        }
        rendered++;
        report();
        await flush();
      }
    };

    try {
      await Promise.all(tabs.map((tab) => runTab(tab)));
      await flush();
    } catch (err) {
      if (!ctrl.signal.aborted) ctrl.abort(err);
      throw ctrl.signal.reason ?? err;
    }
    if (nextToWrite !== total) throw new Error(`Internal error: encoded ${nextToWrite} of ${total} frames`);
    encoder.stdin!.end();
    await encoderDone;
    const renderMs = Date.now() - renderStart;
    const renderFps = total / Math.max(0.001, renderMs / 1000);
    log(`renderer: ${total} frames in ${(renderMs / 1000).toFixed(1)} s (${renderFps.toFixed(1)} frames/s)`);
    browserDone = true;
    await browser.close();
    browser = null;
    report(true);

    // ---- audio + mux ----
    const mix = await mixAudio({ frames: audioFrames, fps, totalFrames: total, outputPath: audioPath, binaries: bins, signal: ctrl.signal, onLog: log });
    if (mix.peak > 1) log(`audio: mix peaked at ${mix.peak.toFixed(2)}; soft-clipped`);
    opts.onProgress?.({ progress: 0.95, renderedFrames: total, encodedFrames: total });

    let muxStderr = '';
    const mux = spawn(bins.ffmpeg, [
      '-hide_banner', '-nostdin', '-loglevel', 'error', '-y',
      '-i', videoPath,
      '-f', 'f32le', '-ar', String(MIX_SAMPLE_RATE), '-ac', String(MIX_CHANNELS), '-i', audioPath,
      '-map', '0:v:0', '-map', '1:a:0',
      '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k',
      '-movflags', '+faststart',
      '-f', 'mp4', partialPath,
    ], { stdio: ['ignore', 'ignore', 'pipe'] });
    children.add(mux);
    mux.stderr.on('data', (c: Buffer) => {
      muxStderr = (muxStderr + c.toString('utf8')).slice(-8000);
    });
    await waitForExit(mux, 'Muxing audio', () => muxStderr);
    if (ctrl.signal.aborted) throw abortError(ctrl.signal);
    await rename(partialPath, opts.outputPath);
    opts.onProgress?.({ progress: 1, renderedFrames: total, encodedFrames: total });
    return { outputPath: opts.outputPath, frames: total, durationMs: Date.now() - started, renderFps };
  } catch (err) {
    if (!ctrl.signal.aborted) ctrl.abort(err);
    throw opts.signal?.aborted ? abortError(opts.signal) : err;
  } finally {
    opts.signal?.removeEventListener('abort', onExternalAbort);
    killAll();
    await browser?.close().catch(() => undefined);
    await server?.close().catch(() => undefined);
    await rm(work, { recursive: true, force: true }).catch(() => undefined);
    await rm(partialPath, { force: true }).catch(() => undefined);
  }
}
