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

const ClipBaseSchema = z.object({
  id: z.string(),
  trackId: z.string(),
  name: z.string(),
  startFrame: z.number().int().nonnegative(),
  durationFrames: z.number().int().positive(),
  color: z.string().optional(),
});

export const MediaClipSchema = ClipBaseSchema.extend({
  kind: z.enum(['video', 'audio', 'image']),
  assetId: z.string(),
  trimBefore: z.number().int().nonnegative(),
  volume: z.number().min(0).max(2),
  fit: z.enum(['cover', 'contain', 'fill']),
  fadeIn: z.number().int().nonnegative(),
  fadeOut: z.number().int().nonnegative(),
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
});

export const ProjectSchema = z.object({
  meta: ProjectMetaSchema,
  tracks: z.array(TrackSchema),
  clips: z.array(ClipSchema),
  assets: z.array(AssetSchema),
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
  }),
});
export type UpdateClipRequest = z.infer<typeof UpdateClipRequestSchema>;

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
  panel: z.enum(['assets', 'templates', 'inspector', 'peers', 'renders', 'activity']).optional(),
  /** Clip ids (or empty array to clear the selection). */
  select: z.array(z.string()).optional(),
  dialog: z.enum(['render', 'room', 'shortcuts', 'none']).optional(),
});
