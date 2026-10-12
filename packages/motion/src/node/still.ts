/**
 * Headless still: one frame of a bundled composition as a PNG. The page lays out at composition
 * size and Chrome rasterises it `scale` times larger (device scale factor), so text and vector
 * effects stay sharp at any output width and keep their proportions.
 */
import { mkdir, rename, rm } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { writeFile } from 'node:fs/promises';
import type { RenderInit } from './protocol.ts';
import { launchBrowser, type Browser } from './browser.ts';
import { defaultBinaries, type FfmpegBinaries } from './probe.ts';
import { startRenderServer, type RenderServer } from './server.ts';
import { abortError, evaluate, openTab, type RenderComposition } from './render.ts';

export interface RenderStillOptions {
  /** Directory with index.html, from bundleComposition(). */
  bundleDir: string;
  props: Record<string, unknown>;
  composition: RenderComposition;
  /** Composition frame to capture. */
  frame: number;
  outputPath: string;
  /** Output pixels per composition pixel (default 1). */
  scale?: number;
  /** Keep areas the composition leaves empty transparent instead of black. */
  transparent?: boolean;
  browserExecutable?: string | null;
  signal?: AbortSignal;
  onLog?: (line: string) => void;
  /** Limit for the frame to become ready (default 60 s). */
  timeoutMs?: number;
  binaries?: FfmpegBinaries;
}

export interface RenderStillResult {
  outputPath: string;
  /** Pixel size of the PNG. */
  width: number;
  height: number;
  durationMs: number;
}

export async function renderStill(opts: RenderStillOptions): Promise<RenderStillResult> {
  const started = Date.now();
  const { width, height, fps, durationInFrames } = opts.composition;
  if (!(width > 0 && height > 0 && fps > 0 && durationInFrames > 0)) throw new Error(`Invalid composition ${width}x${height} @ ${fps} fps, ${durationInFrames} frames`);
  const frame = Math.round(opts.frame);
  if (!(frame >= 0 && frame < durationInFrames)) throw new Error(`Frame ${opts.frame} is outside the composition (0–${durationInFrames - 1})`);
  const scale = opts.scale ?? 1;
  if (!(scale > 0 && scale <= 16)) throw new Error(`Still scale must be within (0, 16], got ${scale}`);
  if (opts.signal?.aborted) throw abortError(opts.signal);
  const log = opts.onLog ?? (() => undefined);
  const timeoutMs = opts.timeoutMs ?? 60_000;

  await mkdir(dirname(opts.outputPath), { recursive: true });
  const partialPath = join(dirname(opts.outputPath), `.${basename(opts.outputPath)}.${process.pid}.partial`);
  let server: RenderServer | null = null;
  let browser: Browser | null = null;
  const onAbort = () => void browser?.close();
  opts.signal?.addEventListener('abort', onAbort, { once: true });
  try {
    server = await startRenderServer({ bundleDir: opts.bundleDir, frames: { binaries: opts.binaries ?? defaultBinaries(), onLog: log } });
    browser = await launchBrowser({ executablePath: opts.browserExecutable, onLog: log });
    if (opts.signal?.aborted) throw abortError(opts.signal);
    const init: RenderInit = { props: opts.props, config: { id: opts.composition.id ?? 'Composition', width, height, fps, durationInFrames }, frameServerUrl: server.url };
    const tab = await openTab(browser, `${server.url}/index.html`, init, log, { deviceScaleFactor: scale, transparent: opts.transparent });
    await evaluate(tab.session, `window.__neonMotion.renderFrame(${frame})`, timeoutMs);
    const shot = await tab.session.send<{ data: string }>(
      'Page.captureScreenshot',
      { format: 'png', clip: { x: 0, y: 0, width, height, scale: 1 }, fromSurface: true, captureBeyondViewport: false },
      timeoutMs,
    );
    if (opts.signal?.aborted) throw abortError(opts.signal);
    const png = Buffer.from(shot.data, 'base64');
    await writeFile(partialPath, png);
    await rename(partialPath, opts.outputPath);
    // Width and height from the PNG's IHDR chunk: exactly what Chrome rasterised.
    return { outputPath: opts.outputPath, width: png.readUInt32BE(16), height: png.readUInt32BE(20), durationMs: Date.now() - started };
  } catch (err) {
    throw opts.signal?.aborted ? abortError(opts.signal) : err;
  } finally {
    opts.signal?.removeEventListener('abort', onAbort);
    await browser?.close().catch(() => undefined);
    await server?.close().catch(() => undefined);
    await rm(partialPath, { force: true }).catch(() => undefined);
  }
}
