import { z } from 'zod';

export { ZodError } from 'zod';

/** Zod schemas for persisted project files and control-API request bodies. */

export const TimeExpr = z.union([z.number().nonnegative(), z.string().min(1)]).describe(
  'Frames (number) or a timecode string: HH:MM:SS[:FF], MM:SS, 12.5s, 300f',
);

export const ProjectMetaSchema = z.object({
  id: z.string(),
  name: z.string(),
  fps: z.number().int().min(1).max(240),
  width: z.number().int().min(16).max(8192),
  height: z.number().int().min(16).max(8192),
  background: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  schemaVersion: z.number().int(),
});

export const TrackSchema = z.object({
  id: z.string(),
  name: z.string(),
  kind: z.enum(['video', 'audio', 'overlay']),
  order: z.number(),
  muted: z.boolean(),
  locked: z.boolean(),
  hidden: z.boolean(),
});

export const ClipTransformSchema = z.object({
  x: z.number().min(-1).max(2),
  y: z.number().min(-1).max(2),
  scale: z.number().min(0.05).max(10),
});
export const ClipAnimationSchema = z.object({
  type: z.enum(['fade', 'slide-up', 'slide-down', 'slide-left', 'slide-right', 'pop']),
  durationFrames: z.number().int().min(1).max(600),
});

const ClipBaseSchema = z.object({
  id: z.string(),
  trackId: z.string(),
  name: z.string(),
  startFrame: z.number().int().nonnegative(),
  durationFrames: z.number().int().positive(),
  color: z.string().optional(),
  transform: ClipTransformSchema.optional(),
  animateIn: ClipAnimationSchema.optional(),
  animateOut: ClipAnimationSchema.optional(),
});

export const VolumeKeyframeSchema = z.object({ frame: z.number().int().nonnegative(), gain: z.number().min(0).max(4) });
export const ReframeSchema = z.object({
  mode: z.enum(['face-track', 'center']),
  targetAspect: z.number().positive(),
  keyframes: z.array(z.object({ frame: z.number().int().nonnegative(), cx: z.number().min(0).max(1), cy: z.number().min(0).max(1), zoom: z.number().min(1).max(4) })),
});

export const MediaClipSchema = ClipBaseSchema.extend({
  kind: z.enum(['video', 'audio', 'image']),
  assetId: z.string(),
  trimBefore: z.number().int().nonnegative(),
  volume: z.number().min(0).max(2),
  fit: z.enum(['cover', 'contain', 'fill']),
  fadeIn: z.number().int().nonnegative(),
  fadeOut: z.number().int().nonnegative(),
  volumeKeyframes: z.array(VolumeKeyframeSchema).optional(),
  reframe: ReframeSchema.optional(),
});

export const ComponentClipSchema = ClipBaseSchema.extend({
  kind: z.literal('component'),
  componentName: z.string(),
  props: z.record(z.string(), z.unknown()),
});

export const ClipSchema = z.discriminatedUnion('kind', [MediaClipSchema, ComponentClipSchema]);

export const AssetSchema = z.object({
  id: z.string().regex(/^[a-f0-9]{64}$/, 'asset id must be a sha256 hex digest'),
  name: z.string(),
  kind: z.enum(['video', 'audio', 'image']),
  mime: z.string(),
  size: z.number().int().nonnegative(),
  durationFrames: z.number().int().positive().optional(),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  fps: z.number().positive().optional(),
  importedBy: z.string().optional(),
  importedAt: z.string(),
  derivedFrom: z.string().optional(),
  processing: z.array(z.string()).optional(),
  hasAlpha: z.boolean().optional(),
});

export const TranscriptWordSchema = z.object({
  w: z.string(),
  s: z.number().nonnegative(),
  e: z.number().nonnegative(),
  p: z.number().min(0).max(1).optional(),
  filler: z.boolean().optional(),
});

export const TranscriptSchema = z.object({
  assetId: z.string(),
  engine: z.string(),
  language: z.string(),
  createdAt: z.string(),
  words: z.array(TranscriptWordSchema),
});

export const ProjectSchema = z.object({
  meta: ProjectMetaSchema,
  tracks: z.array(TrackSchema),
  clips: z.array(ClipSchema),
  assets: z.array(AssetSchema),
  transcripts: z.array(TranscriptSchema).default([]),
});

// ---- Control API request bodies -------------------------------------------------------

export const InsertClipRequestSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('component'),
    componentName: z.string().min(1),
    props: z.record(z.string(), z.unknown()).optional(),
    at: TimeExpr.optional(),
    duration: TimeExpr.optional(),
    trackId: z.string().optional(),
    name: z.string().optional(),
    placement: z.enum(['ripple', 'overlap', 'free']).optional(),
  }),
  z.object({
    kind: z.enum(['video', 'audio', 'image']),
    assetId: z.string().min(1),
    at: TimeExpr.optional(),
    duration: TimeExpr.optional(),
    trimBefore: TimeExpr.optional(),
    trackId: z.string().optional(),
    name: z.string().optional(),
    volume: z.number().min(0).max(2).optional(),
    placement: z.enum(['ripple', 'overlap', 'free']).optional(),
  }),
]);
export type InsertClipRequest = z.infer<typeof InsertClipRequestSchema>;

export const UpdateClipRequestSchema = z.object({
  id: z.string().min(1),
  patch: z.object({
    name: z.string().optional(),
    startFrame: TimeExpr.optional(),
    durationFrames: TimeExpr.optional(),
    trimBefore: TimeExpr.optional(),
    volume: z.number().min(0).max(2).optional(),
    fit: z.enum(['cover', 'contain', 'fill']).optional(),
    fadeIn: TimeExpr.optional(),
    fadeOut: TimeExpr.optional(),
    trackId: z.string().optional(),
    color: z.string().optional(),
    props: z.record(z.string(), z.unknown()).optional(),
    volumeKeyframes: z.array(VolumeKeyframeSchema).nullable().optional(),
    reframe: ReframeSchema.nullable().optional(),
    transform: ClipTransformSchema.nullable().optional(),
    animateIn: ClipAnimationSchema.nullable().optional(),
    animateOut: ClipAnimationSchema.nullable().optional(),
  }),
});
export type UpdateClipRequest = z.infer<typeof UpdateClipRequestSchema>;

export const CutRangesRequestSchema = z.object({
  ranges: z.array(z.object({ start: TimeExpr, end: TimeExpr })).min(1),
  /** Restrict to these tracks (default: all tracks). */
  trackIds: z.array(z.string()).optional(),
  ripple: z.boolean().default(true),
  crossfadeFrames: z.number().int().min(0).max(30).default(2),
});

// ---- AI feature requests --------------------------------------------------------------

export const AiTargetSchema = z.object({
  clipId: z.string().optional(),
  assetId: z.string().optional(),
});

export const AiTranscribeRequestSchema = AiTargetSchema.extend({ force: z.boolean().optional() });
export const AiFillersRequestSchema = AiTargetSchema.extend({
  apply: z.boolean().default(false),
  words: z.array(z.string()).optional(),
  padMs: z.number().min(0).max(500).default(40),
});
export const AiSilenceRequestSchema = AiTargetSchema.extend({
  apply: z.boolean().default(false),
  thresholdDb: z.number().min(-90).max(0).default(-38),
  minSilenceMs: z.number().min(100).max(10000).default(400),
  keepMs: z.number().min(0).max(2000).default(150),
});
export const AiBreathsRequestSchema = AiTargetSchema.extend({
  reductionDb: z.number().min(3).max(40).default(15),
  apply: z.boolean().default(true),
});
export const AiDenoiseRequestSchema = AiTargetSchema.extend({
  engine: z.enum(['auto', 'rnnoise', 'afftdn', 'deepfilter']).default('auto'),
  strength: z.number().min(0).max(1).default(0.7),
});
export const AiMatteRequestSchema = AiTargetSchema.extend({
  mode: z.enum(['person', 'chroma']).default('person'),
  quality: z.enum(['fast', 'balanced', 'accurate']).default('balanced'),
  color: z.string().default('0x00FF00'),
  similarity: z.number().min(0.01).max(1).default(0.3),
  blend: z.number().min(0).max(1).default(0.1),
});
export const AiReframeRequestSchema = AiTargetSchema.extend({
  aspect: z.string().default('9:16'),
  resizeProject: z.boolean().default(false),
  sampleFps: z.number().min(1).max(15).default(5),
});
export const AiBrollRequestSchema = z.object({
  assetId: z.string().optional(),
  apply: z.boolean().default(false),
  durationSeconds: z.number().min(0.5).max(60).default(3),
  useClaude: z.boolean().default(true),
  maxSuggestions: z.number().int().min(1).max(50).default(12),
});
export const AiCleanRequestSchema = AiTargetSchema.extend({
  fillers: z.boolean().default(true),
  silences: z.boolean().default(true),
  breaths: z.boolean().default(true),
  denoise: z.boolean().default(false),
});
export const TranscriptCutRequestSchema = z.object({
  assetId: z.string(),
  /** Inclusive word index range within the transcript. */
  fromWord: z.number().int().nonnegative(),
  toWord: z.number().int().nonnegative(),
});

export const MoveClipRequestSchema = z.object({
  id: z.string().min(1),
  at: TimeExpr,
  trackId: z.string().optional(),
});

export const SplitClipRequestSchema = z.object({
  id: z.string().min(1),
  at: TimeExpr,
});

export const RemoveClipRequestSchema = z.object({
  ids: z.array(z.string().min(1)).min(1),
});

export const AddTrackRequestSchema = z.object({
  kind: z.enum(['video', 'audio', 'overlay']),
  name: z.string().optional(),
});

export const UpdateTrackRequestSchema = z.object({
  id: z.string().min(1),
  patch: z.object({
    name: z.string().optional(),
    muted: z.boolean().optional(),
    locked: z.boolean().optional(),
    hidden: z.boolean().optional(),
    order: z.number().optional(),
  }),
});

export const ImportAssetRequestSchema = z.object({
  /** Absolute path on the machine running the desktop app. */
  path: z.string().min(1),
  /** Also insert on the timeline after import. */
  insert: z
    .object({
      at: TimeExpr.optional(),
      trackId: z.string().optional(),
    })
    .optional(),
});

export const RenderRequestSchema = z.object({
  output: z.string().min(1).describe('Output .mp4 path (absolute or relative to the project)'),
  preset: z.string().default('project'),
  /** Render a sub-range of the timeline. */
  from: TimeExpr.optional(),
  to: TimeExpr.optional(),
});
export type RenderRequest = z.infer<typeof RenderRequestSchema>;

export const UpdateMetaRequestSchema = z.object({
  name: z.string().min(1).optional(),
  fps: z.number().int().min(1).max(240).optional(),
  width: z.number().int().min(16).max(8192).optional(),
  height: z.number().int().min(16).max(8192).optional(),
  background: z.string().optional(),
});

export const ProjectOpenRequestSchema = z.object({ path: z.string().min(1) });
export const ProjectSaveRequestSchema = z.object({ path: z.string().min(1).optional() });
export const ProjectNewRequestSchema = z.object({
  name: z.string().min(1).optional(),
  fps: z.number().int().min(1).max(240).optional(),
  width: z.number().int().min(16).max(8192).optional(),
  height: z.number().int().min(16).max(8192).optional(),
});

export const RoomHostRequestSchema = z.object({ password: z.string().optional() });
export const RoomJoinRequestSchema = z.object({
  roomCode: z.string().min(1),
  password: z.string().optional(),
  /** Explicit signaling/sync URL if mDNS/LAN discovery is not available. */
  hostUrl: z.string().url().optional(),
});

export const PreviewControlRequestSchema = z.object({
  action: z.enum(['play', 'pause', 'toggle', 'seek']),
  at: TimeExpr.optional(),
});

export const UiControlRequestSchema = z.object({
  panel: z.enum(['assets', 'templates', 'inspector', 'peers', 'renders', 'activity', 'ai', 'script']).optional(),
  /** Clip ids (or empty array to clear the selection). */
  select: z.array(z.string()).optional(),
  dialog: z.enum(['render', 'room', 'shortcuts', 'none']).optional(),
});

export const AiEnhanceRequestSchema = AiTargetSchema.extend({
  /** Target integrated loudness (EBU R128). */
  lufs: z.number().min(-36).max(-8).default(-16),
  denoise: z.boolean().default(true),
  strength: z.number().min(0).max(1).default(0.5),
});
export const AiSetupRequestSchema = z.object({
  /** Which engines to install. */
  whisper: z.boolean().default(true),
  rnnoise: z.boolean().default(true),
  model: z.enum(['tiny.en', 'base.en', 'small.en']).default('base.en'),
});
export const DetachAudioRequestSchema = z.object({ id: z.string().min(1) });
