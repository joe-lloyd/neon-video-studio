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
