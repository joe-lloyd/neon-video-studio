import type { MediaClip, Project } from '@neon/core';

/** Process each source once, but replace only the explicitly selected clips using it. */
export function audioClipGroups(project: Project, ids: unknown): MediaClip[][] {
  if (!Array.isArray(ids) || !ids.length || ids.some(id => typeof id !== 'string')) {
    throw new Error('Specify a non-empty array of clip IDs');
  }
  const clips = new Map(project.clips.map(c => [c.id, c]));
  const groups = new Map<string, MediaClip[]>();
  for (const id of new Set(ids as string[])) {
    const clip = clips.get(id);
    if (!clip) throw new Error(`Clip ${id} not found`);
    if (clip.kind !== 'audio' && clip.kind !== 'video') throw new Error('Select audio or video clips for voice processing');
    if (!project.assets.some(a => a.id === clip.assetId)) throw new Error(`Asset for ${clip.name} not found`);
    const group = groups.get(clip.assetId) ?? [];
    group.push(clip);
    groups.set(clip.assetId, group);
  }
  return [...groups.values()];
}
