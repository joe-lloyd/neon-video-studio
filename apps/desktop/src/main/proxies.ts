/**
 * Preview proxies: a small, quick-to-seek copy of every video asset, used only by the editor's
 * preview so scrubbing shows a picture. Exports never ask for them and read the original.
 *
 * Screen recordings are often 4K with a keyframe every few seconds, so each seek decodes hundreds
 * of 4K frames and the preview goes black while you drag. A proxy is 720p with a keyframe every 10
 * frames and the source's own timestamps, so any frame decodes almost at once and lands on the same
 * time as in the original. Built one at a time in the background and cached by content hash in
 * ~/.neon-video/proxies/<hash>.mp4, so every project that uses the file shares it.
 */
import { spawn } from 'node:child_process';
import { mkdir, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { which } from '@neon/ai';
import type { Asset } from '@neon/core';
import { neonHome } from '@neon/core/node';
import type { AssetManager } from './assets.ts';

/** ffmpeg arguments that turn `input` into a preview proxy at `output`. */
export function proxyArgs(input: string, output: string): string[] {
  return [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-i', input,
    '-map', '0:v:0', '-map', '0:a:0?',
    // Keep every source timestamp so a time in the proxy is the same moment in the original.
    '-fps_mode', 'passthrough',
    '-vf', "scale=-2:'min(720,ih)'",
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-tune', 'fastdecode', '-g', '10', '-bf', '0', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '128k',
    '-movflags', '+faststart',
    output,
  ];
}

/** Video assets get a proxy; transparent ones keep their alpha by playing the original. */
export function wantsProxy(asset: Pick<Asset, 'kind' | 'hasAlpha'>): boolean {
  return asset.kind === 'video' && !asset.hasAlpha;
}

export class ProxyCache {
  private readonly assets: AssetManager;
  private readonly onChange: (ready: string[]) => void;
  private readonly ready = new Set<string>();
  private readonly failed = new Set<string>();
  private readonly queue: string[] = [];
  private building: string | null = null;

  constructor(assets: AssetManager, onChange: (ready: string[]) => void) {
    this.assets = assets;
    this.onChange = onChange;
  }

  get dir(): string {
    return join(neonHome(), 'proxies');
  }

  /** Asset ids whose proxy is on disk. */
  list(): string[] {
    return [...this.ready];
  }

  status(): { ready: string[]; pending: number } {
    return { ready: this.list(), pending: this.queue.length + (this.building ? 1 : 0) };
  }

  /** The proxy file for an asset, or null while it does not exist. */
  file(hash: string): string | null {
    return this.ready.has(hash) ? join(this.dir, `${hash}.mp4`) : null;
  }

  /** Make sure every video asset in the project has a proxy (cheap to call on every change). */
  sync(assets: Asset[]): void {
    for (const asset of assets) {
      if (!wantsProxy(asset) || this.ready.has(asset.id) || this.failed.has(asset.id) || this.building === asset.id || this.queue.includes(asset.id)) continue;
      this.queue.push(asset.id);
    }
    void this.drain();
  }

  private async drain(): Promise<void> {
    if (this.building) return;
    let changed = false;
    while (this.queue.length) {
      const hash = this.queue.shift()!;
      this.building = hash;
      try {
        if (await this.build(hash)) {
          this.ready.add(hash);
          changed = true;
          this.onChange(this.list());
        }
      } catch (err) {
        // A file ffmpeg cannot read stays on its original; do not retry it every change.
        this.failed.add(hash);
        console.warn(`[proxies] ${hash.slice(0, 12)}: ${(err as Error).message}`);
      } finally {
        this.building = null;
      }
    }
    if (changed) console.log(`[proxies] ${this.ready.size} ready`);
  }

  /** True when a proxy exists afterwards; false when it cannot be made yet (no ffmpeg or no file). */
  private async build(hash: string): Promise<boolean> {
    const out = join(this.dir, `${hash}.mp4`);
    if (await stat(out).then((s) => s.size > 0, () => false)) return true;
    const source = await this.assets.resolveFile(hash);
    const ffmpeg = await which('ffmpeg');
    if (!source || !ffmpeg) return false;
    await mkdir(this.dir, { recursive: true });
    const tmp = join(this.dir, `${hash}.${process.pid}.tmp.mp4`);
    try {
      await new Promise<void>((resolve, reject) => {
        const child = spawn(ffmpeg, proxyArgs(source, tmp), { stdio: ['ignore', 'ignore', 'pipe'] });
        let stderr = '';
        child.stderr.on('data', (d: Buffer) => (stderr = (stderr + d.toString()).slice(-2000)));
        child.on('error', reject);
        child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}: ${stderr.trim()}`))));
      });
      await rename(tmp, out);
      return true;
    } finally {
      await rm(tmp, { force: true });
    }
  }
}
