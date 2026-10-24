import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { YouTubeMetadataSchema, type RenderJob, type YouTubeUploadJob } from '@neon/core';
import { YouTubeManager, type GoogleEndpoints } from '../src/main/youtube.ts';

const CLIENT = { clientId: 'client-123.apps.googleusercontent.com', clientSecret: 'shh' };

/** Just enough of Google: OAuth token + revoke, channels.list, resumable videos.insert, thumbnails, playlistItems. */
async function fakeGoogle(opts: { failFirstChunk?: boolean; thumbnailStatus?: number; returnedPrivacy?: string } = {}) {
  const seen = {
    challenge: '',
    tokenGrants: [] as string[],
    videoResource: null as unknown,
    uploadQuery: '',
    uploadHeaders: {} as Record<string, string | string[] | undefined>,
    received: Buffer.alloc(0),
    statusQueries: 0,
    thumbnails: 0,
    playlistItems: [] as unknown[],
    revoked: [] as string[],
  };
  let failNext = opts.failFirstChunk ?? false;
  const body = (req: IncomingMessage) =>
    new Promise<Buffer>((resolve) => {
      const parts: Buffer[] = [];
      req.on('data', (c: Buffer) => parts.push(c));
      req.on('end', () => resolve(Buffer.concat(parts)));
    });
  const json = (res: ServerResponse, status: number, data: unknown, headers: Record<string, string> = {}) => {
    res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
    res.end(JSON.stringify(data));
  };
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    const raw = await body(req);
    if (req.method === 'POST' && url.pathname === '/token') {
      const form = new URLSearchParams(raw.toString());
      seen.tokenGrants.push(form.get('grant_type') ?? '');
      if (form.get('client_secret') !== CLIENT.clientSecret) return json(res, 401, { error: 'invalid_client' });
      if (form.get('grant_type') === 'authorization_code') {
        const verifier = form.get('code_verifier') ?? '';
        if (form.get('code') !== 'good-code' || createHash('sha256').update(verifier).digest('base64url') !== seen.challenge) return json(res, 400, { error: 'invalid_grant', error_description: 'bad code or verifier' });
        return json(res, 200, { access_token: 'at-1', expires_in: 3600, refresh_token: 'rt-1' });
      }
      return json(res, 200, { access_token: 'at-2', expires_in: 3600 });
    }
    if (req.method === 'POST' && url.pathname === '/revoke') {
      seen.revoked.push(url.searchParams.get('token') ?? '');
      return json(res, 200, {});
    }
    if (req.headers.authorization !== 'Bearer at-1' && req.headers.authorization !== 'Bearer at-2') return json(res, 401, { error: { message: 'Invalid Credentials' } });
    if (req.method === 'GET' && url.pathname === '/api/channels') {
      return json(res, 200, { items: [{ id: 'UC123', snippet: { title: 'Joe Lloyd Web Apps', customUrl: '@joelloydwebapps' } }] });
    }
    if (req.method === 'POST' && url.pathname === '/upload/videos') {
      seen.uploadQuery = url.search;
      seen.uploadHeaders = req.headers;
      seen.videoResource = JSON.parse(raw.toString());
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      res.writeHead(200, { Location: `http://127.0.0.1:${port}/session/abc` });
      return res.end();
    }
    if (req.method === 'PUT' && url.pathname === '/session/abc') {
      const range = String(req.headers['content-range'] ?? '');
      const total = Number(range.split('/')[1]);
      const sendRange = () => {
        const headers: Record<string, string> = seen.received.length ? { Range: `bytes=0-${seen.received.length - 1}` } : {};
        res.writeHead(308, headers);
        res.end();
      };
      if (range.startsWith('bytes */')) {
        seen.statusQueries++;
        return sendRange();
      }
      if (failNext) {
        failNext = false;
        return json(res, 503, { error: { message: 'backend error' } });
      }
      const start = Number(/bytes (\d+)-/.exec(range)?.[1]);
      assert.equal(start, seen.received.length, 'chunks arrive in order, resumed at the stored offset');
      seen.received = Buffer.concat([seen.received, raw]);
      if (seen.received.length < total) return sendRange();
      return json(res, 201, { id: 'vid123', status: { privacyStatus: opts.returnedPrivacy ?? 'unlisted', uploadStatus: 'uploaded' } });
    }
    if (req.method === 'POST' && url.pathname === '/upload/thumbnails/set') {
      seen.thumbnails++;
      if ((opts.thumbnailStatus ?? 200) !== 200) return json(res, opts.thumbnailStatus ?? 403, { error: { message: 'The authenticated user doesnt have permissions to upload and set custom video thumbnails.', errors: [{ reason: 'forbidden' }] } });
      return json(res, 200, {});
    }
    if (req.method === 'POST' && url.pathname === '/api/playlistItems') {
      seen.playlistItems.push(JSON.parse(raw.toString()));
      return json(res, 200, { id: 'pli1' });
    }
    json(res, 404, { error: { message: `no fake for ${req.method} ${url.pathname}` } });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const address = server.address();
  const base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
  const endpoints: GoogleEndpoints = { auth: `${base}/auth`, token: `${base}/token`, revoke: `${base}/revoke`, api: `${base}/api`, upload: `${base}/upload` };
  return { seen, endpoints, close: () => new Promise<void>((r) => server.close(() => r())) };
}

async function setup(google: Awaited<ReturnType<typeof fakeGoogle>>, render?: (job: RenderJob) => { job: RenderJob; finished: Promise<string> }) {
  const dir = await mkdtemp(join(tmpdir(), 'neon-yt-'));
  const updates: YouTubeUploadJob[] = [];
  const opened: string[] = [];
  const deps = {
    tokenFile: join(dir, 'youtube.json'),
    client: () => CLIENT,
    endpoints: google.endpoints,
    openBrowser: (url: string) => opened.push(url),
    render: () => {
      if (!render) throw new Error('no render in this test');
      return render({ id: 'render_1', status: 'queued', progress: 0, renderedFrames: 0, totalFrames: 0, outputPath: '', presetId: 'project', startedAt: '', log: [] });
    },
    cancelRender: () => undefined,
    resolvePath: (p: string) => (p.startsWith('/') ? p : join(dir, p)),
    onUpdate: (job: YouTubeUploadJob) => updates.push(job),
    retryDelayMs: 0,
  };
  const yt = new YouTubeManager(deps);
  await yt.load();
  return { dir, yt, deps, updates, opened, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

/** Play the browser: follow the consent URL's redirect back to the app's loopback listener. */
async function consent(authUrl: string, google: Awaited<ReturnType<typeof fakeGoogle>>, code = 'good-code'): Promise<Response> {
  const url = new URL(authUrl);
  google.seen.challenge = url.searchParams.get('code_challenge') ?? '';
  const redirect = new URL(url.searchParams.get('redirect_uri') ?? '');
  redirect.searchParams.set('code', code);
  redirect.searchParams.set('state', url.searchParams.get('state') ?? '');
  return fetch(redirect);
}

async function finished(yt: YouTubeManager, id: string): Promise<YouTubeUploadJob> {
  for (let i = 0; i < 400; i++) {
    const job = yt.get(id);
    if (job && (job.status === 'done' || job.status === 'failed' || job.status === 'cancelled')) return job;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('upload did not finish');
}

test('sign-in: consent URL asks for offline YouTube access with PKCE, and the redirect signs the channel in', async () => {
  const google = await fakeGoogle();
  const { yt, opened, deps, cleanup } = await setup(google);
  try {
    assert.deepEqual(yt.auth(), { state: 'signed-out' });
    const { authUrl } = await yt.login({ open: true });
    assert.deepEqual(opened, [authUrl]);
    const url = new URL(authUrl);
    assert.equal(url.origin + url.pathname, google.endpoints.auth);
    assert.equal(url.searchParams.get('client_id'), CLIENT.clientId);
    assert.equal(url.searchParams.get('access_type'), 'offline');
    assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
    assert.equal(url.searchParams.get('scope'), 'https://www.googleapis.com/auth/youtube.upload https://www.googleapis.com/auth/youtube');
    assert.match(url.searchParams.get('redirect_uri') ?? '', /^http:\/\/127\.0\.0\.1:\d+$/);
    assert.deepEqual(yt.auth(), { state: 'pending', authUrl });

    const page = await consent(authUrl, google);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /Signed in to YouTube as <b>Joe Lloyd Web Apps<\/b>/);
    assert.deepEqual(yt.auth(), { state: 'signed-in', channel: { id: 'UC123', title: 'Joe Lloyd Web Apps', handle: '@joelloydwebapps' } });
    assert.equal(yt.lastLoginError(), null);

    // The refresh token survives a restart, and only the owner can read the file.
    assert.equal((await stat(deps.tokenFile)).mode & 0o777, 0o600);
    const restarted = new YouTubeManager(deps);
    await restarted.load();
    assert.equal(restarted.auth().state, 'signed-in');

    assert.deepEqual(await yt.logout(), { state: 'signed-out' });
    assert.deepEqual(google.seen.revoked, ['rt-1']);
    await assert.rejects(stat(deps.tokenFile), /ENOENT/);
  } finally {
    await cleanup();
    await google.close();
  }
});

test('sign-in: a wrong state is ignored and a refused code reports why', async () => {
  const google = await fakeGoogle();
  const { yt, cleanup } = await setup(google);
  try {
    const { authUrl } = await yt.login({ open: false });
    const redirect = new URL(new URL(authUrl).searchParams.get('redirect_uri') ?? '');
    redirect.search = '?code=good-code&state=forged';
    assert.equal((await fetch(redirect)).status, 404);
    assert.equal(yt.auth().state, 'pending');

    const page = await consent(authUrl, google, 'bad-code');
    assert.equal(page.status, 400);
    assert.equal(yt.auth().state, 'signed-out');
    assert.equal(yt.lastLoginError(), 'Google token exchange failed (HTTP 400): invalid_grant: bad code or verifier');
  } finally {
    await cleanup();
    await google.close();
  }
});

test('upload: metadata becomes the video resource, the file streams in resumable chunks, a 503 resumes, warnings are kept', async () => {
  const google = await fakeGoogle({ failFirstChunk: true, thumbnailStatus: 403, returnedPrivacy: 'private' });
  const { yt, dir, updates, cleanup } = await setup(google);
  try {
    await consent((await yt.login({ open: false })).authUrl, google);
    const video = randomBytes(20 * 1024 * 1024 + 123);
    await writeFile(join(dir, 'out.mp4'), video);
    await writeFile(join(dir, 'thumb.png'), Buffer.from('png'));
    const metadata = YouTubeMetadataSchema.parse({
      title: 'Neon Video Studio in 60 seconds',
      description: 'What it does.',
      tags: ['video editor', 'typescript'],
      privacy: 'unlisted',
      madeForKids: false,
      containsSyntheticMedia: true,
      language: 'en',
      notifySubscribers: false,
      playlistId: 'PL1',
      thumbnail: 'thumb.png',
    });
    const job = await yt.upload({ source: { kind: 'file', path: 'out.mp4' }, metadata });
    assert.equal(job.status, 'uploading');
    const done = await finished(yt, job.id);

    assert.equal(done.status, 'done', done.error ?? '');
    assert.equal(done.videoId, 'vid123');
    assert.equal(done.url, 'https://youtu.be/vid123');
    assert.equal(done.bytesSent, video.length);
    assert.ok(google.seen.received.equals(video), 'YouTube received the exact file');
    assert.equal(google.seen.statusQueries, 1, 'the failed chunk was resumed by asking for the stored range');
    assert.equal(google.seen.uploadQuery, '?uploadType=resumable&part=snippet%2Cstatus&notifySubscribers=false');
    assert.equal(google.seen.uploadHeaders['x-upload-content-length'], String(video.length));
    assert.deepEqual(google.seen.videoResource, {
      snippet: { title: 'Neon Video Studio in 60 seconds', description: 'What it does.', tags: ['video editor', 'typescript'], categoryId: '28', defaultLanguage: 'en', defaultAudioLanguage: 'en' },
      status: { privacyStatus: 'unlisted', selfDeclaredMadeForKids: false, containsSyntheticMedia: true, license: 'youtube', embeddable: true },
    });
    assert.deepEqual(google.seen.playlistItems, [{ snippet: { playlistId: 'PL1', resourceId: { kind: 'youtube#video', videoId: 'vid123' } } }]);
    assert.equal(google.seen.thumbnails, 1);
    assert.deepEqual(done.warnings, [
      "Setting the thumbnail failed (HTTP 403): The authenticated user doesnt have permissions to upload and set custom video thumbnails. (forbidden) (custom thumbnails need a phone-verified channel: youtube.com/verify)",
      "YouTube set the video to private, not unlisted. Uploads through an unaudited Google Cloud project are locked to private until the project passes YouTube's API audit; change it in YouTube Studio.",
    ]);
    const progress = updates.filter((u) => u.id === job.id && u.status === 'uploading').map((u) => u.bytesSent);
    assert.ok(progress.includes(8 * 1024 * 1024) && progress.includes(16 * 1024 * 1024), `progress reported per chunk: ${progress.join(',')}`);
  } finally {
    await cleanup();
    await google.close();
  }
});

test('upload: source "timeline" renders first, mirrors render progress, then uploads the render', async () => {
  const google = await fakeGoogle();
  let finishRender: (path: string) => void = () => undefined;
  const { yt, dir, cleanup } = await setup(google, (job) => ({ job, finished: new Promise<string>((r) => (finishRender = r)) }));
  try {
    await consent((await yt.login({ open: false })).authUrl, google);
    const job = await yt.upload({ source: { kind: 'timeline', preset: 'project' }, metadata: YouTubeMetadataSchema.parse({ title: 'Rendered', madeForKids: false }) });
    assert.equal(job.status, 'rendering');
    assert.equal(job.renderJobId, 'render_1');
    yt.renderUpdated({ id: 'render_1', status: 'rendering', progress: 0.5, renderedFrames: 50, totalFrames: 100, outputPath: '', presetId: 'project', startedAt: '', log: [] });
    assert.equal(yt.get(job.id)?.progress, 0.5);

    const out = join(dir, 'render.mp4');
    await writeFile(out, Buffer.from('tiny video'));
    finishRender(out);
    const done = await finished(yt, job.id);
    assert.equal(done.status, 'done', done.error ?? '');
    assert.equal(done.filePath, out);
    assert.equal(google.seen.received.toString(), 'tiny video');
  } finally {
    await cleanup();
    await google.close();
  }
});

test('upload: refused before any network call when signed out or a file is missing', async () => {
  const google = await fakeGoogle();
  const { yt, cleanup } = await setup(google);
  try {
    const metadata = YouTubeMetadataSchema.parse({ title: 'x', madeForKids: false });
    await assert.rejects(yt.upload({ source: { kind: 'file', path: 'nope.mp4' }, metadata }), /Not signed in to YouTube/);
    await consent((await yt.login({ open: false })).authUrl, google);
    await assert.rejects(yt.upload({ source: { kind: 'file', path: 'nope.mp4' }, metadata }), /video .*nope\.mp4 not found/);
    assert.equal(google.seen.uploadQuery, '');
  } finally {
    await cleanup();
    await google.close();
  }
});

test('metadata: YouTube limits are enforced at the boundary', () => {
  const base = { title: 'ok', madeForKids: false };
  assert.equal(YouTubeMetadataSchema.safeParse({ ...base, title: 'a'.repeat(101) }).success, false);
  assert.equal(YouTubeMetadataSchema.safeParse({ ...base, title: 'a <b>' }).success, false);
  assert.equal(YouTubeMetadataSchema.safeParse({ title: 'no kids answer' }).success, false);
  assert.equal(YouTubeMetadataSchema.safeParse({ ...base, tags: Array.from({ length: 60 }, (_, i) => `tag number ${i}`) }).success, false);
  assert.equal(YouTubeMetadataSchema.safeParse({ ...base, categoryId: '99' }).success, false);
  const scheduled = YouTubeMetadataSchema.safeParse({ ...base, privacy: 'public', publishAt: '2026-11-01T09:00:00Z' });
  assert.equal(scheduled.success, false);
  assert.equal(YouTubeMetadataSchema.safeParse({ ...base, privacy: 'private', publishAt: '2026-11-01T09:00:00Z' }).success, true);
});
