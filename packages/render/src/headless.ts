/** Render a project directory without the desktop app (CLI --headless). */
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { ProjectSchema, type Project } from '@neon/core';
import { discoverInstalledPacks } from '@neon/core/node';
import { startAssetServer } from './asset-server.ts';
import { findRepoRoot, renderPaths } from './paths.ts';
import { runRenderWorker } from './run.ts';
import type { RenderJobSpec, RenderResult, RenderTarget, WorkerEvent } from './types.ts';

export interface HeadlessRenderOptions {
  projectDir: string;
  /** What to produce; built from the loaded project because presets and frames depend on it. */
  target: (project: Project) => RenderTarget;
  repoRoot?: string;
  bundleCacheDir?: string;
  onEvent?: (event: WorkerEvent) => void;
  onLog?: (line: string) => void;
}

export async function loadProjectDir(projectDir: string): Promise<Project> {
  const raw = await readFile(join(projectDir, 'project.json'), 'utf8');
  return ProjectSchema.parse(JSON.parse(raw));
}

export async function renderHeadless(opts: HeadlessRenderOptions): Promise<RenderResult> {
  const repoRoot = opts.repoRoot ?? findRepoRoot(new URL('.', import.meta.url).pathname) ?? findRepoRoot();
  if (!repoRoot) throw new Error('Could not locate the repository root (pnpm-workspace.yaml)');
  const paths = renderPaths(repoRoot);
  const projectDir = resolve(opts.projectDir);
  const project = await loadProjectDir(projectDir);
  const target = opts.target(project);
  const assets = await startAssetServer(join(projectDir, 'assets'));
  const enabled = new Set(project.meta.packs ?? []);
  const packs = (await discoverInstalledPacks()).filter((p) => enabled.has(p.name) && p.manifest && !p.error);
  try {
    const spec: RenderJobSpec = {
      ...target,
      outputPath: resolve(target.outputPath),
      project,
      assetBaseUrl: assets.baseUrl,
      bundleCacheDir: opts.bundleCacheDir ?? join(repoRoot, '.remotion-bundle'),
      entryPoint: paths.entryPoint,
      watchDirs: [...paths.watchDirs, ...packs.map((p) => p.dir)],
      packs: packs.map((p) => ({ name: p.name, entry: p.entry })),
      licenseKey: process.env.REMOTION_LICENSE_KEY,
    };
    const run = runRenderWorker(spec, { workerPath: paths.workerPath, onEvent: opts.onEvent, onLog: opts.onLog });
    return await run.promise;
  } finally {
    await assets.close();
  }
}
