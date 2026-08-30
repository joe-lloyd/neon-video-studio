import { runOrThrow } from './exec.ts';

export interface MediaInfo {
  durationSeconds: number;
  width?: number;
  height?: number;
  fps?: number;
  hasVideo: boolean;
  hasAudio: boolean;
}

export async function probe(ffprobe: string, file: string): Promise<MediaInfo> {
  const r = await runOrThrow(ffprobe, ['-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', file]);
  const data = JSON.parse(r.stdout) as {
    streams?: { codec_type?: string; width?: number; height?: number; avg_frame_rate?: string; r_frame_rate?: string }[];
    format?: { duration?: string };
  };
  const video = data.streams?.find((s) => s.codec_type === 'video');
  const audio = data.streams?.find((s) => s.codec_type === 'audio');
  const rate = video?.avg_frame_rate && video.avg_frame_rate !== '0/0' ? video.avg_frame_rate : video?.r_frame_rate;
  let fps: number | undefined;
  if (rate) {
    const [n, d] = rate.split('/').map(Number);
    if (n && d) fps = n / d;
  }
  return {
    durationSeconds: Number(data.format?.duration ?? 0),
    width: video?.width,
    height: video?.height,
    fps,
    hasVideo: Boolean(video),
    hasAudio: Boolean(audio),
  };
}
