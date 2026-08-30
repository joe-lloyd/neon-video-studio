/** Export presets. Codec is always H.264 in an MP4 container for maximum compatibility. */
export interface RenderPreset {
  id: string;
  label: string;
  width: number;
  height: number;
  fps: number;
  /** Constant rate factor for x264 (lower = better quality, bigger file). */
  crf: number;
  description: string;
}

export const RENDER_PRESETS: readonly RenderPreset[] = [
  { id: '1080p30', label: '1080p · 30 fps', width: 1920, height: 1080, fps: 30, crf: 18, description: 'Full HD, standard frame rate' },
  { id: '1080p60', label: '1080p · 60 fps', width: 1920, height: 1080, fps: 60, crf: 18, description: 'Full HD, smooth motion' },
  { id: '720p30', label: '720p · 30 fps', width: 1280, height: 720, fps: 30, crf: 20, description: 'HD, small file' },
  { id: '4k30', label: '2160p · 30 fps', width: 3840, height: 2160, fps: 30, crf: 17, description: 'Ultra HD' },
  { id: 'vertical1080p30', label: '1080×1920 · 30 fps', width: 1080, height: 1920, fps: 30, crf: 18, description: 'Vertical (Shorts/Reels/TikTok)' },
  { id: 'square1080p30', label: '1080×1080 · 30 fps', width: 1080, height: 1080, fps: 30, crf: 18, description: 'Square (feeds)' },
  { id: 'draft', label: 'Draft 540p · 30 fps', width: 960, height: 540, fps: 30, crf: 28, description: 'Fast preview render' },
];

export function getPreset(id: string): RenderPreset {
  const preset = RENDER_PRESETS.find((p) => p.id === id);
  if (!preset) {
    throw new Error(`Unknown preset "${id}". Available: ${RENDER_PRESETS.map((p) => p.id).join(', ')}`);
  }
  return preset;
}

/** A preset derived from the project's own dimensions and fps ("as authored"). */
export function projectPreset(meta: { width: number; height: number; fps: number }): RenderPreset {
  return {
    id: 'project',
    label: `${meta.width}×${meta.height} · ${meta.fps} fps`,
    width: meta.width,
    height: meta.height,
    fps: meta.fps,
    crf: 18,
    description: 'Project settings',
  };
}
