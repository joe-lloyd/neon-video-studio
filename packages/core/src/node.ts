/**
 * Node/Bun-only helpers (filesystem, hashing, instance discovery). Not for the browser.
 */
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { extname, join } from 'node:path';
import type { InstanceInfo } from './api.ts';
import type { AssetKind } from './types.ts';
import { PACK_DEFAULT_ENTRY, PACK_MANIFEST_FILE, parsePackManifest, type PackManifest } from './packs.ts';
import { registerPack } from './templates.ts';

export function neonHome(): string {
  return process.env.NEON_HOME ?? join(homedir(), '.neon-video');
}

export function instanceFilePath(): string {
  return join(neonHome(), 'instance.json');
}

export async function writeInstanceInfo(info: InstanceInfo): Promise<void> {
  await mkdir(neonHome(), { recursive: true, mode: 0o700 });
  const path = instanceFilePath();
  await writeFile(path, JSON.stringify(info, null, 2), { mode: 0o600 });
  await chmod(path, 0o600).catch(() => undefined);
}

export async function readInstanceInfo(): Promise<InstanceInfo | null> {
  try {
    const raw = await readFile(instanceFilePath(), 'utf8');
    const info = JSON.parse(raw) as InstanceInfo;
    if (typeof info.port !== 'number' || typeof info.token !== 'string') return null;
    return info;
  } catch {
    return null;
  }
}

export async function clearInstanceInfo(expectedPid?: number): Promise<void> {
  const current = await readInstanceInfo();
  if (expectedPid !== undefined && current && current.pid !== expectedPid) return;
  await rm(instanceFilePath(), { force: true });
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export function sha256File(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    createReadStream(path)
      .on('data', (chunk) => hash.update(chunk))
      .on('error', reject)
      .on('end', () => resolve(hash.digest('hex')));
  });
}

const MIME: Record<string, { mime: string; kind: AssetKind }> = {
  '.mp4': { mime: 'video/mp4', kind: 'video' },
  '.m4v': { mime: 'video/mp4', kind: 'video' },
  '.mov': { mime: 'video/quicktime', kind: 'video' },
  '.webm': { mime: 'video/webm', kind: 'video' },
  '.mkv': { mime: 'video/x-matroska', kind: 'video' },
  '.mp3': { mime: 'audio/mpeg', kind: 'audio' },
  '.wav': { mime: 'audio/wav', kind: 'audio' },
  '.m4a': { mime: 'audio/mp4', kind: 'audio' },
  '.aac': { mime: 'audio/aac', kind: 'audio' },
  '.ogg': { mime: 'audio/ogg', kind: 'audio' },
  '.flac': { mime: 'audio/flac', kind: 'audio' },
  '.png': { mime: 'image/png', kind: 'image' },
  '.jpg': { mime: 'image/jpeg', kind: 'image' },
  '.jpeg': { mime: 'image/jpeg', kind: 'image' },
  '.gif': { mime: 'image/gif', kind: 'image' },
  '.webp': { mime: 'image/webp', kind: 'image' },
  '.svg': { mime: 'image/svg+xml', kind: 'image' },
  '.avif': { mime: 'image/avif', kind: 'image' },
};

export const SUPPORTED_EXTENSIONS = Object.keys(MIME).map((e) => e.slice(1));

export function mediaTypeForFile(path: string): { mime: string; kind: AssetKind } | null {
  return MIME[extname(path).toLowerCase()] ?? null;
}

export function extensionForMime(mime: string): string {
  const entry = Object.entries(MIME).find(([, v]) => v.mime === mime);
  return entry ? entry[0] : '';
}

// ---- installed FX packs -----------------------------------------------------------------

export function packsDir(): string {
  return join(neonHome(), 'packs');
}

export interface DiscoveredPack {
  /** Folder name (== manifest.name when valid). */
  name: string;
  dir: string;
  manifest: PackManifest | null;
  /** Absolute path of the component entry module. */
  entry: string;
  error?: string;
}

/** Read a single pack folder: parse + validate pack.json and check the entry module exists. */
export async function readPackDir(dir: string): Promise<DiscoveredPack> {
  const { access } = await import('node:fs/promises');
  const { basename } = await import('node:path');
  const name = basename(dir);
  try {
    const manifest = parsePackManifest(JSON.parse(await readFile(join(dir, PACK_MANIFEST_FILE), 'utf8')));
    const entry = join(dir, manifest.entry ?? PACK_DEFAULT_ENTRY);
    if (manifest.name !== name) return { name, dir, manifest, entry, error: `folder is "${name}" but pack.json says "${manifest.name}"` };
    await access(entry);
    return { name, dir, manifest, entry };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    const message = code === 'ENOENT' ? `no ${PACK_MANIFEST_FILE} found in ${dir}` : (err as Error).message;
    return { name, dir, manifest: null, entry: join(dir, PACK_DEFAULT_ENTRY), error: message };
  }
}

/** Every pack folder under `dir` (default ~/.neon-video/packs), valid or not. */
export async function discoverInstalledPacks(dir = packsDir()): Promise<DiscoveredPack[]> {
  const { readdir } = await import('node:fs/promises');
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  const out: DiscoveredPack[] = [];
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith('.')) continue;
    out.push(await readPackDir(join(dir, e.name)));
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** Register the templates of every valid installed pack in this process's registry. */
export async function registerInstalledPacks(dir = packsDir()): Promise<DiscoveredPack[]> {
  const packs = await discoverInstalledPacks(dir);
  for (const p of packs) {
    if (!p.manifest || p.error) continue;
    const { conflicts } = registerPack(p.manifest, 'installed', p.dir);
    if (conflicts.length) p.error = `skipped: ${conflicts.join(', ')}`;
  }
  return packs;
}
