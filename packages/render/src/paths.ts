import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

/** Walk upwards from `start` until a directory containing pnpm-workspace.yaml is found. */
export function findRepoRoot(start: string = process.cwd()): string | null {
  let dir = resolve(start);
  for (let i = 0; i < 12; i++) {
    if (existsSync(join(dir, 'pnpm-workspace.yaml'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

export interface RenderPaths {
  repoRoot: string;
  workerPath: string;
  entryPoint: string;
  watchDirs: string[];
}

export function renderPaths(repoRoot: string): RenderPaths {
  return {
    repoRoot,
    workerPath: join(repoRoot, 'packages/render/src/worker.ts'),
    entryPoint: join(repoRoot, 'apps/remotion-workspace/src/index.ts'),
    watchDirs: [join(repoRoot, 'apps/remotion-workspace/src'), join(repoRoot, 'packages/core/src')],
  };
}
