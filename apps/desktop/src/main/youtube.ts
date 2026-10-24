/**
 * Publish to YouTube straight from the app: Google sign-in (OAuth 2.0 for installed apps, loopback
 * redirect + PKCE) and upload jobs that optionally render the timeline first, then stream the file
 * with the Data API's resumable protocol, set the thumbnail and add the video to a playlist.
 *
 * The refresh token lives in <NEON_HOME>/youtube.json (mode 0600) — the CLI and UI never see it.
 * Window-free (core.ts owns it), and every Google endpoint is injectable so tests run a fake.
 */
import { createHash, randomBytes } from 'node:crypto';
import { open as openFile, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { extname } from 'node:path';
import { z } from 'zod';
import {
  newId,
  toVideoResource,
  videoStatusUpdate,
  youtubeWatchUrl,
  type RenderJob,
  type YouTubeAuth,
  type YouTubeChannel,
  type YouTubeMetadata,
  type YouTubeUploadJob,
  type YouTubeUploadRequest,
} from '@neon/core';

export interface OAuthClient {
  clientId: string;
  clientSecret: string;
}

export interface GoogleEndpoints {
  auth: string;
  token: string;
  revoke: string;
  /** Data API base, e.g. https://www.googleapis.com/youtube/v3 */
  api: string;
  /** Media upload base, e.g. https://www.googleapis.com/upload/youtube/v3 */
  upload: string;
}

export const GOOGLE_ENDPOINTS: GoogleEndpoints = {
  auth: 'https://accounts.google.com/o/oauth2/v2/auth',
  token: 'https://oauth2.googleapis.com/token',
  revoke: 'https://oauth2.googleapis.com/revoke',
  api: 'https://www.googleapis.com/youtube/v3',
  upload: 'https://www.googleapis.com/upload/youtube/v3',
};

const SCOPES = ['https://www.googleapis.com/auth/youtube.upload', 'https://www.googleapis.com/auth/youtube'];
/** Resumable chunks must be multiples of 256 KiB. */
const CHUNK_BYTES = 32 * 256 * 1024;
const LOGIN_TIMEOUT_MS = 5 * 60_000;
const MAX_RETRIES = 5;

export interface YouTubeDeps {
  /** <NEON_HOME>/youtube.json */
  tokenFile: string;
  /** The OAuth client to use now (env, settings or built in); null when there is none. */
  client(): OAuthClient | null;
  endpoints?: GoogleEndpoints;
  openBrowser(url: string): void;
  /** Start a timeline render; `finished` resolves with the output path. */
  render(opts: { presetId: string; from?: string | number; to?: string | number }): { job: RenderJob; finished: Promise<string> };
  cancelRender(id: string): void;
  /** Resolve a path the client sent (relative paths are relative to the project). */
  resolvePath(path: string): string;
  onUpdate(job: YouTubeUploadJob): void;
  /** Retry backoff; tests pass 0. */
  retryDelayMs?: number;
}

const StoredTokenSchema = z.object({
  clientId: z.string(),
  refreshToken: z.string(),
  accessToken: z.string(),
  expiresAt: z.number(),
  channel: z.object({ id: z.string(), title: z.string(), handle: z.string().nullable() }),
});
type StoredToken = z.infer<typeof StoredTokenSchema>;

const TokenResponseSchema = z.object({
  access_token: z.string(),
  expires_in: z.number(),
  refresh_token: z.string().optional(),
});

const ChannelListSchema = z.object({
  items: z
    .array(z.object({ id: z.string(), snippet: z.object({ title: z.string(), customUrl: z.string().optional() }) }))
    .default([]),
});

const VideoSchema = z.object({
  id: z.string(),
  status: z.object({ privacyStatus: z.string().optional(), uploadStatus: z.string().optional(), rejectionReason: z.string().optional() }).optional(),
});

const GoogleErrorSchema = z.object({
  error: z.union([
    z.object({ message: z.string(), errors: z.array(z.object({ reason: z.string().optional() })).optional() }),
    z.string(),
  ]),
  error_description: z.string().optional(),
});

/** A readable message from a Google error response. */
async function googleError(res: Response, what: string): Promise<Error> {
  const text = await res.text().catch(() => '');
  let detail = text.slice(0, 300) || res.statusText;
  try {
    const parsed = GoogleErrorSchema.safeParse(JSON.parse(text));
    if (parsed.success) {
      const e = parsed.data.error;
      detail = typeof e === 'string' ? `${e}${parsed.data.error_description ? `: ${parsed.data.error_description}` : ''}` : `${e.message}${e.errors?.[0]?.reason ? ` (${e.errors[0].reason})` : ''}`;
    }
  } catch {
    /* not JSON */
  }
  return new Error(`${what} failed (HTTP ${res.status}): ${detail}`);
}

function base64url(buf: Buffer): string {
  return buf.toString('base64url');
}

const THUMBNAIL_TYPES: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg' };

interface PendingLogin {
  server: Server;
  authUrl: string;
  timer: ReturnType<typeof setTimeout>;
}

interface Running {
  abort: AbortController;
}

export class YouTubeManager {
  private readonly deps: YouTubeDeps;
  private readonly endpoints: GoogleEndpoints;
  private readonly jobs = new Map<string, YouTubeUploadJob>();
  private readonly running = new Map<string, Running>();
  private token: StoredToken | null = null;
  private pending: PendingLogin | null = null;
  private loginError: string | null = null;

  constructor(deps: YouTubeDeps) {
    this.deps = deps;
    this.endpoints = deps.endpoints ?? GOOGLE_ENDPOINTS;
  }

  /** Read the saved sign-in. A token minted for another OAuth client counts as signed out. */
  async load(): Promise<void> {
    try {
      const parsed = StoredTokenSchema.safeParse(JSON.parse(await readFile(this.deps.tokenFile, 'utf8')));
      this.token = parsed.success ? parsed.data : null;
    } catch {
      this.token = null;
    }
  }

  auth(): YouTubeAuth {
    const client = this.deps.client();
    if (!client) {
      return {
        state: 'unconfigured',
        hint: 'This build has no Google OAuth client. Create a "Desktop app" client in Google Cloud (YouTube Data API v3 enabled), then run `neon-cli youtube client --id <id> --secret <secret>` or set NEON_YOUTUBE_CLIENT_ID / NEON_YOUTUBE_CLIENT_SECRET.',
      };
    }
    if (this.pending) return { state: 'pending', authUrl: this.pending.authUrl };
    if (this.token && this.token.clientId === client.clientId) return { state: 'signed-in', channel: this.token.channel };
    return { state: 'signed-out' };
  }

  /** Why the last sign-in failed, if it did (cleared by the next attempt). */
  lastLoginError(): string | null {
    return this.loginError;
  }

  list(): YouTubeUploadJob[] {
    return [...this.jobs.values()].sort((a, b) => b.startedAt.localeCompare(a.startedAt)).slice(0, 20);
  }

  get(id: string): YouTubeUploadJob | undefined {
    return this.jobs.get(id);
  }

  /**
   * Start Google's consent flow. Resolves with the consent URL once the loopback listener is up;
   * the sign-in completes in the background when Google redirects back (watch `auth()`).
   */
  async login(opts: { open: boolean }): Promise<{ authUrl: string }> {
    const client = this.requireClient();
    this.cancelLogin();
    this.loginError = null;
    const verifier = base64url(randomBytes(32));
    const challenge = base64url(createHash('sha256').update(verifier).digest());
    const state = base64url(randomBytes(16));
    const server = createServer();
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => resolve());
    });
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('loopback listener has no port');
    const redirectUri = `http://127.0.0.1:${address.port}`;
    const url = new URL(this.endpoints.auth);
    url.search = new URLSearchParams({
      client_id: client.clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: SCOPES.join(' '),
      access_type: 'offline',
      prompt: 'consent',
      code_challenge: challenge,
      code_challenge_method: 'S256',
      state,
    }).toString();
    const authUrl = url.toString();

    server.on('request', (req, res) => {
      const params = new URL(req.url ?? '/', redirectUri).searchParams;
      if (params.get('state') !== state) {
        res.writeHead(404).end();
        return;
      }
      const code = params.get('code');
      const denied = params.get('error');
      const finish = (ok: boolean, message: string) => {
        res.writeHead(ok ? 200 : 400, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`<!doctype html><meta charset="utf-8"><title>Neon Video Studio</title><body style="font:16px system-ui;background:#0b0b14;color:#eee;display:grid;place-items:center;height:90vh"><p>${message}</p></body>`);
      };
      if (!code) {
        this.loginError = `Google sign-in was not completed: ${denied ?? 'no code returned'}`;
        finish(false, 'Sign-in was cancelled. You can close this tab.');
        this.cancelLogin();
        return;
      }
      void this.exchangeCode({ client, code, verifier, redirectUri })
        .then((channel) => finish(true, `Signed in to YouTube as <b>${channel.title.replace(/[<>&]/g, '')}</b>. You can close this tab.`))
        .catch((err: unknown) => {
          this.loginError = err instanceof Error ? err.message : String(err);
          finish(false, 'Sign-in failed. Check Neon Video Studio for the reason. You can close this tab.');
        })
        .finally(() => this.cancelLogin());
    });
    const timer = setTimeout(() => {
      this.loginError = 'Google sign-in timed out after 5 minutes';
      this.cancelLogin();
    }, LOGIN_TIMEOUT_MS);
    this.pending = { server, authUrl, timer };
    if (opts.open) this.deps.openBrowser(authUrl);
    return { authUrl };
  }

  /** Forget the sign-in and revoke the token at Google (best effort). */
  async logout(): Promise<YouTubeAuth> {
    this.cancelLogin();
    const token = this.token;
    this.token = null;
    await rm(this.deps.tokenFile, { force: true });
    if (token) {
      await fetch(`${this.endpoints.revoke}?${new URLSearchParams({ token: token.refreshToken })}`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }).catch(() => undefined);
    }
    return this.auth();
  }

  /** Validate up front (signed in, files exist), then run the job in the background. */
  async upload(req: YouTubeUploadRequest): Promise<YouTubeUploadJob> {
    if (this.auth().state !== 'signed-in') throw new Error('Not signed in to YouTube — run `neon-cli youtube login` or sign in from the Render panel');
    const filePath = req.source.kind === 'file' ? this.deps.resolvePath(req.source.path) : null;
    if (filePath) await assertFile(filePath, 'video');
    const thumbnail = req.metadata.thumbnail ? this.deps.resolvePath(req.metadata.thumbnail) : null;
    if (thumbnail) {
      if (!THUMBNAIL_TYPES[extname(thumbnail).toLowerCase()]) throw new Error('thumbnail must be a .png or .jpg file');
      await assertFile(thumbnail, 'thumbnail');
    }
    const job: YouTubeUploadJob = {
      id: newId('yt'),
      status: req.source.kind === 'timeline' ? 'rendering' : 'uploading',
      title: req.metadata.title,
      privacy: req.metadata.privacy,
      renderJobId: null,
      filePath,
      progress: 0,
      bytesSent: 0,
      totalBytes: 0,
      videoId: null,
      url: null,
      warnings: [],
      error: null,
      startedAt: new Date().toISOString(),
      finishedAt: null,
    };
    const abort = new AbortController();
    this.jobs.set(job.id, job);
    this.running.set(job.id, { abort });
    let rendered: Promise<string> | null = null;
    if (req.source.kind === 'timeline') {
      const { job: render, finished } = this.deps.render({ presetId: req.source.preset, from: req.source.from, to: req.source.to });
      job.renderJobId = render.id;
      rendered = finished;
    }
    this.emit(job);
    void this.run(job, req.metadata, { rendered, thumbnail, signal: abort.signal });
    return { ...job };
  }

  /** Mirror render progress into the upload job that started it (called for every render update). */
  renderUpdated(render: RenderJob): void {
    for (const job of this.jobs.values()) {
      if (job.renderJobId === render.id && job.status === 'rendering') this.update(job, { progress: render.progress });
    }
  }

  cancel(id: string): YouTubeUploadJob | undefined {
    const job = this.jobs.get(id);
    if (!job) return undefined;
    const running = this.running.get(id);
    if (running) {
      running.abort.abort();
      if (job.status === 'rendering' && job.renderJobId) this.deps.cancelRender(job.renderJobId);
    }
    return { ...job };
  }

  shutdown(): void {
    this.cancelLogin();
    for (const id of [...this.running.keys()]) this.cancel(id);
  }

  // ---- internals ------------------------------------------------------------------------

  private requireClient(): OAuthClient {
    const client = this.deps.client();
    if (!client) {
      const auth = this.auth();
      throw new Error(auth.state === 'unconfigured' ? auth.hint : 'No OAuth client');
    }
    return client;
  }

  private cancelLogin(): void {
    if (!this.pending) return;
    clearTimeout(this.pending.timer);
    this.pending.server.close();
    this.pending = null;
  }

  private async exchangeCode(opts: { client: OAuthClient; code: string; verifier: string; redirectUri: string }): Promise<YouTubeChannel> {
    const res = await fetch(this.endpoints.token, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code: opts.code,
        client_id: opts.client.clientId,
        client_secret: opts.client.clientSecret,
        redirect_uri: opts.redirectUri,
        grant_type: 'authorization_code',
        code_verifier: opts.verifier,
      }),
    });
    if (!res.ok) throw await googleError(res, 'Google token exchange');
    const tokens = TokenResponseSchema.parse(await res.json());
    if (!tokens.refresh_token) throw new Error('Google returned no refresh token; remove Neon Video Studio at myaccount.google.com/permissions and sign in again');
    const accessToken = tokens.access_token;
    const channel = await this.fetchChannel(accessToken);
    const token: StoredToken = { clientId: opts.client.clientId, refreshToken: tokens.refresh_token, accessToken, expiresAt: Date.now() + tokens.expires_in * 1000, channel };
    await this.save(token);
    return channel;
  }

  private async fetchChannel(accessToken: string): Promise<YouTubeChannel> {
    const res = await fetch(`${this.endpoints.api}/channels?part=snippet&mine=true`, { headers: { Authorization: `Bearer ${accessToken}` } });
    if (!res.ok) throw await googleError(res, 'Reading your YouTube channel');
    const item = ChannelListSchema.parse(await res.json()).items[0];
    if (!item) throw new Error('This Google account has no YouTube channel yet — create one at youtube.com, then sign in again');
    return { id: item.id, title: item.snippet.title, handle: item.snippet.customUrl ?? null };
  }

  private async save(token: StoredToken): Promise<void> {
    this.token = token;
    await writeFile(this.deps.tokenFile, JSON.stringify(token, null, 2), { mode: 0o600 });
  }

  /** A valid access token, refreshed when it is within a minute of expiring (or `force`). */
  private async accessToken(force = false): Promise<string> {
    const token = this.token;
    const client = this.requireClient();
    if (!token || token.clientId !== client.clientId) throw new Error('Signed out of YouTube');
    if (!force && token.expiresAt - 60_000 > Date.now()) return token.accessToken;
    const res = await fetch(this.endpoints.token, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: client.clientId, client_secret: client.clientSecret, refresh_token: token.refreshToken, grant_type: 'refresh_token' }),
    });
    if (!res.ok) {
      const err = await googleError(res, 'Refreshing the YouTube sign-in');
      if (res.status === 400 || res.status === 401) {
        this.token = null;
        await rm(this.deps.tokenFile, { force: true });
        throw new Error(`${err.message} — sign in again`);
      }
      throw err;
    }
    const fresh = TokenResponseSchema.parse(await res.json());
    await this.save({ ...token, accessToken: fresh.access_token, expiresAt: Date.now() + fresh.expires_in * 1000, refreshToken: fresh.refresh_token ?? token.refreshToken });
    return fresh.access_token;
  }

  /** fetch with the bearer token; one forced refresh and retry on 401. */
  private async authed(url: string, init: Omit<RequestInit, 'headers'> & { headers?: Record<string, string> }): Promise<Response> {
    const send = async (token: string) => fetch(url, { ...init, headers: { ...init.headers, Authorization: `Bearer ${token}` } });
    const res = await send(await this.accessToken());
    if (res.status !== 401) return res;
    return send(await this.accessToken(true));
  }

  private async run(job: YouTubeUploadJob, metadata: YouTubeMetadata, opts: { rendered: Promise<string> | null; thumbnail: string | null; signal: AbortSignal }): Promise<void> {
    try {
      if (opts.rendered) {
        const output = await raceAbort(opts.rendered, opts.signal);
        this.update(job, { status: 'uploading', filePath: output, progress: 0 });
      }
      const filePath = job.filePath;
      if (!filePath) throw new Error('nothing to upload');
      const video = await this.uploadVideo(job, filePath, metadata, opts.signal);
      this.update(job, { status: 'finishing', videoId: video.id, url: youtubeWatchUrl(video.id), progress: 1 });
      const warnings = [...job.warnings];
      const statusUpdate = videoStatusUpdate(video.id, metadata);
      if (statusUpdate) {
        const warning = await this.updateStatus(statusUpdate, opts.signal);
        if (warning) warnings.push(warning);
      }
      if (opts.thumbnail) {
        const warning = await this.setThumbnail(video.id, opts.thumbnail, opts.signal);
        if (warning) warnings.push(warning);
      }
      if (metadata.playlistId) {
        const warning = await this.addToPlaylist(video.id, metadata.playlistId, opts.signal);
        if (warning) warnings.push(warning);
      }
      const got = video.status?.privacyStatus;
      if (got && got !== metadata.privacy) {
        warnings.push(`YouTube set the video to ${got}, not ${metadata.privacy}. Uploads through an unaudited Google Cloud project are locked to private until the project passes YouTube's API audit; change it in YouTube Studio.`);
      }
      if (video.status?.uploadStatus === 'rejected') warnings.push(`YouTube rejected the video: ${video.status.rejectionReason ?? 'no reason given'}`);
      this.update(job, { status: 'done', warnings, finishedAt: new Date().toISOString() });
    } catch (err) {
      const cancelled = opts.signal.aborted;
      this.update(job, { status: cancelled ? 'cancelled' : 'failed', error: cancelled ? null : err instanceof Error ? err.message : String(err), finishedAt: new Date().toISOString() });
    } finally {
      this.running.delete(job.id);
    }
  }

  /** The resumable protocol: open a session, PUT chunks, resume from the server's offset after errors. */
  private async uploadVideo(job: YouTubeUploadJob, filePath: string, metadata: YouTubeMetadata, signal: AbortSignal): Promise<z.infer<typeof VideoSchema>> {
    const size = (await stat(filePath)).size;
    if (size === 0) throw new Error(`${filePath} is empty`);
    this.update(job, { totalBytes: size, bytesSent: 0 });
    const query = new URLSearchParams({ uploadType: 'resumable', part: 'snippet,status', notifySubscribers: String(metadata.notifySubscribers) });
    const init = await this.authed(`${this.endpoints.upload}/videos?${query}`, {
      method: 'POST',
      signal,
      headers: { 'Content-Type': 'application/json; charset=UTF-8', 'X-Upload-Content-Length': String(size), 'X-Upload-Content-Type': 'video/*' },
      body: JSON.stringify(toVideoResource(metadata)),
    });
    if (!init.ok) throw await googleError(init, 'Starting the YouTube upload');
    const session = init.headers.get('location');
    if (!session) throw new Error('YouTube did not return an upload session');

    const file = await openFile(filePath, 'r');
    try {
      let offset = 0;
      let failures = 0;
      for (;;) {
        signal.throwIfAborted();
        let res: Response;
        try {
          const length = Math.min(CHUNK_BYTES, size - offset);
          const chunk = Buffer.alloc(length);
          const { bytesRead } = await file.read(chunk, 0, length, offset);
          if (bytesRead !== length) throw new Error(`${filePath} changed while uploading`);
          res = await this.authed(session, {
            method: 'PUT',
            signal,
            headers: { 'Content-Length': String(length), 'Content-Range': `bytes ${offset}-${offset + length - 1}/${size}` },
            body: chunk,
          });
        } catch (err) {
          if (signal.aborted || ++failures > MAX_RETRIES) throw err;
          await this.backoff(failures, signal);
          offset = await this.resumeOffset(session, size, signal);
          continue;
        }
        if (res.status === 200 || res.status === 201) {
          this.update(job, { bytesSent: size, progress: 1 });
          return VideoSchema.parse(await res.json());
        }
        if (res.status === 308) {
          await res.body?.cancel();
          offset = rangeEnd(res.headers.get('range'));
          failures = 0;
          this.update(job, { bytesSent: offset, progress: offset / size });
          continue;
        }
        if (res.status >= 500 && ++failures <= MAX_RETRIES) {
          await res.body?.cancel();
          await this.backoff(failures, signal);
          offset = await this.resumeOffset(session, size, signal);
          continue;
        }
        throw await googleError(res, 'Uploading to YouTube');
      }
    } finally {
      await file.close();
    }
  }

  /** Ask the session how much it has (Content-Range: bytes * /size). */
  private async resumeOffset(session: string, size: number, signal: AbortSignal): Promise<number> {
    const res = await this.authed(session, { method: 'PUT', signal, headers: { 'Content-Length': '0', 'Content-Range': `bytes */${size}` } });
    await res.body?.cancel();
    if (res.status === 308) return rangeEnd(res.headers.get('range'));
    if (res.status === 404 || res.status === 410) throw new Error('The YouTube upload session expired; start the upload again');
    throw await googleError(res, 'Resuming the YouTube upload');
  }

  private async backoff(attempt: number, signal: AbortSignal): Promise<void> {
    const ms = (this.deps.retryDelayMs ?? 1000) * 2 ** (attempt - 1);
    await raceAbort(new Promise((r) => setTimeout(r, ms)), signal);
  }

  private async setThumbnail(videoId: string, path: string, signal: AbortSignal): Promise<string | null> {
    try {
      const bytes = await readFile(path);
      const res = await this.authed(`${this.endpoints.upload}/thumbnails/set?videoId=${encodeURIComponent(videoId)}`, {
        method: 'POST',
        signal,
        headers: { 'Content-Type': THUMBNAIL_TYPES[extname(path).toLowerCase()] ?? 'image/png' },
        body: bytes,
      });
      if (!res.ok) return (await googleError(res, 'Setting the thumbnail')).message + ' (custom thumbnails need a phone-verified channel: youtube.com/verify)';
      await res.body?.cancel();
      return null;
    } catch (err) {
      if (signal.aborted) throw err;
      return `Setting the thumbnail failed: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  private async updateStatus(body: { id: string; status: Record<string, unknown> }, signal: AbortSignal): Promise<string | null> {
    try {
      const res = await this.authed(`${this.endpoints.api}/videos?part=status`, { method: 'PUT', signal, headers: { 'Content-Type': 'application/json; charset=UTF-8' }, body: JSON.stringify(body) });
      if (!res.ok) return (await googleError(res, 'Setting the license and embedding')).message;
      await res.body?.cancel();
      return null;
    } catch (err) {
      if (signal.aborted) throw err;
      return `Setting the license and embedding failed: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  private async addToPlaylist(videoId: string, playlistId: string, signal: AbortSignal): Promise<string | null> {
    try {
      const res = await this.authed(`${this.endpoints.api}/playlistItems?part=snippet`, {
        method: 'POST',
        signal,
        headers: { 'Content-Type': 'application/json; charset=UTF-8' },
        body: JSON.stringify({ snippet: { playlistId, resourceId: { kind: 'youtube#video', videoId } } }),
      });
      if (!res.ok) return (await googleError(res, `Adding the video to playlist ${playlistId}`)).message;
      await res.body?.cancel();
      return null;
    } catch (err) {
      if (signal.aborted) throw err;
      return `Adding the video to playlist ${playlistId} failed: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  private update(job: YouTubeUploadJob, patch: Partial<YouTubeUploadJob>): void {
    Object.assign(job, patch);
    this.emit(job);
  }

  private emit(job: YouTubeUploadJob): void {
    this.deps.onUpdate({ ...job, warnings: [...job.warnings] });
  }
}

/** Next byte to send after a 308: "bytes=0-12345" → 12346; no header → nothing stored yet. */
export function rangeEnd(header: string | null): number {
  const match = header ? /bytes=\d+-(\d+)/.exec(header) : null;
  return match ? Number(match[1]) + 1 : 0;
}

async function assertFile(path: string, what: string): Promise<void> {
  const s = await stat(path).catch(() => null);
  if (!s?.isFile()) throw new Error(`${what} ${path} not found`);
}

function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (v) => {
        signal.removeEventListener('abort', onAbort);
        resolve(v);
      },
      (e: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(e);
      },
    );
  });
}
