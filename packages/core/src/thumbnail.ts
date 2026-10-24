import { z } from 'zod';
import { ClipTransformSchema, TimeExpr } from './schemas.ts';
import { projectDurationFrames, type Clip, type ClipTransform, type Project, type Thumbnail, type Track } from './types.ts';

/**
 * The project's video thumbnail: a background (a colour, or a frame of the timeline) with
 * component and image layers on top, built from the same templates and FX packs as the timeline.
 * thumbnailProject() turns it into a one-frame project, so the Player previews it and the still
 * renderer draws it exactly like any other frame.
 */

export const THUMBNAIL_WIDTH = 1280;
export const THUMBNAIL_HEIGHT = 720;

export const EMPTY_THUMBNAIL: Thumbnail = { background: { kind: 'frame', frame: 0 }, layers: [] };
const FULL_FRAME: ClipTransform = { x: 0.5, y: 0.5, scale: 1 };

// ---- control API bodies -------------------------------------------------------------------

const LayerPlacement = {
  name: z.string().min(1).optional(),
  transform: ClipTransformSchema.partial().optional().describe('Centre x,y (0..1 of the thumbnail), scale (1 = full size), rotation (degrees)'),
};
export const ThumbnailAddLayerRequestSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('component'), componentName: z.string().min(1), props: z.record(z.string(), z.unknown()).default({}), ...LayerPlacement }),
  z.object({ kind: z.literal('image'), assetId: z.string().min(1).describe('Asset id or name (imported image)'), ...LayerPlacement }),
]);
export type ThumbnailAddLayerRequest = z.infer<typeof ThumbnailAddLayerRequestSchema>;
export type ThumbnailAddLayerInput = z.input<typeof ThumbnailAddLayerRequestSchema>;

export const ThumbnailUpdateLayerRequestSchema = z.object({
  id: z.string().min(1),
  patch: z.object({
    name: z.string().min(1).optional(),
    /** Merged into the current props. */
    props: z.record(z.string(), z.unknown()).optional(),
    transform: ClipTransformSchema.partial().optional(),
  }),
});
export type ThumbnailUpdateLayerRequest = z.infer<typeof ThumbnailUpdateLayerRequestSchema>;

export const ThumbnailMoveLayerRequestSchema = z.object({
  id: z.string().min(1),
  /** New position from the bottom (0) to the top (layers - 1). */
  index: z.number().int().nonnegative(),
});

export const ThumbnailBackgroundRequestSchema = z.union([
  z.object({ color: z.string().min(1).describe('CSS colour') }),
  z.object({ at: TimeExpr.describe('Use this timeline frame as the background') }),
]);

export const ThumbnailRenderRequestSchema = z.object({
  output: z.string().min(1).optional().describe('Output .png path (default: <NEON_HOME>/stills/<project>-thumbnail.png)'),
});

// ---- the one-frame project ----------------------------------------------------------------

/**
 * The project the renderer draws for the thumbnail, and the frame to draw. A frame background
 * keeps the timeline (seen at that frame) under the layers; a colour background drops it. Each
 * layer gets its own track above every timeline track, so stacking follows `order`.
 *
 * Templates animate in over their first frames and out over their last, so a layer is a clip
 * SETTLE_SECONDS long on each side of the drawn frame; the timeline shifts by the same amount
 * to keep its picture.
 */
export const SETTLE_SECONDS = 3;

export function thumbnailProject(project: Project): { project: Project; frame: number } {
  const thumb = project.thumbnail ?? EMPTY_THUMBNAIL;
  const duration = projectDurationFrames(project);
  const fromTimeline = thumb.background.kind === 'frame' && duration > 0;
  const source = thumb.background.kind === 'frame' && duration > 0 ? Math.min(thumb.background.frame, duration - 1) : 0;
  const settle = Math.round(SETTLE_SECONDS * project.meta.fps);
  const frame = source + settle;
  const baseTracks = fromTimeline ? project.tracks : [];
  const top = baseTracks.reduce((max, t) => Math.max(max, t.order), -1);
  const layers = [...thumb.layers].sort((a, b) => a.order - b.order);
  const tracks: Track[] = [
    ...baseTracks,
    ...layers.map((l, i): Track => ({ id: `thumb-${l.id}`, name: l.name, kind: 'overlay', order: top + 1 + i, muted: true, locked: false, hidden: false })),
  ];
  const clips: Clip[] = [
    ...(fromTimeline ? project.clips.map((c) => ({ ...c, startFrame: c.startFrame + settle })) : []),
    ...layers.map((l): Clip => {
      const base = { id: l.id, trackId: `thumb-${l.id}`, name: l.name, startFrame: source, durationFrames: 2 * settle + 1, transform: l.transform };
      return l.kind === 'component'
        ? { ...base, kind: 'component', componentName: l.componentName, props: l.props }
        : { ...base, kind: 'image', assetId: l.assetId, trimBefore: 0, volume: 0, fit: 'contain', fadeIn: 0, fadeOut: 0 };
    }),
  ];
  return {
    project: {
      ...project,
      meta: { ...project.meta, width: THUMBNAIL_WIDTH, height: THUMBNAIL_HEIGHT, background: thumb.background.kind === 'color' ? thumb.background.color : project.meta.background },
      tracks,
      clips,
    },
    frame,
  };
}

export function newLayerTransform(patch: Partial<ClipTransform> | undefined): ClipTransform {
  return { ...FULL_FRAME, ...patch };
}
