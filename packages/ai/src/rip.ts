/** Download a video/audio from a URL (YouTube etc.) via yt-dlp, ready for import as an asset. */
import { readdir, rename, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { run } from './exec.ts';

export interface RipOptions {
  ytdlp: string;
  ffmpeg: string;
  ffprobe?: string;
  /** Max height as string, 'best', or 'audio'. */
  quality: string;
  outDir: string;
  onProgress?: (p: number, message?: string) => void;
  onLog?: (line: string) => void;
}

export function ripFormatArgs(quality: string): string[] {
  if (quality === 'audio') return ['-f', 'ba/b', '-x', '--audio-format', 'm4a', '--audio-quality', '0'];
  // codec:avc:m4a — WKWebView can't decode AV1/VP9, so prefer H.264 + AAC over higher-efficiency codecs.
  const sort = quality === 'best' ? 'res,codec:avc:m4a,ext:mp4:m4a' : `res:${quality},codec:avc:m4a,ext:mp4:m4a`;
  return ['-f', 'bv*+ba/b', '-S', sort, '--merge-output-format', 'mp4'];
}

/** Codecs the preview (WKWebView/Safari) can decode; everything else gets re-encoded. */
const PREVIEW_SAFE_VCODECS = /^(h264|hevc|mpeg4|mjpeg|prores)$/;

/** Re-encode to H.264/AAC when the site only offered AV1/VP9 (the -S preference had nothing avc to pick). */
async function ensurePreviewCodec(file: string, opts: RipOptions): Promise<string> {
  if (!/\.(mp4|mkv|webm)$/i.test(file)) return file;
  const probe = await run(opts.ffprobe ?? 'ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=codec_name', '-of', 'csv=p=0', file]);
  const vcodec = (probe.stdout.trim().split('\n')[0] ?? '').trim();
  if (probe.code !== 0 || vcodec === '' || PREVIEW_SAFE_VCODECS.test(vcodec)) return file;
  opts.onLog?.(`Video is ${vcodec} — converting to H.264 for preview compatibility`);
  opts.onProgress?.(0.99, 'Converting for preview…');
  const tmp = file.replace(/\.[a-z0-9]+$/i, '.compat.mp4');
  const r = await run(opts.ffmpeg, ['-y', '-i', file, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', tmp]);
  if (r.code !== 0) {
    opts.onLog?.('Conversion failed — keeping the original file (export still works, preview may not play it)');
    return file;
  }
  const final = file.replace(/\.[a-z0-9]+$/i, '.mp4');
  await rename(tmp, final);
  return final;
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
  const title = newest.replace(/\s*\[[^\]]+\]\.[a-z0-9]+$/i, '');
  const file = await ensurePreviewCodec(join(opts.outDir, newest), opts);
  return { file, title };
}
