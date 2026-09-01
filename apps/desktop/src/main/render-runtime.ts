/**
 * Locate — or fetch — the self-contained render runtime so exports work on installed apps,
 * not just from a source checkout. Resolution order:
 *
 *   1. NEON_RENDER_RUNTIME_DIR env var        (explicit override, must be valid)
 *   2. settings.json → renderRuntimeDir       (persistent override)
 *   3. the dev monorepo                       (running from source)
 *   4. ~/.neon-video/render-runtime/v<ver>    (downloaded from the GitHub release on first render)
 *
 * The downloadable pack is built per platform by CI (`pnpm --filter @neon/render deploy`) and
 * uploaded to every release as render-runtime-<platform>.tar.gz.
 */
import { existsSync } from 'node:fs';
import { mkdir, readdir, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { neonHome } from '@neon/core/node';
import { which } from '@neon/ai';
import { isRenderRuntime, renderPaths, runtimePaths, type RenderPaths } from '@neon/render';
import { repoRoot } from './paths.ts';
import type { Settings } from './settings.ts';

const RELEASE_BASE = 'https://github.com/joe-lloyd/neon-video-studio/releases';

function platformLabel(): string | null {
  if (process.platform === 'darwin' && process.arch === 'arm64') return 'macos-arm64';
  if (process.platform === 'win32' && process.arch === 'x64') return 'windows-x64';
  if (process.platform === 'linux' && process.arch === 'x64') return 'linux-x64';
  return null;
}

export interface RenderRuntime {
  paths: RenderPaths;
  /** Worker child-process cwd — the runtime root, so cwd-relative resolution works when packaged. */
  cwd: string;
  source: 'env' | 'settings' | 'repo' | 'downloaded';
}

let inflight: Promise<RenderRuntime> | null = null;

export function ensureRenderRuntime(opts: { version: string; settings: Settings }, onLog: (line: string) => void): Promise<RenderRuntime> {
  // Renders are queued sequentially, but keep concurrent callers from racing the download anyway.
  inflight ??= resolveRuntime(opts, onLog).finally(() => {
    inflight = null;
  });
  return inflight;
}

async function resolveRuntime({ version, settings }: { version: string; settings: Settings }, onLog: (line: string) => void): Promise<RenderRuntime> {
  const fromEnv = process.env.NEON_RENDER_RUNTIME_DIR;
  if (fromEnv) {
    if (!isRenderRuntime(fromEnv)) throw new Error(`NEON_RENDER_RUNTIME_DIR is set but ${fromEnv} is not a render runtime (expected src/worker.ts + node_modules/@neon/remotion-workspace)`);
    return { paths: runtimePaths(fromEnv), cwd: fromEnv, source: 'env' };
  }
  if (settings.renderRuntimeDir) {
    if (!isRenderRuntime(settings.renderRuntimeDir)) throw new Error(`settings.renderRuntimeDir (${settings.renderRuntimeDir}) is not a render runtime — fix or remove it in ${join(neonHome(), 'settings.json')}`);
    return { paths: runtimePaths(settings.renderRuntimeDir), cwd: settings.renderRuntimeDir, source: 'settings' };
  }
  try {
    const root = repoRoot();
    return { paths: renderPaths(root), cwd: root, source: 'repo' };
  } catch {
    /* not running from a checkout — use the downloaded runtime */
  }

  const base = join(neonHome(), 'render-runtime');
  const dir = join(base, `v${version}`);
  if (!isRenderRuntime(dir)) {
    await downloadRuntime(dir, version, onLog);
    // The current version is the only one ever used — drop the rest.
    for (const entry of await readdir(base).catch(() => [] as string[])) {
      if (entry !== `v${version}`) await rm(join(base, entry), { recursive: true, force: true }).catch(() => undefined);
    }
  }
  await shareRemotionCache(dir);
  return { paths: runtimePaths(dir), cwd: dir, source: 'downloaded' };
}

/**
 * Remotion downloads its headless browser into <cwd>/node_modules/.remotion. Point that at a
 * shared per-user dir so a new runtime version doesn't re-download ~150 MB of Chrome.
 */
async function shareRemotionCache(dir: string): Promise<void> {
  const shared = join(neonHome(), 'remotion-bin');
  const local = join(dir, 'node_modules', '.remotion');
  try {
    await mkdir(shared, { recursive: true });
    if (!existsSync(local)) {
      const { symlink } = await import('node:fs/promises');
      await symlink(shared, local, process.platform === 'win32' ? 'junction' : 'dir');
    }
  } catch (err) {
    // Non-fatal: Remotion just downloads into the runtime dir instead.
    console.warn('[render] could not share the Remotion browser cache:', (err as Error).message);
  }
}

async function downloadRuntime(dir: string, version: string, onLog: (line: string) => void): Promise<void> {
  const label = platformLabel();
  if (!label) throw new Error(`No render runtime is published for ${process.platform}/${process.arch}`);
  const asset = `render-runtime-${label}.tar.gz`;
  const curl = (await which('curl')) ?? 'curl';
  const tar = (await which('tar')) ?? 'tar';
  const partial = `${dir}.partial`;
  await rm(partial, { recursive: true, force: true }).catch(() => undefined);
  await mkdir(partial, { recursive: true });
  const archive = join(partial, asset);
  const { runOrThrow } = await import('@neon/ai');
  // Exact version first (app and runtime must match), then latest as a best-effort fallback.
  const urls = [`${RELEASE_BASE}/download/v${version}/${asset}`, `${RELEASE_BASE}/latest/download/${asset}`];
  let fetched = false;
  for (const url of urls) {
    onLog(`Downloading render runtime (~150 MB, one time): ${url}`);
    try {
      await runOrThrow(curl, ['-fL', '--retry', '3', '-o', archive, url], {});
      fetched = true;
      break;
    } catch (err) {
      onLog(`Download failed: ${(err as Error).message}`);
    }
  }
  if (!fetched) throw new Error(`Could not download the render runtime (${asset}) — check your connection, or set renderRuntimeDir in ${join(neonHome(), 'settings.json')} / NEON_RENDER_RUNTIME_DIR`);
  onLog('Extracting render runtime…');
  await runOrThrow(tar, ['-xzf', archive, '-C', partial], {});
  await rm(archive, { force: true });
  if (!isRenderRuntime(partial)) throw new Error('Downloaded render runtime is incomplete — please retry');
  await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  await rename(partial, dir);
  onLog(`Render runtime ready at ${dir}`);
}
