/**
 * Content-addressed asset handling: import (hash → copy → probe), lookup for serving, and
 * replication from room peers when a hash is missing locally.
 */
import { execFile } from 'node:child_process';
import { access, copyFile, mkdir, readdir, stat } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import { promisify } from 'node:util';
import { ORIGIN_API, type Asset, type Clip, type ImportAssetResponse } from '@neon/core';
import { mediaTypeForFile, sha256File } from '@neon/core/node';
import type { ProjectStore } from './project-store.ts';

const execFileAsync = promisify(execFile);

export interface ProbeResult {
  durationSeconds?: number;
  width?: number;
  height?: number;
  fps?: number;
}

let ffprobeChecked: Promise<boolean> | null = null;
export function ffprobeAvailable(): Promise<boolean> {
  if (!ffprobeChecked) {
    ffprobeChecked = execFileAsync('ffprobe', ['-version'])
      .then(() => true)
      .catch(() => false);
  }
  return ffprobeChecked;
}

export async function probeMedia(path: string): Promise<ProbeResult> {
  if (!(await ffprobeAvailable())) return {};
  try {
    const { stdout } = await execFileAsync('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', path], {
      maxBuffer: 4 * 1024 * 1024,
    });
    const data = JSON.parse(stdout) as {
      streams?: { codec_type?: string; width?: number; height?: number; r_frame_rate?: string; avg_frame_rate?: string; duration?: string }[];
      format?: { duration?: string };
    };
    const video = data.streams?.find((s) => s.codec_type === 'video');
    const result: ProbeResult = {};
    const duration = Number(data.format?.duration ?? video?.duration);
    if (Number.isFinite(duration) && duration > 0) result.durationSeconds = duration;
    if (video?.width && video?.height) {
      result.width = video.width;
      result.height = video.height;
    }
    const rate = video?.avg_frame_rate && video.avg_frame_rate !== '0/0' ? video.avg_frame_rate : video?.r_frame_rate;
    if (rate) {
      const [n, d] = rate.split('/').map(Number);
      if (n && d) result.fps = Math.round((n / d) * 1000) / 1000;
    }
    return result;
  } catch (err) {
    console.warn('[assets] ffprobe failed', (err as Error).message);
    return {};
  }
}

export class AssetManager {
  /** Base URLs (including any ?room= query) of peers we may fetch missing assets from. */
  remoteBases: string[] = [];
  private readonly inflight = new Map<string, Promise<string | null>>();

  private readonly store: ProjectStore;
  private readonly peerId: string;

  constructor(store: ProjectStore, peerId: string) {
    this.store = store;
    this.peerId = peerId;
  }

  async import(
    sourcePath: string,
    opts: { insertAt?: number; trackId?: string; origin?: unknown } = {},
  ): Promise<ImportAssetResponse> {
    const type = mediaTypeForFile(sourcePath);
    if (!type) throw new Error(`Unsupported file type: ${basename(sourcePath)}`);
    const info = await stat(sourcePath).catch(() => null);
    if (!info || !info.isFile()) throw new Error(`File not found: ${sourcePath}`);

    const hash = await sha256File(sourcePath);
    const ext = extname(sourcePath).toLowerCase();
    const target = join(this.store.assetsDir, `${hash}${ext}`);
    await mkdir(this.store.assetsDir, { recursive: true });
    const existed = await access(target).then(() => true, () => false);
    if (!existed) await copyFile(sourcePath, target);

    const doc = this.store.doc;
    const known = doc.getAsset(hash);
    let asset: Asset;
    if (known) {
      asset = known;
    } else {
      const probe = await probeMedia(target);
      const fps = doc.fps;
      asset = {
        id: hash,
        name: basename(sourcePath),
        kind: type.kind,
        mime: type.mime,
        size: info.size,
        importedAt: new Date().toISOString(),
        importedBy: this.peerId,
      };
      if (probe.durationSeconds) asset.durationFrames = Math.max(1, Math.round(probe.durationSeconds * fps));
      if (probe.width) asset.width = probe.width;
      if (probe.height) asset.height = probe.height;
      if (probe.fps) asset.fps = probe.fps;
      doc.addAsset(asset, opts.origin ?? ORIGIN_API);
    }

    let clip: Clip | undefined;
    if (opts.insertAt !== undefined || opts.trackId) {
      clip = doc.insertClip(
        { kind: asset.kind, assetId: asset.id, startFrame: opts.insertAt, trackId: opts.trackId, placement: opts.insertAt === undefined ? 'free' : 'ripple' },
        opts.origin ?? ORIGIN_API,
      );
    }
    return { asset, clip, deduplicated: Boolean(known) };
  }

  /** Local path for a hash, replicating from peers if necessary. */
  async resolveFile(hash: string): Promise<string | null> {
    if (!/^[a-f0-9]{64}$/.test(hash)) return null;
    const local = await this.findLocal(hash);
    if (local) return local;
    if (this.remoteBases.length === 0) return null;
    let pending = this.inflight.get(hash);
    if (!pending) {
      pending = this.fetchFromPeers(hash).finally(() => this.inflight.delete(hash));
      this.inflight.set(hash, pending);
    }
    return pending;
  }

  private async findLocal(hash: string): Promise<string | null> {
    const entries = await readdir(this.store.assetsDir).catch(() => [] as string[]);
    const match = entries.find((f) => f === hash || (f.startsWith(`${hash}.`) && !f.endsWith('.part')));
    return match ? join(this.store.assetsDir, match) : null;
  }

  private async fetchFromPeers(hash: string): Promise<string | null> {
    const asset = this.store.doc.getAsset(hash);
    const ext = asset ? extname(asset.name).toLowerCase() : '';
    for (const base of this.remoteBases) {
      const [path, query] = base.split('?');
      const url = `${path!.replace(/\/$/, '')}/${hash}${query ? `?${query}` : ''}`;
      try {
        const res = await fetch(url);
        if (!res.ok || !res.body) continue;
        const target = join(this.store.assetsDir, `${hash}${ext}`);
        const part = `${target}.part`;
        await Bun.write(part, res);
        const digest = await sha256File(part);
        if (digest !== hash) {
          console.warn(`[assets] hash mismatch fetching ${hash.slice(0, 8)} from ${base}`);
          await Bun.file(part).delete?.();
          continue;
        }
        await (await import('node:fs/promises')).rename(part, target);
        console.log(`[assets] replicated ${hash.slice(0, 8)}… from ${base}`);
        return target;
      } catch (err) {
        console.warn(`[assets] fetch from ${base} failed: ${(err as Error).message}`);
      }
    }
    return null;
  }
}
