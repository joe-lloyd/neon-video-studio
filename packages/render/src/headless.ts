/** Render a project directory without the desktop app (CLI --headless). */
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { getPreset, projectPreset, ProjectSchema, type Project } from '@neon/core';
import { startAssetServer } from './asset-server.ts';
import { findRepoRoot, renderPaths } from './paths.ts';
import { runRenderWorker } from './run.ts';
import type { RenderJobSpec, WorkerEvent } from './types.ts';

export interface HeadlessRenderOptions {
  projectDir: string;
  outputPath: string;
  presetId?: string;
  frameRange?: [number, number] | null;
  repoRoot?: string;
  bundleCacheDir?: string;
  onEvent?: (event: WorkerEvent) => void;
  onLog?: (line: string) => void;
}

export async function loadProjectDir(projectDir: string): Promise<Project> {
  const raw = await readFile(join(projectDir, 'project.json'), 'utf8');
  return ProjectSchema.parse(JSON.parse(raw));
}

export async function renderHeadless(opts: HeadlessRenderOptions): Promise<{ outputPath: string; durationMs: number }> {
  const repoRoot = opts.repoRoot ?? findRepoRoot(new URL('.', import.meta.url).pathname) ?? findRepoRoot();
  if (!repoRoot) throw new Error('Could not locate the repository root (pnpm-workspace.yaml)');
  const paths = renderPaths(repoRoot);
  const projectDir = resolve(opts.projectDir);
  const project = await loadProjectDir(projectDir);
  const preset = !opts.presetId || opts.presetId === 'project' ? projectPreset(project.meta) : getPreset(opts.presetId);
  const assets = await startAssetServer(join(projectDir, 'assets'));
  try {
    const spec: RenderJobSpec = {
      project,
      outputPath: resolve(opts.outputPath),
      preset,
      assetBaseUrl: assets.baseUrl,
      frameRange: opts.frameRange ?? null,
      bundleCacheDir: opts.bundleCacheDir ?? join(repoRoot, '.remotion-bundle'),
      entryPoint: paths.entryPoint,
      watchDirs: paths.watchDirs,
      licenseKey: process.env.REMOTION_LICENSE_KEY,
    };
    const run = runRenderWorker(spec, { workerPath: paths.workerPath, onEvent: opts.onEvent, onLog: opts.onLog });
    return await run.promise;
  } finally {
    await assets.close();
  }
}
