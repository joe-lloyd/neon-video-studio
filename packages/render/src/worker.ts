/**
 * Render worker. Runs under Node (not Bun): @remotion/renderer drives a headless Chrome and
 * its own compositor binary, which are only supported on Node. Emits NDJSON events on stdout.
 *
 *   node packages/render/src/worker.ts --job /tmp/job.json
 */
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, stat } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { bundle } from '@remotion/bundler';
import { makeCancelSignal, renderMedia, selectComposition } from '@remotion/renderer';
import { projectDurationFrames } from '@neon/core';
import type { RenderJobSpec, WorkerEvent } from './types.ts';

const TIMELINE_COMPOSITION_ID = 'Timeline';

type WorkerEventBody = { [K in WorkerEvent['type']]: Omit<Extract<WorkerEvent, { type: K }>, 'neon'> }[WorkerEvent['type']];

function emit(event: WorkerEventBody): void {
  process.stdout.write(`${JSON.stringify({ neon: 1, ...event })}\n`);
}

async function fingerprint(dirs: string[], extra: string): Promise<string> {
  const hash = createHash('sha256');
  hash.update(extra);
  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    const entries = await readdir(dir, { recursive: true, withFileTypes: true });
    const files = entries
      .filter((e) => e.isFile() && !e.name.endsWith('.test.ts'))
      .map((e) => join(e.parentPath ?? (e as unknown as { path: string }).path, e.name))
      .sort();
    for (const file of files) {
      const s = await stat(file);
      hash.update(`${relative(dir, file)}:${s.size}:${Math.floor(s.mtimeMs)}\n`);
    }
  }
  return hash.digest('hex').slice(0, 16);
}

async function remotionVersion(): Promise<string> {
  try {
    const require = (await import('node:module')).createRequire(import.meta.url);
    const pkg = require('remotion/package.json') as { version: string };
    return pkg.version;
  } catch {
    return 'unknown';
  }
}

async function ensureBundle(spec: RenderJobSpec): Promise<string> {
  const key = await fingerprint(spec.watchDirs, await remotionVersion());
  const outDir = join(spec.bundleCacheDir, key);
  if (existsSync(join(outDir, 'index.html'))) {
    emit({ type: 'bundle', cached: true, location: outDir });
    return outDir;
  }
  emit({ type: 'stage', stage: 'bundling', message: 'Bundling Remotion project (first run can take a while)' });
  await mkdir(spec.bundleCacheDir, { recursive: true });
  const location = await bundle({
    entryPoint: spec.entryPoint,
    outDir,
    // Keep webpack's persistent cache next to the bundles so re-bundles are fast.
    enableCaching: true,
    webpackOverride: (config) => config,
  });
  emit({ type: 'bundle', cached: false, location });
  return location;
}

async function main(): Promise<void> {
  const jobIndex = process.argv.indexOf('--job');
  const jobPath = jobIndex >= 0 ? process.argv[jobIndex + 1] : undefined;
  if (!jobPath) throw new Error('Usage: worker.ts --job <spec.json>');
  const spec = JSON.parse(await readFile(jobPath, 'utf8')) as RenderJobSpec;

  const started = Date.now();
  const { cancelSignal, cancel } = makeCancelSignal();
  const onTerminate = () => {
    emit({ type: 'stage', stage: 'rendering', message: 'Cancelling…' });
    cancel();
  };
  process.on('SIGTERM', onTerminate);
  process.on('SIGINT', onTerminate);

  const serveUrl = await ensureBundle(spec);

  const projectFps = spec.project.meta.fps;
  const inputProps = {
    project: spec.project,
    assetBaseUrl: spec.assetBaseUrl,
    assetQuery: spec.assetQuery ?? '',
    render: { width: spec.preset.width, height: spec.preset.height, fps: spec.preset.fps },
  };

  emit({ type: 'stage', stage: 'rendering', message: 'Resolving composition' });
  const composition = await selectComposition({
    serveUrl,
    id: TIMELINE_COMPOSITION_ID,
    inputProps,
    logLevel: 'warn',
    binariesDirectory: spec.binariesDirectory ?? null,
  });

  const scale = composition.fps / projectFps;
  let frameRange: [number, number] | null = null;
  if (spec.frameRange) {
    const total = Math.max(1, Math.round(projectDurationFrames(spec.project) * scale));
    const from = Math.max(0, Math.min(total - 1, Math.round(spec.frameRange[0] * scale)));
    const to = Math.max(from, Math.min(total - 1, Math.round(spec.frameRange[1] * scale)));
    frameRange = [from, to];
  }
  const totalFrames = frameRange ? frameRange[1] - frameRange[0] + 1 : composition.durationInFrames;
  emit({ type: 'start', totalFrames, width: composition.width, height: composition.height, fps: composition.fps });

  await mkdir(dirname(spec.outputPath), { recursive: true });
  await renderMedia({
    composition,
    serveUrl,
    codec: 'h264',
    crf: spec.preset.crf,
    outputLocation: spec.outputPath,
    inputProps,
    frameRange,
    cancelSignal,
    concurrency: spec.concurrency ?? null,
    overwrite: true,
    logLevel: 'warn',
    browserExecutable: spec.browserExecutable ?? null,
    binariesDirectory: spec.binariesDirectory ?? null,
    ...(spec.licenseKey ? { licenseKey: spec.licenseKey } : {}),
    onProgress: ({ progress, renderedFrames, encodedFrames }) => {
      emit({ type: 'progress', progress, renderedFrames, encodedFrames });
    },
  });

  emit({ type: 'done', outputPath: spec.outputPath, durationMs: Date.now() - started });
}

main().then(
  () => process.exit(0),
  (err: unknown) => {
    const e = err instanceof Error ? err : new Error(String(err));
    emit({ type: 'error', message: e.message, stack: e.stack });
    process.exit(1);
  },
);
