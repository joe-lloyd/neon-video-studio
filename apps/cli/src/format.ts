import { framesToTimecode, type Clip, type Track } from '@neon/core';

export function table(rows: string[][], header?: string[]): string {
  const all = header ? [header, ...rows] : rows;
  if (all.length === 0) return '';
  const widths = all[0]!.map((_, i) => Math.max(...all.map((r) => (r[i] ?? '').length)));
  const line = (r: string[]) => r.map((c, i) => (c ?? '').padEnd(widths[i]!)).join('  ').trimEnd();
  const out = all.map(line);
  if (header) out.splice(1, 0, widths.map((w) => '─'.repeat(w)).join('  '));
  return out.join('\n');
}

export function clipRow(clip: Clip, fps: number, tracks: Track[]): string[] {
  const track = tracks.find((t) => t.id === clip.trackId);
  const detail = clip.kind === 'component' ? clip.componentName : `${clip.assetId.slice(0, 8)}… trim ${clip.trimBefore}f`;
  return [
    clip.id,
    track?.name ?? clip.trackId,
    clip.kind,
    clip.name,
    framesToTimecode(clip.startFrame, fps),
    framesToTimecode(clip.startFrame + clip.durationFrames, fps),
    `${clip.durationFrames}f`,
    detail,
  ];
}

export function progressBar(progress: number, width = 30): string {
  const filled = Math.round(Math.max(0, Math.min(1, progress)) * width);
  return `[${'█'.repeat(filled)}${'░'.repeat(width - filled)}] ${(progress * 100).toFixed(1).padStart(5)}%`;
}
