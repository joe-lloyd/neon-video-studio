/**
 * Domain model for a Neon Video Studio project.
 *
 * All time values are integer frame counts at the project's fps. The project is the single
 * source of truth for both the live preview (@remotion/player) and the export (@remotion/renderer):
 * the Remotion composition receives the JSON form of this model as input props.
 */

export type TrackKind = 'video' | 'audio' | 'overlay';
export type ClipKind = 'video' | 'audio' | 'image' | 'component';
export type AssetKind = 'video' | 'audio' | 'image';

export interface ProjectMeta {
  id: string;
  name: string;
  fps: number;
  width: number;
  height: number;
  /** Background colour of the composition (CSS colour). */
  background: string;
  createdAt: string;
  updatedAt: string;
  /** Schema version of the document layout, for future migrations. */
  schemaVersion: number;
}

export interface Track {
  id: string;
  name: string;
  kind: TrackKind;
  /** Lower order renders first (bottom of the stack). Overlays should have the highest order. */
  order: number;
  muted: boolean;
  locked: boolean;
  hidden: boolean;
}

export interface ClipBase {
  id: string;
  trackId: string;
  name: string;
  /** Timeline position (frames). */
  startFrame: number;
  /** Length on the timeline (frames). */
  durationFrames: number;
  /** Free-form label colour override (CSS colour) for the timeline UI. */
  color?: string;
}

/** Volume automation point. `frame` is clip-local (0 = clip start), `gain` a linear multiplier (1 = unity). */
export interface VolumeKeyframe {
  frame: number;
  gain: number;
}

/** Auto-reframe data: where the subject is over time, in normalised source coordinates (0..1). */
export interface Reframe {
  mode: 'face-track' | 'center';
  /** Output aspect ratio this was computed for (width / height), informational. */
  targetAspect: number;
  keyframes: { frame: number; cx: number; cy: number; zoom: number }[];
}

export interface MediaClip extends ClipBase {
  kind: 'video' | 'audio' | 'image';
  /** SHA-256 of the source file; key into Project.assets. */
  assetId: string;
  /** Offset into the source media where playback starts (frames). */
  trimBefore: number;
  /** 0..1 volume multiplier (video/audio). */
  volume: number;
  /** CSS object-fit for visual clips. */
  fit: 'cover' | 'contain' | 'fill';
  /** Fade in/out lengths (frames) applied to opacity and volume. */
  fadeIn: number;
  fadeOut: number;
  /** Optional volume automation (e.g. breath attenuation), linearly interpolated. */
  volumeKeyframes?: VolumeKeyframe[];
  /** Optional subject tracking used to pan/crop when the output aspect differs from the source. */
  reframe?: Reframe;
}

export interface ComponentClip extends ClipBase {
  kind: 'component';
  /** Name of a registered React template (see templates.ts). */
  componentName: string;
  props: Record<string, unknown>;
}

export type Clip = MediaClip | ComponentClip;

export interface Asset {
  /** SHA-256 hex digest of the file content — content-addressed, identical across peers. */
  id: string;
  name: string;
  kind: AssetKind;
  mime: string;
  size: number;
  /** Intrinsic media info when known. */
  durationFrames?: number;
  width?: number;
  height?: number;
  fps?: number;
  /** Peer id of the node that first imported it (informational). */
  importedBy?: string;
  importedAt: string;
  /** Asset id this one was derived from (denoise, matte, …). */
  derivedFrom?: string;
  /** Processing steps applied to produce this asset, e.g. ["denoise:rnnoise"]. */
  processing?: string[];
  /** Video carries an alpha channel (ProRes 4444 matte). */
  hasAlpha?: boolean;
}

export interface TranscriptWord {
  /** Word text as spoken (punctuation attached). */
  w: string;
  /** Start / end in source seconds. */
  s: number;
  e: number;
  /** Engine confidence 0..1 when available. */
  p?: number;
  /** Marked as a disfluency ("um", "uh", "like", …). */
  filler?: boolean;
}

export interface Transcript {
  assetId: string;
  engine: string;
  language: string;
  createdAt: string;
  words: TranscriptWord[];
}

export interface Project {
  meta: ProjectMeta;
  tracks: Track[];
  clips: Clip[];
  assets: Asset[];
  transcripts: Transcript[];
}

/** Half-open frame range on the timeline [start, end). */
export interface FrameRange {
  start: number;
  end: number;
}

export const PROJECT_SCHEMA_VERSION = 1;

export const DEFAULT_PROJECT_META: Omit<ProjectMeta, 'id' | 'createdAt' | 'updatedAt'> = {
  name: 'Untitled Project',
  fps: 30,
  width: 1920,
  height: 1080,
  background: '#09090B',
  schemaVersion: PROJECT_SCHEMA_VERSION,
};

/** Frame count of the whole project = end of the last clip. */
export function projectDurationFrames(project: Pick<Project, 'clips'>): number {
  let end = 0;
  for (const clip of project.clips) end = Math.max(end, clip.startFrame + clip.durationFrames);
  return end;
}

export function isMediaClip(clip: Clip): clip is MediaClip {
  return clip.kind !== 'component';
}

export function isComponentClip(clip: Clip): clip is ComponentClip {
  return clip.kind === 'component';
}

export function trackKindForClip(kind: ClipKind): TrackKind {
  switch (kind) {
    case 'video':
      return 'video';
    case 'audio':
      return 'audio';
    case 'image':
    case 'component':
      return 'overlay';
  }
}
