/**
 * `neon-cli youtube …`: sign in to YouTube and publish from the running app.
 *
 *   youtube [status] | youtube login [--no-open] | youtube logout | youtube categories
 *   youtube client --client-id ID --client-secret S | youtube client --reset
 *   youtube upload [<file.mp4>] --title T (--kids|--no-kids) [metadata flags] [--preset ID --from T --to T] [--no-wait]
 *   youtube job <id> | youtube cancel <id>
 *   youtube videos | youtube thumbnail <video|link> <file.png|project>
 *
 * Without a file, upload renders the timeline first (one job). The app holds the Google tokens;
 * the CLI only talks to the control API.
 */
import { readFileSync } from 'node:fs';
import { YOUTUBE_CATEGORIES, type YouTubeAuth, type YouTubeSource, type YouTubeUploadJob } from '@neon/core';
import { ApiError, type NeonClient } from './client.ts';
import { progressBar } from './format.ts';

export interface YouTubeFlags {
  title?: string;
  description?: string;
  'description-file'?: string;
  tags?: string;
  category?: string;
  privacy?: string;
  'publish-at'?: string;
  kids?: boolean;
  'ai-content'?: boolean;
  language?: string;
  license?: string;
  embed?: boolean;
  notify?: boolean;
  playlist?: string;
  thumbnail?: string;
  metadata?: string;
  preset?: string;
  from?: string;
  to?: string;
  open?: boolean;
  'client-id'?: string;
  'client-secret'?: string;
  reset?: boolean;
  wait?: boolean;
}

type Io = { json: boolean; out: (data: unknown, human: () => string) => void; appPath: (p: string) => string };

const readJson = (path: string): Record<string, unknown> => {
  const parsed: unknown = JSON.parse(readFileSync(path === '-' ? 0 : path, 'utf8'));
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new ApiError('USAGE', `--metadata ${path} must hold a JSON object`);
  return Object.fromEntries(Object.entries(parsed));
};

/**
 * The POST /api/youtube/upload body. Flags override a --metadata JSON file; the app validates the
 * result (lengths, categories, privacy rules), so this only maps names and reads local files.
 */
export interface YouTubeUploadBody {
  source: YouTubeSource;
  /** Checked by the app against YouTubeMetadataSchema. */
  metadata: Record<string, unknown>;
}

export function youtubeUploadBody(file: string | undefined, flags: YouTubeFlags, io: Pick<Io, 'appPath'>, read: { json: typeof readJson; text: (p: string) => string } = { json: readJson, text: (p) => readFileSync(p, 'utf8') }): YouTubeUploadBody {
  const fromFile = flags.metadata ? read.json(flags.metadata) : {};
  const description = flags['description-file'] !== undefined ? read.text(flags['description-file']) : flags.description;
  const picked: Record<string, unknown> = {
    title: flags.title,
    description,
    tags: flags.tags?.split(',').map((t) => t.trim()).filter(Boolean),
    categoryId: flags.category,
    privacy: flags.privacy,
    publishAt: flags['publish-at'],
    madeForKids: flags.kids,
    containsSyntheticMedia: flags['ai-content'],
    language: flags.language,
    license: flags.license === 'cc' ? 'creativeCommon' : flags.license,
    embeddable: flags.embed === false ? false : undefined,
    notifySubscribers: flags.notify === false ? false : undefined,
    playlistId: flags.playlist,
    // `--thumbnail project` uses the project's thumbnail (neon-cli thumbnail …); anything else is a file.
    thumbnail: flags.thumbnail === undefined || flags.thumbnail === 'project' ? undefined : io.appPath(flags.thumbnail),
    projectThumbnail: flags.thumbnail === 'project' ? true : undefined,
  };
  const metadata: Record<string, unknown> = { ...fromFile, ...Object.fromEntries(Object.entries(picked).filter(([, v]) => v !== undefined)) };
  if (!metadata.title) throw new ApiError('USAGE', 'youtube upload needs --title (or "title" in --metadata)');
  if (metadata.madeForKids === undefined) throw new ApiError('USAGE', 'YouTube requires an answer: is this video made for kids? Pass --no-kids (most videos) or --kids');
  if (file !== undefined && (flags.preset !== undefined || flags.from !== undefined || flags.to !== undefined)) throw new ApiError('USAGE', '--preset/--from/--to render the timeline; leave out the file to use them');
  return {
    source: file !== undefined ? { kind: 'file', path: io.appPath(file) } : { kind: 'timeline', preset: flags.preset ?? 'project', from: flags.from, to: flags.to },
    metadata,
  };
}

export function describeAuth(auth: YouTubeAuth): string {
  switch (auth.state) {
    case 'signed-in':
      return `Signed in to YouTube as ${auth.channel.title}${auth.channel.handle ? ` (${auth.channel.handle})` : ''}`;
    case 'signed-out':
      return 'Not signed in to YouTube — run `neon-cli youtube login`';
    case 'pending':
      return `Waiting for Google sign-in: ${auth.authUrl}`;
    case 'unconfigured':
      return auth.hint;
    default: {
      const _exhaustive: never = auth;
      return _exhaustive;
    }
  }
}

export function describeUpload(job: YouTubeUploadJob): string {
  const stage =
    job.status === 'rendering' ? `rendering ${progressBar(job.progress)}`
    : job.status === 'uploading' ? `uploading ${progressBar(job.progress)} ${mb(job.bytesSent)}/${mb(job.totalBytes)} MB`
    : job.status;
  const lines = [`${job.id} “${job.title}” ${stage}${job.url ? ` → ${job.url} (${job.privacy})` : ''}`];
  for (const w of job.warnings) lines.push(`  warning: ${w}`);
  if (job.error) lines.push(`  ${job.error}`);
  return lines.join('\n');
}

const mb = (bytes: number) => (bytes / 1024 / 1024).toFixed(1);
const terminal = (job: YouTubeUploadJob) => job.status === 'done' || job.status === 'failed' || job.status === 'cancelled';

async function waitForUpload(api: NeonClient, job: YouTubeUploadJob, io: Io): Promise<YouTubeUploadJob> {
  let current = job;
  let last = '';
  while (!terminal(current)) {
    await new Promise((r) => setTimeout(r, 500));
    current = await api.youtubeUpload(current.id);
    if (!io.json) {
      const line = describeUpload({ ...current, warnings: [], error: null });
      if (line !== last) process.stderr.write(`\r${line.padEnd(last.length)}`);
      last = line;
    }
  }
  if (!io.json) process.stderr.write('\n');
  return current;
}

export async function youtubeCommand(api: NeonClient, sub: string | undefined, rest: string[], flags: YouTubeFlags, io: Io): Promise<void> {
  switch (sub) {
    case undefined:
    case 'status': {
      const s = await api.youtube();
      io.out(s, () => [describeAuth(s.auth), ...(s.loginError ? [`Last sign-in failed: ${s.loginError}`] : []), ...s.uploads.map(describeUpload)].join('\n'));
      return;
    }
    case 'categories': {
      io.out(YOUTUBE_CATEGORIES, () => YOUTUBE_CATEGORIES.map((c) => `${c.id.padStart(2)}  ${c.label}`).join('\n'));
      return;
    }
    case 'login': {
      const { authUrl } = await api.youtubeLogin({ open: flags.open !== false });
      if (!io.json) process.stderr.write(`${flags.open === false ? 'Open this URL on the machine running the app' : 'Opened Google sign-in in the browser on the app machine'}:\n  ${authUrl}\nWaiting for you to approve…\n`);
      const deadline = Date.now() + 5 * 60_000;
      for (;;) {
        const s = await api.youtube();
        if (s.auth.state === 'signed-in') return io.out(s.auth, () => describeAuth(s.auth));
        if (s.auth.state !== 'pending') throw new ApiError('YOUTUBE_LOGIN', s.loginError ?? 'Sign-in did not complete');
        if (Date.now() > deadline) throw new ApiError('YOUTUBE_LOGIN', 'Timed out waiting for Google sign-in');
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
    case 'logout': {
      const auth = await api.youtubeLogout();
      io.out(auth, () => 'Signed out of YouTube (token revoked)');
      return;
    }
    case 'client': {
      const body = flags.reset ? { reset: true as const } : flags['client-id'] && flags['client-secret'] ? { clientId: flags['client-id'], clientSecret: flags['client-secret'] } : null;
      if (!body) throw new ApiError('USAGE', 'youtube client needs --client-id ID --client-secret SECRET (a Google Cloud "Desktop app" OAuth client), or --reset');
      const auth = await api.youtubeClient(body);
      io.out(auth, () => `${flags.reset ? 'Using the built-in OAuth client' : 'Using your OAuth client'}. ${describeAuth(auth)}`);
      return;
    }
    case 'upload': {
      let job = await api.youtubeUploadStart(youtubeUploadBody(rest[0], flags, io));
      if (flags.wait !== false) job = await waitForUpload(api, job, io);
      if (job.status === 'failed') throw new ApiError('YOUTUBE_UPLOAD_FAILED', job.error ?? 'Upload failed', job);
      io.out(job, () => describeUpload(job));
      return;
    }
    case 'videos': {
      const videos = await api.youtubeVideos();
      io.out(videos, () => (videos.length ? videos.map((v) => `${v.id}  ${v.privacy.padEnd(8)} ${v.publishedAt.slice(0, 10)}  ${v.title}`).join('\n') : 'No uploads on this channel yet'));
      return;
    }
    case 'thumbnail': {
      const [video, source] = rest;
      if (!video || !source) throw new ApiError('USAGE', 'usage: neon-cli youtube thumbnail <video id|link> <file.png|project>   (project = the project thumbnail, see neon-cli thumbnail)');
      const r = await api.youtubeThumbnail(source === 'project' ? { video, projectThumbnail: true } : { video, thumbnail: io.appPath(source) });
      io.out(r, () => `Thumbnail set on ${r.url} (${r.thumbnail})`);
      return;
    }
    case 'job': {
      if (!rest[0]) throw new ApiError('USAGE', 'usage: neon-cli youtube job <id>');
      const job = await api.youtubeUpload(rest[0]);
      io.out(job, () => describeUpload(job));
      return;
    }
    case 'cancel': {
      if (!rest[0]) throw new ApiError('USAGE', 'usage: neon-cli youtube cancel <id>');
      const job = await api.youtubeUploadCancel(rest[0]);
      io.out(job, () => `${job.id} cancelling`);
      return;
    }
    default:
      throw new ApiError('USAGE', `Unknown subcommand "youtube ${sub}" (status, login, logout, client, upload, videos, thumbnail, job, cancel, categories)`);
  }
}
