/** Download a video/audio from a URL (YouTube etc.) via yt-dlp, ready for import as an asset. */
import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { run } from './exec.ts';

export interface RipOptions {
  ytdlp: string;
  ffmpeg: string;
  /** Max height as string, 'best', or 'audio'. */
  quality: string;
  outDir: string;
  onProgress?: (p: number, message?: string) => void;
  onLog?: (line: string) => void;
}

export function ripFormatArgs(quality: string): string[] {
  if (quality === 'audio') return ['-f', 'ba/b', '-x', '--audio-format', 'm4a', '--audio-quality', '0'];
  const sort = quality === 'best' ? 'res,ext:mp4:m4a' : `res:${quality},ext:mp4:m4a`;
  // Prefer mp4/m4a streams (WKWebView preview + Remotion both like them); merge into mp4.
  return ['-f', 'bv*+ba/b', '-S', sort, '--merge-output-format', 'mp4'];
}

export interface RipResult {
  file: string;
  title: string;
}

export async function ripUrl(url: string, opts: RipOptions): Promise<RipResult> {
  const args = [
    ...ripFormatArgs(opts.quality),
    '--no-playlist',
    '--newline',
    '--restrict-filenames',
    '--ffmpeg-location', opts.ffmpeg,
    '-o', join(opts.outDir, '%(title).70s [%(id)s].%(ext)s'),
    url,
  ];
  const r = await run(opts.ytdlp, args, {
    onStdout: (line) => {
      const m = /\[download\]\s+([\d.]+)%/.exec(line);
      if (m) opts.onProgress?.(Math.min(0.98, Number(m[1]) / 100));
      else if (/\[(Merger|ExtractAudio|download)\]/.test(line)) opts.onLog?.(line.trim());
      if (/\[download\] Destination:/.test(line)) opts.onLog?.(line.trim());
    },
    onStderr: (line) => {
      if (/ERROR/i.test(line)) opts.onLog?.(line.trim());
    },
  });
  if (r.code !== 0) {
    const err = (r.stderr + r.stdout).split('\n').reverse().find((l) => /ERROR/i.test(l)) ?? `yt-dlp exited with ${r.code}`;
    throw new Error(err.replace(/^ERROR:\s*/i, ''));
  }
  // Locate the finished media file (yt-dlp cleans up its .part/.fXX intermediates on success).
  const entries = await readdir(opts.outDir);
  const media = entries.filter((f) => /\.(mp4|m4a|webm|mkv|mp3|wav)$/i.test(f) && !f.endsWith('.part'));
  if (media.length === 0) throw new Error('yt-dlp finished but produced no media file');
  let newest = media[0]!;
  let newestM = 0;
  for (const f of media) {
    const s = await stat(join(opts.outDir, f));
    if (s.mtimeMs > newestM) {
      newestM = s.mtimeMs;
      newest = f;
    }
  }
  return { file: join(opts.outDir, newest), title: newest.replace(/\s*\[[^\]]+\]\.[a-z0-9]+$/i, '') };
}
