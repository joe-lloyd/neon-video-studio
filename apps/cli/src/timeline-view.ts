/**
 * `neon-cli timeline show`: the edit as compact text (or the same structure as JSON) so an agent can
 * see the timeline without reading the whole project document.
 */
import { formatDuration, framesToTimecode, speedOf, type Clip, type MediaClip, type Project, type TrackKind } from '@neon/core';
import { table } from './format.ts';

interface Span {
  start: number;
  end: number;
  duration: number;
  startTc: string;
  endTc: string;
}

/** A zoom region in timeline frames (the document stores source frames). */
export interface ZoomView {
  start: number;
  end: number;
  zoom: number;
  cx: number;
  cy: number;
}

interface ClipViewBase extends Span {
  type: 'clip';
  id: string;
  name: string;
  /** Short human notes: speed, zooms, fades, volume, placement, animation. */
  notes: string[];
}

export type ClipView =
  | (ClipViewBase & { kind: MediaClip['kind']; asset: string; assetId: string; trimBefore: number; speed: number; zooms: ZoomView[] })
  | (ClipViewBase & { kind: 'component'; component: string; props: Record<string, unknown> });

export type TimelineItem = ClipView | ({ type: 'gap' } & Span);

export interface TrackView {
  id: string;
  name: string;
  kind: TrackKind;
  muted: boolean;
  locked: boolean;
  hidden: boolean;
  items: TimelineItem[];
}

export interface TimelineView {
  name: string;
  fps: number;
  width: number;
  height: number;
  durationFrames: number;
  durationTc: string;
  tracks: TrackView[];
}

function span(start: number, end: number, fps: number): Span {
  return { start, end, duration: end - start, startTc: framesToTimecode(start, fps), endTc: framesToTimecode(end, fps) };
}

function zoomViews(clip: MediaClip): ZoomView[] {
  const end = clip.startFrame + clip.durationFrames;
  const toTimeline = (source: number) => Math.min(end, Math.max(clip.startFrame, clip.startFrame + Math.round((source - clip.trimBefore) / speedOf(clip))));
  return (clip.zooms ?? [])
    .map((z) => ({ start: toTimeline(z.start), end: toTimeline(z.end), zoom: z.zoom, cx: z.cx, cy: z.cy }))
    .filter((z) => z.end > z.start);
}

function commonNotes(clip: Clip): string[] {
  const notes: string[] = [];
  if (clip.transform) {
    const t = clip.transform;
    notes.push(`pos ${t.x},${t.y} ×${t.scale}${t.rotation ? ` ${t.rotation}°` : ''}`);
  }
  if (clip.animateIn) notes.push(`in ${clip.animateIn.type}:${clip.animateIn.durationFrames}`);
  if (clip.animateOut) notes.push(`out ${clip.animateOut.type}:${clip.animateOut.durationFrames}`);
  return notes;
}

function clipView(clip: Clip, project: Project): ClipView {
  const fps = project.meta.fps;
  const base = { type: 'clip' as const, id: clip.id, name: clip.name, ...span(clip.startFrame, clip.startFrame + clip.durationFrames, fps) };
  if (clip.kind === 'component') return { ...base, kind: 'component', component: clip.componentName, props: clip.props, notes: commonNotes(clip) };
  const zooms = zoomViews(clip);
  const speed = speedOf(clip);
  const notes: string[] = [];
  if (clip.trimBefore > 0) notes.push(`trim ${formatDuration(clip.trimBefore, fps)}`);
  if (speed !== 1) notes.push(`${speed}×`);
  for (const z of zooms) notes.push(`zoom ${z.zoom}× @${z.cx},${z.cy} ${framesToTimecode(z.start, fps)}–${framesToTimecode(z.end, fps)}`);
  if (clip.kind !== 'image' && clip.volume !== 1) notes.push(`vol ${clip.volume}`);
  if (clip.volumeKeyframes?.length) notes.push(`vol automation ${clip.volumeKeyframes.length}pt`);
  if (clip.fadeIn > 0) notes.push(`fade in ${clip.fadeIn}f`);
  if (clip.fadeOut > 0) notes.push(`fade out ${clip.fadeOut}f`);
  if (clip.reframe) notes.push(`reframe ${clip.reframe.mode}`);
  notes.push(...commonNotes(clip));
  const asset = project.assets.find((a) => a.id === clip.assetId);
  return { ...base, kind: clip.kind, asset: asset?.name ?? `missing ${clip.assetId.slice(0, 8)}`, assetId: clip.assetId, trimBefore: clip.trimBefore, speed, zooms, notes };
}

export function timelineView(project: Project, durationFrames: number): TimelineView {
  const fps = project.meta.fps;
  const tracks = [...project.tracks].sort((a, b) => a.order - b.order);
  return {
    name: project.meta.name,
    fps,
    width: project.meta.width,
    height: project.meta.height,
    durationFrames,
    durationTc: framesToTimecode(durationFrames, fps),
    tracks: tracks.map((track) => {
      const clips = project.clips.filter((c) => c.trackId === track.id).sort((a, b) => a.startFrame - b.startFrame);
      const items: TimelineItem[] = [];
      let cursor = 0;
      for (const clip of clips) {
        if (clip.startFrame > cursor) items.push({ type: 'gap', ...span(cursor, clip.startFrame, fps) });
        items.push(clipView(clip, project));
        cursor = Math.max(cursor, clip.startFrame + clip.durationFrames);
      }
      return { id: track.id, name: track.name, kind: track.kind, muted: track.muted, locked: track.locked, hidden: track.hidden, items };
    }),
  };
}

function shortJson(value: unknown, max = 48): string {
  const s = JSON.stringify(value);
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

const count = (n: number, noun: string) => `${n} ${noun}${n === 1 ? '' : 's'}`;

export function formatTimeline(view: TimelineView): string {
  const clips = view.tracks.reduce((n, t) => n + t.items.filter((i) => i.type === 'clip').length, 0);
  const lines = [`“${view.name}” ${view.width}×${view.height} @ ${view.fps}fps · ${view.durationTc} (${formatDuration(view.durationFrames, view.fps)}) · ${count(view.tracks.length, 'track')} · ${count(clips, 'clip')}`];
  for (const track of view.tracks) {
    const flags = [track.muted && 'muted', track.locked && 'locked', track.hidden && 'hidden'].filter(Boolean).join(' ');
    lines.push('', `${track.name} · ${track.kind}${flags ? ` · ${flags}` : ''} · ${track.id}`);
    if (track.items.length === 0) {
      lines.push('  (empty)');
      continue;
    }
    const rows = track.items.map((item) => {
      const range = `${item.startTc}–${item.endTc}`;
      const dur = `(${formatDuration(item.duration, view.fps)})`;
      if (item.type === 'gap') return [range, dur, '· gap', '', '', ''];
      const source = item.kind === 'component' ? `[${item.component} ${shortJson(item.props)}]` : `[${item.kind} ${item.asset}]`;
      return [range, dur, item.name, source, item.notes.join(' · '), item.id];
    });
    lines.push(table(rows).replace(/^/gm, '  '));
  }
  return lines.join('\n');
}
