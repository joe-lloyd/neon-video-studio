import { z } from 'zod';
import { TimeExpr } from './schemas.ts';

/**
 * YouTube publishing: what a client may ask for (zod, validated once at the control API) and the
 * job/auth state the app reports back. The main process (apps/desktop/src/main/youtube.ts) talks
 * to Google; nothing here does I/O.
 */

/** YouTube's video categories (stable ids; the API's videoCategories.list returns the same set). */
export const YouTubeCategoryIdSchema = z.enum(['1', '2', '10', '15', '17', '19', '20', '22', '23', '24', '25', '26', '27', '28', '29']);
export type YouTubeCategoryId = z.infer<typeof YouTubeCategoryIdSchema>;
const CATEGORY_LABELS: Record<YouTubeCategoryId, string> = {
  '1': 'Film & Animation',
  '2': 'Autos & Vehicles',
  '10': 'Music',
  '15': 'Pets & Animals',
  '17': 'Sports',
  '19': 'Travel & Events',
  '20': 'Gaming',
  '22': 'People & Blogs',
  '23': 'Comedy',
  '24': 'Entertainment',
  '25': 'News & Politics',
  '26': 'Howto & Style',
  '27': 'Education',
  '28': 'Science & Technology',
  '29': 'Nonprofits & Activism',
};
export const YOUTUBE_CATEGORIES = YouTubeCategoryIdSchema.options.map((id) => ({ id, label: CATEGORY_LABELS[id] }));

export const YouTubePrivacySchema = z.enum(['private', 'unlisted', 'public']);
export type YouTubePrivacy = z.infer<typeof YouTubePrivacySchema>;

/** YouTube counts a tag with a space as if it were quoted, and the commas between tags. */
export function youtubeTagsLength(tags: readonly string[]): number {
  return tags.reduce((sum, t) => sum + t.length + (t.includes(' ') ? 2 : 0), 0) + Math.max(0, tags.length - 1);
}

export const YouTubeMetadataSchema = z
  .object({
    title: z.string().trim().min(1).max(100).refine((s) => !/[<>]/.test(s), 'title may not contain < or >'),
    description: z.string().max(5000).refine((s) => !/[<>]/.test(s), 'description may not contain < or >').default(''),
    tags: z
      .array(z.string().trim().min(1))
      .default([])
      .refine((tags) => youtubeTagsLength(tags) <= 500, 'tags add up to more than 500 characters'),
    categoryId: YouTubeCategoryIdSchema.default('28').describe('YouTube category id (28 = Science & Technology)'),
    privacy: YouTubePrivacySchema.default('private'),
    /** Scheduled release (ISO 8601). YouTube needs privacy "private" until then. */
    publishAt: z.iso.datetime({ offset: true }).optional(),
    /** YouTube requires every upload to say whether it is made for kids. */
    madeForKids: z.boolean(),
    /** Realistic altered or synthetic media (YouTube's AI disclosure). */
    containsSyntheticMedia: z.boolean().default(false),
    /** BCP-47 language of the title/description and the audio, e.g. "en". */
    language: z.string().min(2).max(20).optional(),
    license: z.enum(['youtube', 'creativeCommon']).default('youtube'),
    embeddable: z.boolean().default(true),
    notifySubscribers: z.boolean().default(true),
    /** Add the video to this playlist after upload. */
    playlistId: z.string().min(1).optional(),
    /** PNG or JPEG custom thumbnail (absolute or relative to the project). Needs a verified channel. */
    thumbnail: z.string().min(1).optional(),
  })
  .refine((m) => m.publishAt === undefined || m.privacy === 'private', { path: ['publishAt'], message: 'a scheduled video must be uploaded as private (it goes public at publishAt)' });
export type YouTubeMetadata = z.infer<typeof YouTubeMetadataSchema>;
export type YouTubeMetadataInput = z.input<typeof YouTubeMetadataSchema>;

export const YouTubeSourceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('file'), path: z.string().min(1).describe('A finished video file (absolute or relative to the project)') }),
  z.object({
    kind: z.literal('timeline'),
    preset: z.string().default('project'),
    from: TimeExpr.optional(),
    to: TimeExpr.optional(),
  }),
]);
export type YouTubeSource = z.infer<typeof YouTubeSourceSchema>;

export const YouTubeUploadRequestSchema = z.object({
  /** Upload a file, or render the timeline first and upload the result in the same job. */
  source: YouTubeSourceSchema,
  metadata: YouTubeMetadataSchema,
});
export type YouTubeUploadRequest = z.infer<typeof YouTubeUploadRequestSchema>;
export type YouTubeUploadRequestInput = z.input<typeof YouTubeUploadRequestSchema>;

export const YouTubeLoginRequestSchema = z.object({
  /** Open the consent page in the app machine's browser (default). False: just return the URL. */
  open: z.boolean().default(true),
});

/** Your own Google Cloud OAuth client ("Desktop app" type) instead of the one built into the app. */
export const YouTubeClientRequestSchema = z.union([
  z.object({ clientId: z.string().min(10), clientSecret: z.string().min(1) }),
  z.object({ reset: z.literal(true) }),
]);
export type YouTubeClientRequest = z.infer<typeof YouTubeClientRequestSchema>;

export interface YouTubeChannel {
  id: string;
  title: string;
  /** "@handle" when the channel has one. */
  handle: string | null;
}

export type YouTubeAuth =
  /** No OAuth client: this build has none built in and none is configured. */
  | { state: 'unconfigured'; hint: string }
  | { state: 'signed-out' }
  /** Waiting for the user to finish Google's consent page. */
  | { state: 'pending'; authUrl: string }
  | { state: 'signed-in'; channel: YouTubeChannel };

export type YouTubeUploadStatus = 'rendering' | 'uploading' | 'finishing' | 'done' | 'failed' | 'cancelled';

export interface YouTubeUploadJob {
  id: string;
  status: YouTubeUploadStatus;
  title: string;
  privacy: YouTubePrivacy;
  /** The render this job started (source kind "timeline"). */
  renderJobId: string | null;
  /** The file being uploaded; null until the render finishes. */
  filePath: string | null;
  /** 0..1 of the current stage (render, then upload). */
  progress: number;
  bytesSent: number;
  totalBytes: number;
  videoId: string | null;
  url: string | null;
  /** Things that went wrong after the video itself was uploaded (thumbnail, playlist, locked privacy). */
  warnings: string[];
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
}

/** GET /api/youtube */
export interface YouTubeState {
  auth: YouTubeAuth;
  /** Why the last sign-in attempt failed (cleared when a new one starts). */
  loginError: string | null;
  uploads: YouTubeUploadJob[];
}

/** The YouTube Data API `video` resource for videos.insert (snippet + status parts). */
export function toVideoResource(m: YouTubeMetadata): { snippet: Record<string, unknown>; status: Record<string, unknown> } {
  return {
    snippet: {
      title: m.title,
      description: m.description,
      tags: m.tags,
      categoryId: m.categoryId,
      ...(m.language ? { defaultLanguage: m.language, defaultAudioLanguage: m.language } : {}),
    },
    status: {
      privacyStatus: m.privacy,
      ...(m.publishAt ? { publishAt: m.publishAt } : {}),
      selfDeclaredMadeForKids: m.madeForKids,
      containsSyntheticMedia: m.containsSyntheticMedia,
      license: m.license,
      embeddable: m.embeddable,
    },
  };
}

export function youtubeWatchUrl(videoId: string): string {
  return `https://youtu.be/${videoId}`;
}
