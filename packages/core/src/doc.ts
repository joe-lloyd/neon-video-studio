import * as Y from 'yjs';
import { newId } from './ids.ts';
import { clipEnd, mergeRanges, planRippleInsert, resolveFreePosition, sortClips, sortTracks, trackEnd } from './ops.ts';
import { getTemplate, resolveTemplateProps } from './templates.ts';
import {
  DEFAULT_PROJECT_META,
  PROJECT_SCHEMA_VERSION,
  trackKindForClip,
  type Asset,
  type Clip,
  type ClipKind,
  type ComponentClip,
  type FrameRange,
  type MediaClip,
  type Project,
  type ProjectMeta,
  type Track,
  type TrackKind,
  type Transcript,
} from './types.ts';

/** Transaction origins. The UI's UndoManager only tracks ORIGIN_LOCAL. */
export const ORIGIN_LOCAL = 'neon:local';
export const ORIGIN_API = 'neon:api';
export const ORIGIN_SYSTEM = 'neon:system';

type YMap = Y.Map<unknown>;

export interface InsertClipInput {
  kind: ClipKind;
  trackId?: string;
  startFrame?: number;
  durationFrames?: number;
  name?: string;
  // media
  assetId?: string;
  trimBefore?: number;
  volume?: number;
  // component
  componentName?: string;
  props?: Record<string, unknown>;
  /**
   * ripple  – insert edit: later clips on the track move right (default for media with a startFrame)
   * free    – find the nearest free slot (default without a startFrame; used by drag & drop)
   * overlap – place exactly, even if it overlaps (default for overlay tracks with a startFrame)
   */
  placement?: 'ripple' | 'free' | 'overlap';
}

export type ClipPatch = Partial<Omit<MediaClip, 'id' | 'kind' | 'assetId' | 'volumeKeyframes' | 'reframe'>> &
  Partial<Pick<ComponentClip, 'props'>> & {
    volumeKeyframes?: MediaClip['volumeKeyframes'] | null;
    reframe?: MediaClip['reframe'] | null;
  };

const TRACK_PREFIX: Record<TrackKind, string> = { video: 'V', audio: 'A', overlay: 'FX' };

/**
 * Typed façade over the Yjs document that stores a project.
 *
 * Layout (all top-level shared types so partial updates merge per field):
 *   meta   : Y.Map<scalar>
 *   tracks : Y.Map<trackId, Y.Map<scalar>>
 *   clips  : Y.Map<clipId,  Y.Map<scalar | Y.Map(props)>>
 *   assets : Y.Map<sha256,  Y.Map<scalar>>
 */
export class ProjectDoc {
  readonly doc: Y.Doc;
  readonly meta: YMap;
  readonly tracks: Y.Map<YMap>;
  readonly clips: Y.Map<YMap>;
  readonly assets: Y.Map<YMap>;
  readonly transcripts: Y.Map<YMap>;

  private snapshot: Project | null = null;
  private txDepth = 0;
  private readonly listeners = new Set<(project: Project) => void>();

  constructor(doc: Y.Doc = new Y.Doc()) {
    this.doc = doc;
    this.meta = doc.getMap('meta');
    this.tracks = doc.getMap('tracks');
    this.clips = doc.getMap('clips');
    this.assets = doc.getMap('assets');
    this.transcripts = doc.getMap('transcripts');
    doc.on('update', () => {
      this.snapshot = null;
      if (this.listeners.size === 0) return;
      const project = this.toJSON();
      for (const listener of this.listeners) listener(project);
    });
  }

  // ---- lifecycle -----------------------------------------------------------------------

  get isInitialized(): boolean {
    return typeof this.meta.get('id') === 'string';
  }

  /** Create meta + default tracks in an empty document. No-op if already initialised. */
  ensureInitialized(overrides: Partial<ProjectMeta> = {}): void {
    if (this.isInitialized) return;
    const now = new Date().toISOString();
    this.transact(() => {
      const meta: ProjectMeta = {
        ...DEFAULT_PROJECT_META,
        id: newId('proj'),
        createdAt: now,
        updatedAt: now,
        ...overrides,
      };
      for (const [k, v] of Object.entries(meta)) this.meta.set(k, v);
      this.createTrack('video', 'V1', 0);
      this.createTrack('audio', 'A1', 1);
      this.createTrack('overlay', 'FX1', 2);
    }, ORIGIN_SYSTEM);
  }

  /** Replace the entire content with `project` (used when opening a legacy JSON file). */
  load(project: Project): void {
    this.transact(() => {
      for (const key of [...this.meta.keys()]) this.meta.delete(key);
      for (const key of [...this.tracks.keys()]) this.tracks.delete(key);
      for (const key of [...this.clips.keys()]) this.clips.delete(key);
      for (const key of [...this.assets.keys()]) this.assets.delete(key);
      for (const key of [...this.transcripts.keys()]) this.transcripts.delete(key);
      for (const [k, v] of Object.entries(project.meta)) this.meta.set(k, v);
      for (const track of project.tracks) this.tracks.set(track.id, mapFrom(track));
      for (const asset of project.assets) this.assets.set(asset.id, mapFrom(asset));
      for (const clip of project.clips) this.clips.set(clip.id, clipToMap(clip));
      for (const t of project.transcripts ?? []) this.transcripts.set(t.assetId, mapFrom(t));
    }, ORIGIN_SYSTEM);
  }

  static fromJSON(project: Project, doc?: Y.Doc): ProjectDoc {
    const pd = new ProjectDoc(doc);
    pd.load(project);
    return pd;
  }

  /** Full Yjs state as an update (for persistence / transfer). */
  encodeState(): Uint8Array {
    return Y.encodeStateAsUpdate(this.doc);
  }

  applyUpdate(update: Uint8Array, origin: unknown = ORIGIN_SYSTEM): void {
    Y.applyUpdate(this.doc, update, origin);
  }

  subscribe(listener: (project: Project) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  transact<T>(fn: () => T, origin: unknown = ORIGIN_LOCAL): T {
    let result!: T;
    this.txDepth++;
    this.snapshot = null;
    try {
      this.doc.transact(() => {
        result = fn();
      }, origin);
    } finally {
      this.txDepth--;
      this.snapshot = null;
    }
    return result;
  }

  // ---- reads ---------------------------------------------------------------------------

  toJSON(): Project {
    // Inside a transaction the shared types are ahead of any cached snapshot, so always rebuild.
    if (this.snapshot && this.txDepth === 0) return this.snapshot;
    const meta = { ...DEFAULT_PROJECT_META, id: '', createdAt: '', updatedAt: '', ...(this.meta.toJSON() as Partial<ProjectMeta>) } as ProjectMeta;
    const tracks = sortTracks([...this.tracks.values()].map((m) => m.toJSON() as Track));
    const clips = sortClips([...this.clips.values()].map((m) => mapToClip(m)));
    const assets = [...this.assets.values()]
      .map((m) => m.toJSON() as Asset)
      .sort((a, b) => a.importedAt.localeCompare(b.importedAt) || a.name.localeCompare(b.name));
    const transcripts = [...this.transcripts.values()].map((m) => m.toJSON() as Transcript);
    const project: Project = { meta, tracks, clips, assets, transcripts };
    if (this.txDepth === 0) this.snapshot = project;
    return project;
  }

  getMeta(): ProjectMeta {
    return this.toJSON().meta;
  }

  get fps(): number {
    return Number(this.meta.get('fps') ?? DEFAULT_PROJECT_META.fps);
  }

  getTrack(id: string): Track | undefined {
    const m = this.tracks.get(id);
    return m ? (m.toJSON() as Track) : undefined;
  }

  getClip(id: string): Clip | undefined {
    const m = this.clips.get(id);
    return m ? mapToClip(m) : undefined;
  }

  getAsset(id: string): Asset | undefined {
    const m = this.assets.get(id);
    return m ? (m.toJSON() as Asset) : undefined;
  }

  clipsOnTrack(trackId: string): Clip[] {
    return this.toJSON().clips.filter((c) => c.trackId === trackId);
  }

  durationFrames(): number {
    return trackEnd(this.toJSON().clips);
  }

  // ---- meta ----------------------------------------------------------------------------

  updateMeta(patch: Partial<Omit<ProjectMeta, 'id' | 'createdAt' | 'schemaVersion'>>, origin?: unknown): void {
    this.transact(() => {
      for (const [k, v] of Object.entries(patch)) if (v !== undefined) this.meta.set(k, v);
      this.touch();
    }, origin);
  }

  private touch(): void {
    this.meta.set('updatedAt', new Date().toISOString());
    if (this.meta.get('schemaVersion') === undefined) this.meta.set('schemaVersion', PROJECT_SCHEMA_VERSION);
  }

  // ---- tracks --------------------------------------------------------------------------

  private createTrack(kind: TrackKind, name: string, order: number): Track {
    const track: Track = { id: newId('trk'), name, kind, order, muted: false, locked: false, hidden: false };
    this.tracks.set(track.id, mapFrom(track));
    return track;
  }

  addTrack(kind: TrackKind, name?: string, origin?: unknown): Track {
    return this.transact(() => {
      const existing = this.toJSON().tracks;
      const sameKind = existing.filter((t) => t.kind === kind).length;
      const order = existing.length === 0 ? 0 : Math.max(...existing.map((t) => t.order)) + 1;
      const track = this.createTrack(kind, name ?? `${TRACK_PREFIX[kind]}${sameKind + 1}`, order);
      this.touch();
      return track;
    }, origin);
  }

  updateTrack(id: string, patch: Partial<Omit<Track, 'id' | 'kind'>>, origin?: unknown): void {
    const m = this.tracks.get(id);
    if (!m) throw new Error(`Track ${id} not found`);
    this.transact(() => {
      for (const [k, v] of Object.entries(patch)) if (v !== undefined) m.set(k, v);
      this.touch();
    }, origin);
  }

  removeTrack(id: string, origin?: unknown): void {
    if (!this.tracks.has(id)) throw new Error(`Track ${id} not found`);
    this.transact(() => {
      for (const clip of this.clipsOnTrack(id)) this.clips.delete(clip.id);
      this.tracks.delete(id);
      this.touch();
    }, origin);
  }

  /** Track of the given kind with the lowest order, creating one if none exists. */
  ensureTrack(kind: TrackKind): Track {
    const found = sortTracks(this.toJSON().tracks).find((t) => t.kind === kind);
    return found ?? this.addTrack(kind, undefined, ORIGIN_SYSTEM);
  }

  // ---- clips ---------------------------------------------------------------------------

  insertClip(input: InsertClipInput, origin?: unknown): Clip {
    return this.transact(() => {
      const fps = this.fps;
      const trackKind = trackKindForClip(input.kind);
      let track: Track;
      if (input.trackId) {
        const t = this.getTrack(input.trackId);
        if (!t) throw new Error(`Track ${input.trackId} not found`);
        if (t.kind !== trackKind) {
          throw new Error(`Cannot place a ${input.kind} clip on ${t.kind} track "${t.name}"`);
        }
        track = t;
      } else {
        track = this.ensureTrack(trackKind);
      }
      if (track.locked) throw new Error(`Track "${track.name}" is locked`);

      const others = this.clipsOnTrack(track.id);
      const id = newId('clip');
      let clip: Clip;

      if (input.kind === 'component') {
        if (!input.componentName) throw new Error('componentName is required for component clips');
        const template = getTemplate(input.componentName);
        const props = resolveTemplateProps(input.componentName, input.props);
        const durationFrames = Math.max(1, Math.round(input.durationFrames ?? template.defaultDurationSeconds * fps));
        clip = {
          id,
          kind: 'component',
          trackId: track.id,
          name: input.name ?? template.label,
          startFrame: 0,
          durationFrames,
          componentName: input.componentName,
          props,
        };
      } else {
        if (!input.assetId) throw new Error('assetId is required for media clips');
        const asset = this.getAsset(input.assetId);
        if (!asset) throw new Error(`Asset ${input.assetId} not found in project`);
        const trimBefore = Math.max(0, Math.round(input.trimBefore ?? 0));
        const intrinsic = asset.durationFrames ? Math.max(1, asset.durationFrames - trimBefore) : undefined;
        const fallback = asset.kind === 'image' ? 5 * fps : intrinsic ?? 5 * fps;
        const durationFrames = Math.max(1, Math.round(input.durationFrames ?? fallback));
        clip = {
          id,
          kind: input.kind,
          trackId: track.id,
          name: input.name ?? asset.name,
          startFrame: 0,
          durationFrames,
          assetId: asset.id,
          trimBefore,
          volume: input.volume ?? 1,
          fit: 'contain',
          fadeIn: 0,
          fadeOut: 0,
        };
      }

      // Defaults: append → nearest free slot; explicit time on a media track → insert edit (ripple);
      // explicit time on an overlay track → exact placement (overlays commonly stack).
      const placement = input.placement ?? (input.startFrame === undefined ? 'free' : trackKind === 'overlay' ? 'overlap' : 'ripple');
      const desired = Math.max(0, Math.round(input.startFrame ?? trackEnd(others)));

      if (placement === 'ripple') {
        const plan = planRippleInsert(others, desired, clip.durationFrames);
        if (plan.split) this.splitClipInternal(plan.split.id, plan.split.at);
        // Recompute after the split so the right half is included in the shift set.
        const after = this.clipsOnTrack(track.id);
        for (const c of after) {
          if (c.startFrame >= desired) this.clips.get(c.id)!.set('startFrame', c.startFrame + clip.durationFrames);
        }
        clip.startFrame = desired;
      } else if (placement === 'free') {
        clip.startFrame = resolveFreePosition(others, desired, clip.durationFrames).startFrame;
      } else {
        clip.startFrame = desired;
      }

      this.clips.set(clip.id, clipToMap(clip));
      this.touch();
      return clip;
    }, origin);
  }

  updateClip(id: string, patch: ClipPatch, origin?: unknown): Clip {
    const m = this.clips.get(id);
    if (!m) throw new Error(`Clip ${id} not found`);
    return this.transact(() => {
      const { props, ...scalars } = patch;
      for (const [k, v] of Object.entries(scalars)) {
        if (v === undefined) continue;
        if (v === null) {
          m.delete(k);
          continue;
        }
        if (k === 'trackId') {
          const t = this.getTrack(v as string);
          if (!t) throw new Error(`Track ${String(v)} not found`);
          const kind = m.get('kind') as ClipKind;
          if (t.kind !== trackKindForClip(kind)) throw new Error(`Cannot move ${kind} clip to ${t.kind} track`);
        }
        if ((k === 'durationFrames' && (v as number) < 1) || (k === 'startFrame' && (v as number) < 0)) {
          throw new Error(`Invalid ${k}: ${String(v)}`);
        }
        m.set(k, v);
      }
      if (props) {
        if (m.get('kind') !== 'component') throw new Error('props can only be set on component clips');
        const validated = resolveTemplateProps(m.get('componentName') as string, {
          ...((m.get('props') as YMap).toJSON() as Record<string, unknown>),
          ...props,
        });
        const target = m.get('props') as YMap;
        for (const [k, v] of Object.entries(validated)) target.set(k, v);
      }
      this.touch();
      return mapToClip(m);
    }, origin);
  }

  /** Move a clip (optionally to another track), resolving collisions to the nearest free slot. */
  moveClip(id: string, startFrame: number, trackId?: string, origin?: unknown): Clip {
    const clip = this.getClip(id);
    if (!clip) throw new Error(`Clip ${id} not found`);
    return this.transact(() => {
      const targetTrackId = trackId ?? clip.trackId;
      const others = this.clipsOnTrack(targetTrackId).filter((c) => c.id !== id);
      const { startFrame: resolved } = resolveFreePosition(others, startFrame, clip.durationFrames);
      return this.updateClip(id, { startFrame: resolved, trackId: targetTrackId }, origin);
    }, origin);
  }

  /** Change the length of a clip from either edge. Returns the updated clip. */
  trimClip(id: string, edge: 'start' | 'end', newFrame: number, origin?: unknown): Clip {
    const clip = this.getClip(id);
    if (!clip) throw new Error(`Clip ${id} not found`);
    return this.transact(() => {
      if (edge === 'end') {
        const durationFrames = Math.max(1, Math.round(newFrame) - clip.startFrame);
        return this.updateClip(id, { durationFrames }, origin);
      }
      const end = clipEnd(clip);
      const start = Math.min(Math.max(0, Math.round(newFrame)), end - 1);
      const delta = start - clip.startFrame;
      const patch: ClipPatch = { startFrame: start, durationFrames: end - start };
      if (clip.kind !== 'component') patch.trimBefore = Math.max(0, clip.trimBefore + delta);
      return this.updateClip(id, patch, origin);
    }, origin);
  }

  splitClip(id: string, atFrame: number, origin?: unknown): [Clip, Clip] {
    return this.transact(() => this.splitClipInternal(id, atFrame), origin);
  }

  private splitClipInternal(id: string, atFrame: number): [Clip, Clip] {
    const clip = this.getClip(id);
    if (!clip) throw new Error(`Clip ${id} not found`);
    const at = Math.round(atFrame);
    if (at <= clip.startFrame || at >= clipEnd(clip)) {
      throw new Error(`Split point ${at} is outside clip ${id} (${clip.startFrame}–${clipEnd(clip)})`);
    }
    const leftDuration = at - clip.startFrame;
    const right: Clip =
      clip.kind === 'component'
        ? { ...clip, id: newId('clip'), startFrame: at, durationFrames: clip.durationFrames - leftDuration, props: { ...clip.props } }
        : {
            ...clip,
            id: newId('clip'),
            startFrame: at,
            durationFrames: clip.durationFrames - leftDuration,
            trimBefore: clip.trimBefore + leftDuration,
            fadeIn: 0,
          };
    const left = this.clips.get(id)!;
    left.set('durationFrames', leftDuration);
    if (clip.kind !== 'component') left.set('fadeOut', 0);
    this.clips.set(right.id, clipToMap(right));
    this.touch();
    return [mapToClip(left), right];
  }

  removeClips(ids: string[], origin?: unknown): void {
    this.transact(() => {
      for (const id of ids) {
        if (!this.clips.has(id)) throw new Error(`Clip ${id} not found`);
        this.clips.delete(id);
      }
      this.touch();
    }, origin);
  }

  /**
   * Remove timeline ranges (e.g. filler words, dead air). Clips spanning a range are split, the
   * middle is deleted and — with `ripple` — everything after the range shifts left, keeping all
   * tracks in sync. Short fades on the joined edges act as audio crossfades.
   */
  cutRanges(
    ranges: FrameRange[],
    opts: { trackIds?: string[]; ripple?: boolean; crossfadeFrames?: number } = {},
    origin?: unknown,
  ): { removedFrames: number; cuts: number } {
    const ripple = opts.ripple ?? true;
    const xf = Math.max(0, Math.round(opts.crossfadeFrames ?? 2));
    const merged = mergeRanges(ranges);
    if (merged.length === 0) return { removedFrames: 0, cuts: 0 };
    return this.transact(() => {
      const trackIds = new Set(opts.trackIds ?? this.toJSON().tracks.map((t) => t.id));
      let removedFrames = 0;
      let cuts = 0;
      // Process from the end so ripple shifts never invalidate earlier ranges.
      for (const range of [...merged].reverse()) {
        const { start, end } = range;
        const length = end - start;
        for (const clip of this.toJSON().clips) {
          if (!trackIds.has(clip.trackId)) continue;
          const cStart = clip.startFrame;
          const cEnd = clipEnd(clip);
          if (cEnd <= start || cStart >= end) continue; // untouched
          if (cStart >= start && cEnd <= end) {
            this.clips.delete(clip.id); // entirely inside the range
            cuts++;
            continue;
          }
          let keepLeft: Clip | null = null;
          let keepRight: Clip | null = null;
          if (cStart < start && cEnd > end) {
            const [l, r] = this.splitClipInternal(clip.id, start);
            const [, rr] = this.splitClipInternal(r.id, end);
            this.clips.delete(r.id);
            keepLeft = l;
            keepRight = rr;
          } else if (cStart < start) {
            const [l, r] = this.splitClipInternal(clip.id, start);
            this.clips.delete(r.id);
            keepLeft = l;
          } else {
            const [l, r] = this.splitClipInternal(clip.id, end);
            this.clips.delete(l.id);
            keepRight = r;
          }
          cuts++;
          if (xf > 0) {
            if (keepLeft && keepLeft.kind !== 'component') {
              const m = this.clips.get(keepLeft.id);
              if (m && Number(m.get('fadeOut') ?? 0) < xf) m.set('fadeOut', Math.min(xf, keepLeft.durationFrames));
            }
            if (keepRight && keepRight.kind !== 'component') {
              const m = this.clips.get(keepRight.id);
              if (m && Number(m.get('fadeIn') ?? 0) < xf) m.set('fadeIn', Math.min(xf, keepRight.durationFrames));
            }
          }
        }
        if (ripple) {
          for (const clip of this.toJSON().clips) {
            if (!trackIds.has(clip.trackId)) continue;
            if (clip.startFrame >= end) this.clips.get(clip.id)!.set('startFrame', clip.startFrame - length);
          }
        }
        removedFrames += length;
      }
      this.touch();
      return { removedFrames, cuts };
    }, origin);
  }

  /** Point clips at a different asset (e.g. the denoised / matted derivative). */
  replaceClipAsset(clipIds: string[], assetId: string, origin?: unknown): void {
    if (!this.assets.has(assetId)) throw new Error(`Asset ${assetId} not found`);
    this.transact(() => {
      for (const id of clipIds) {
        const m = this.clips.get(id);
        if (!m) throw new Error(`Clip ${id} not found`);
        if (m.get('kind') === 'component') throw new Error(`Clip ${id} is a component clip`);
        m.set('assetId', assetId);
      }
      this.touch();
    }, origin);
  }

  // ---- transcripts ---------------------------------------------------------------------

  setTranscript(transcript: Transcript, origin?: unknown): void {
    this.transact(() => {
      this.transcripts.set(transcript.assetId, mapFrom(transcript));
      this.touch();
    }, origin ?? ORIGIN_SYSTEM);
  }

  getTranscript(assetId: string): Transcript | undefined {
    const m = this.transcripts.get(assetId);
    return m ? (m.toJSON() as Transcript) : undefined;
  }

  removeTranscript(assetId: string, origin?: unknown): void {
    this.transact(() => {
      this.transcripts.delete(assetId);
    }, origin ?? ORIGIN_SYSTEM);
  }

  // ---- assets --------------------------------------------------------------------------

  addAsset(asset: Asset, origin?: unknown): Asset {
    return this.transact(() => {
      const existing = this.assets.get(asset.id);
      if (existing) {
        // Merge richer metadata (e.g. duration probed later) without duplicating.
        for (const [k, v] of Object.entries(asset)) if (v !== undefined && existing.get(k) === undefined) existing.set(k, v);
        return existing.toJSON() as Asset;
      }
      this.assets.set(asset.id, mapFrom(asset));
      this.touch();
      return asset;
    }, origin);
  }

  updateAsset(id: string, patch: Partial<Asset>, origin?: unknown): void {
    const m = this.assets.get(id);
    if (!m) throw new Error(`Asset ${id} not found`);
    this.transact(() => {
      for (const [k, v] of Object.entries(patch)) if (v !== undefined) m.set(k, v);
    }, origin);
  }

  removeAsset(id: string, origin?: unknown): void {
    if (!this.assets.has(id)) throw new Error(`Asset ${id} not found`);
    this.transact(() => {
      for (const clip of this.toJSON().clips) if (clip.kind !== 'component' && clip.assetId === id) this.clips.delete(clip.id);
      this.assets.delete(id);
      this.transcripts.delete(id);
      this.touch();
    }, origin);
  }
}

// ---- helpers ---------------------------------------------------------------------------

function mapFrom(obj: object): YMap {
  const m = new Y.Map<unknown>();
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) if (v !== undefined) m.set(k, v);
  return m;
}

function clipToMap(clip: Clip): YMap {
  if (clip.kind === 'component') {
    const { props, ...rest } = clip;
    const m = mapFrom(rest);
    m.set('props', mapFrom(props));
    return m;
  }
  return mapFrom(clip);
}

function mapToClip(m: YMap): Clip {
  const json = m.toJSON() as Record<string, unknown>;
  if (json.kind === 'component') {
    const props = m.get('props');
    json.props = props instanceof Y.Map ? props.toJSON() : (props ?? {});
  }
  return json as unknown as Clip;
}

/** UndoManager scoped to a single peer's own edits. */
export function createUndoManager(project: ProjectDoc, trackedOrigins: unknown[] = [ORIGIN_LOCAL]): Y.UndoManager {
  return new Y.UndoManager([project.tracks, project.clips, project.assets, project.meta, project.transcripts], {
    trackedOrigins: new Set(trackedOrigins),
    captureTimeout: 300,
  });
}
