import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { neonHome } from '@neon/core/node';

/**
 * Locate the monorepo root. In dev the app bundle lives under apps/desktop/build/…, so walking
 * up from cwd or from this file works. NEON_REPO_ROOT overrides everything.
 */
export function repoRoot(): string {
  if (process.env.NEON_REPO_ROOT) return process.env.NEON_REPO_ROOT;
  const candidates = [process.cwd(), dirname(process.execPath), new URL('.', import.meta.url).pathname];
  for (const start of candidates) {
    let dir = resolve(start);
    for (let i = 0; i < 12; i++) {
      if (existsSync(join(dir, 'pnpm-workspace.yaml')) && existsSync(join(dir, 'apps/remotion-workspace'))) return dir;
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  throw new Error('Cannot locate the neon-video-editor repository root. Set NEON_REPO_ROOT.');
}

export const paths = {
  home: () => neonHome(),
  scratchProjects: () => join(neonHome(), 'projects'),
  recentFile: () => join(neonHome(), 'recent.json'),
  settingsFile: () => join(neonHome(), 'settings.json'),
  bundleCache: () => join(neonHome(), 'remotion-bundle'),
  renders: () => join(neonHome(), 'renders'),
};
