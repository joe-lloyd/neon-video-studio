/**
 * HTTP + WebSocket servers (Bun.serve).
 *
 *  local (127.0.0.1, random port, bearer token)   → /api/* · /yjs · /signaling · /assets/:hash
 *  lan   (0.0.0.0, only while hosting a room)     → /yjs?room= · /signaling?room= · /assets/:hash?room= · /room
 */
import type { Server, ServerWebSocket } from 'bun';
import { basename } from 'node:path';
import {
  ZodError,
  API_ROUTES,
  AddTrackRequestSchema,
  ImportAssetRequestSchema,
  InsertClipRequestSchema,
  MoveClipRequestSchema,
  ORIGIN_API,
  ProjectNewRequestSchema,
  ProjectOpenRequestSchema,
  ProjectSaveRequestSchema,
  PreviewControlRequestSchema,
  UiControlRequestSchema,
  CutRangesRequestSchema,
  AiTranscribeRequestSchema,
  AiFillersRequestSchema,
  AiSilenceRequestSchema,
  AiBreathsRequestSchema,
  AiDenoiseRequestSchema,
  AiEnhanceRequestSchema,
  AiSetupRequestSchema,
  AiRipRequestSchema,
  DetachAudioRequestSchema,
  AiMatteRequestSchema,
  AiReframeRequestSchema,
  AiBrollRequestSchema,
  AiCleanRequestSchema,
  TranscriptCutRequestSchema,
  type AiOperation,
  RENDER_PRESETS,
  RemoveClipRequestSchema,
  RenderRequestSchema,
  RoomHostRequestSchema,
  RoomJoinRequestSchema,
  SplitClipRequestSchema,
  UpdateClipRequestSchema,
  UpdateMetaRequestSchema,
  UpdateTrackRequestSchema,
  listTemplates,
  parseTimecode,
  framesToTimecode,
  projectPreset,
  templateDefaults,
  templateJsonSchema,
  type ApiResult,
  type AppStatus,
  type InsertClipInput,
  type ListResponse,
} from '@neon/core';
import { mediaTypeForFile } from '@neon/core/node';
import { parseRange } from '@neon/render';
import type { SignalSocket, SyncSocket } from '@neon/p2p/server';
import { ffprobeAvailable } from './assets.ts';
import type { MainContext } from './context.ts';
import { sseFrame } from './events.ts';
import { ProjectStore } from './project-store.ts';

type Scope = 'local' | 'lan';
interface WsData {
  kind: 'yjs' | 'signaling';
  sock: SyncSocket & SignalSocket;
  attached: boolean;
}

const CORS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type',
};

class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function json<T>(result: ApiResult<T>, status = 200): Response {
  return new Response(JSON.stringify(result), { status, headers: { 'Content-Type': 'application/json', ...CORS } });
}

function ok<T>(data: T): Response {
  return json({ ok: true, data });
}

function fail(err: unknown): Response {
  if (err instanceof HttpError) return json({ ok: false, error: { code: err.code, message: err.message } }, err.status);
  if (err instanceof ZodError) {
    const message = err.issues.map((i: { path: PropertyKey[]; message: string }) => `${i.path.map(String).join('.') || '(body)'}: ${i.message}`).join('; ');
    return json({ ok: false, error: { code: 'VALIDATION', message, details: err.issues } }, 400);
  }
  const message = err instanceof Error ? err.message : String(err);
  const status = /not found/i.test(message) ? 404 : 400;
  return json({ ok: false, error: { code: status === 404 ? 'NOT_FOUND' : 'BAD_REQUEST', message } }, status);
}

export interface RunningServer {
  port: number;
  stop(): void;
}

export async function startControlServer(ctx: MainContext): Promise<RunningServer> {
  return start(ctx, 'local', '127.0.0.1', Number(process.env.NEON_PORT ?? 0), null);
}

export async function startLanServer(ctx: MainContext, roomCode: string): Promise<RunningServer> {
  return start(ctx, 'lan', '0.0.0.0', 0, roomCode);
}

async function start(ctx: MainContext, scope: Scope, hostname: string, port: number, roomCode: string | null): Promise<RunningServer> {
  const yjsSockets = new Set<ServerWebSocket<WsData>>();
  const unbind = ctx.sync.onRebind(() => {
    for (const ws of yjsSockets) ws.close(4000, 'project switched');
    yjsSockets.clear();
  });

  const authorized = (req: Request, url: URL): boolean => {
    if (scope === 'lan') {
      const room = url.searchParams.get('room');
      return room !== null && roomCode !== null && room.replace(/[^A-Z0-9]/gi, '').toUpperCase() === roomCode.replace(/-/g, '');
    }
    const header = req.headers.get('authorization');
    const token = header?.startsWith('Bearer ') ? header.slice(7) : url.searchParams.get('token');
    return token === ctx.token;
  };

  const server: Server<WsData> = Bun.serve<WsData>({
    hostname,
    port,
    idleTimeout: 120,
    async fetch(req, srv) {
      const url = new URL(req.url);
      const path = url.pathname.replace(/\/+$/, '') || '/';
      if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

      try {
        // -- assets (content addressed; local = loopback only, lan = room key) -------------
        const asset = /^\/assets\/([a-f0-9]{64})$/.exec(path);
        if (asset) {
          if (scope === 'lan' && !authorized(req, url)) return new Response('forbidden', { status: 403 });
          return await serveAsset(ctx, asset[1]!, req);
        }

        if (path === '/room') {
          if (!authorized(req, url)) return json({ ok: false, error: { code: 'FORBIDDEN', message: 'wrong room' } }, 403);
          return ok({ room: roomCode ?? 'local', name: ctx.settings.peerName, project: ctx.store.doc.isInitialized ? ctx.store.doc.getMeta().name : null });
        }

        // -- websockets --------------------------------------------------------------------
        if (path === API_ROUTES.yjs || path === API_ROUTES.signaling) {
          if (!authorized(req, url)) return new Response('unauthorized', { status: 401 });
          if (path === API_ROUTES.yjs && scope === 'local') {
            const docId = url.searchParams.get('doc');
            if (docId && docId !== ctx.store.projectId) return new Response('stale document', { status: 409 });
          }
          const kind = path === API_ROUTES.yjs ? 'yjs' : 'signaling';
          const upgraded = srv.upgrade(req, { data: { kind, sock: null as unknown as WsData['sock'], attached: false } });
          return upgraded ? undefined : new Response('upgrade failed', { status: 400 });
        }

        // -- control API (local only) ------------------------------------------------------
        if (path.startsWith('/api/')) {
          if (scope === 'lan') return new Response('not found', { status: 404 });
          if (!authorized(req, url)) throw new HttpError(401, 'UNAUTHORIZED', 'Missing or invalid bearer token');
          if (path === API_ROUTES.events && req.method === 'GET') return eventStream(ctx, req, url);
          // Binary media upload (voice-over recordings, agent-generated files):
          //   POST /api/assets/upload?name=take.m4a[&at=frames][&track=id] with the file as the body.
          if (path === API_ROUTES.assetsUpload && req.method === 'POST') {
            const name = (url.searchParams.get('name') ?? 'upload.bin').replace(/[^\w.\- ]/g, '_');
            const at = url.searchParams.get('at');
            const trackId = url.searchParams.get('track') ?? undefined;
            const { mkdtemp: mkTmp, rm: rmTmp, writeFile: writeTmp } = await import('node:fs/promises');
            const { tmpdir: osTmp } = await import('node:os');
            const { join: joinPath } = await import('node:path');
            const dir = await mkTmp(joinPath(osTmp(), 'neon-upload-'));
            try {
              const file = joinPath(dir, name);
              await writeTmp(file, new Uint8Array(await req.arrayBuffer()));
              const result = await ctx.assets.import(file, {
                insertAt: at !== null ? Math.max(0, Math.round(Number(at))) : undefined,
                trackId,
                origin: ORIGIN_API,
              });
              ctx.events.activity('ui', 'assets.upload', `Recorded/uploaded “${result.asset.name}”${result.clip ? ` and placed it at frame ${result.clip.startFrame}` : ''}`, { assetIds: [result.asset.id], clipIds: result.clip ? [result.clip.id] : [] });
              return ok(result);
            } finally {
              await rmTmp(dir, { recursive: true, force: true }).catch(() => undefined);
            }
          }
          const body = req.method === 'POST' ? ((await req.json().catch(() => ({}))) as unknown) : {};
          const result = await handleApi(ctx, req.method, path, body);
          if (req.method === 'POST') recordActivity(ctx, path, body, result);
          return ok(result);
        }

        return new Response('Neon Video Studio control server', { status: 404, headers: CORS });
      } catch (err) {
        return fail(err);
      }
    },
    websocket: {
      open(ws) {
        const sock: WsData['sock'] = {
          send: (data: Uint8Array | string) => {
            ws.send(data);
          },
          close: (code?: number, reason?: string) => ws.close(code, reason),
        };
        ws.data.sock = sock;
        ws.data.attached = true;
        if (ws.data.kind === 'yjs') {
          yjsSockets.add(ws);
          ctx.sync.sync.onOpen(sock);
        } else {
          ctx.sync.signaling.onOpen(sock);
        }
      },
      message(ws, message) {
        if (!ws.data.attached) return;
        if (ws.data.kind === 'yjs') {
          const bytes = typeof message === 'string' ? new TextEncoder().encode(message) : new Uint8Array(message);
          ctx.sync.sync.onMessage(ws.data.sock, bytes);
        } else {
          ctx.sync.signaling.onMessage(ws.data.sock, typeof message === 'string' ? message : new Uint8Array(message));
        }
      },
      close(ws) {
        if (!ws.data.attached) return;
        ws.data.attached = false;
        if (ws.data.kind === 'yjs') {
          yjsSockets.delete(ws);
          ctx.sync.sync.onClose(ws.data.sock);
        } else {
          ctx.sync.signaling.onClose(ws.data.sock);
        }
      },
    },
  });

  console.log(`[server] ${scope} listening on ${hostname}:${server.port}`);
  return {
    port: server.port ?? port,
    stop() {
      unbind();
      for (const ws of yjsSockets) ws.close(1001, 'server stopping');
      server.stop(true);
    },
  };
}

async function serveAsset(ctx: MainContext, hash: string, req: Request): Promise<Response> {
  const file = await ctx.assets.resolveFile(hash);
  if (!file) return new Response('asset not found', { status: 404, headers: CORS });
  const bunFile = Bun.file(file);
  const size = bunFile.size;
  const mime = mediaTypeForFile(file)?.mime ?? ctx.store.doc.getAsset(hash)?.mime ?? 'application/octet-stream';
  const headers: Record<string, string> = {
    ...CORS,
    'Content-Type': mime,
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'public, max-age=31536000, immutable',
    'Content-Disposition': `inline; filename="${basename(file)}"`,
  };
  const range = parseRange(req.headers.get('range') ?? undefined, size);
  if (range && range.start === -1) return new Response(null, { status: 416, headers: { ...headers, 'Content-Range': `bytes */${size}` } });
  if (range) {
    headers['Content-Range'] = `bytes ${range.start}-${range.end}/${size}`;
    headers['Content-Length'] = String(range.end - range.start + 1);
    return new Response(req.method === 'HEAD' ? null : bunFile.slice(range.start, range.end + 1), { status: 206, headers });
  }
  headers['Content-Length'] = String(size);
  return new Response(req.method === 'HEAD' ? null : bunFile, { status: 200, headers });
}

// ---- control API -----------------------------------------------------------------------

export async function buildStatus(ctx: MainContext): Promise<AppStatus> {
  const doc = ctx.store.doc;
  const project = doc.toJSON();
  return {
    app: 'neon-video-studio',
    version: ctx.version,
    apiVersion: 1,
    pid: process.pid,
    uptimeSeconds: Math.round((Date.now() - ctx.startedAt) / 1000),
    project: {
      id: project.meta.id,
      name: project.meta.name,
      path: ctx.store.isScratch ? null : ctx.store.dir,
      dirty: ctx.store.dirty,
      fps: project.meta.fps,
      width: project.meta.width,
      height: project.meta.height,
      durationFrames: doc.durationFrames(),
      tracks: project.tracks.length,
      clips: project.clips.length,
      assets: project.assets.length,
    },
    room: ctx.room.info(),
    renders: ctx.renders.list(),
    capabilities: { ffprobe: await ffprobeAvailable(), node: true, renderRuntime: process.env.NEON_RENDER_RUNTIME === 'node' ? 'node' : `bun ${Bun.version} (bundled)` },
  };
}

async function handleApi(ctx: MainContext, method: string, path: string, body: unknown): Promise<unknown> {
  const doc = ctx.store.doc;
  const fps = doc.fps;
  const T = (v: string | number | undefined): number | undefined => (v === undefined ? undefined : parseTimecode(v, fps));
  const key = `${method} ${path}`;

  // AI routes.
  if (key === `GET ${API_ROUTES.aiStatus}`) return ctx.ai.capabilities(true);
  if (key === `GET ${API_ROUTES.aiJobs}`) return ctx.ai.list();
  const aiJob = /^(GET|POST) \/api\/ai\/jobs\/([^/]+)(\/cancel)?$/.exec(key);
  if (aiJob) {
    const id = decodeURIComponent(aiJob[2]!);
    const job = ctx.ai.get(id);
    if (!job) throw new HttpError(404, 'NOT_FOUND', `AI job ${id} not found`);
    return aiJob[3] ? ctx.ai.cancel(id) : job;
  }
  const transcriptGet = /^GET \/api\/ai\/transcript\/([a-f0-9]+)$/.exec(key);
  if (transcriptGet) {
    const ref = transcriptGet[1]!;
    const asset = doc.toJSON().assets.find((a) => a.id === ref || a.id.startsWith(ref));
    const t = asset ? doc.getTranscript(asset.id) : undefined;
    if (!t) throw new HttpError(404, 'NOT_FOUND', 'No transcript for that asset (run ai transcribe first)');
    return t;
  }
  if (key === `POST ${API_ROUTES.aiTranscript}/cut`) return ctx.ai.start('transcript-cut', TranscriptCutRequestSchema.parse(body));
  const aiOp = /^POST \/api\/ai\/(transcribe|fillers|silence|breaths|denoise|enhance|matte|reframe|broll|clean|setup|rip)$/.exec(key);
  if (aiOp) {
    const op = aiOp[1] as AiOperation;
    const schemas: Record<string, { parse(v: unknown): unknown }> = {
      transcribe: AiTranscribeRequestSchema,
      fillers: AiFillersRequestSchema,
      silence: AiSilenceRequestSchema,
      breaths: AiBreathsRequestSchema,
      denoise: AiDenoiseRequestSchema,
      enhance: AiEnhanceRequestSchema,
      setup: AiSetupRequestSchema,
      rip: AiRipRequestSchema,
      matte: AiMatteRequestSchema,
      reframe: AiReframeRequestSchema,
      broll: AiBrollRequestSchema,
      clean: AiCleanRequestSchema,
    };
    const parsed = schemas[op]!.parse(body) as Record<string, unknown>;
    if (op === 'rip' && parsed.at !== undefined) parsed.at = parseTimecode(parsed.at as string | number, fps);
    // Accept clip references by name or prefix like the rest of the CLI.
    if (typeof parsed.clipId === 'string') {
      const clips = doc.toJSON().clips;
      const ref = parsed.clipId;
      const clip = clips.find((c) => c.id === ref) ?? clips.find((c) => c.id.startsWith(ref)) ?? clips.find((c) => c.name.toLowerCase() === ref.toLowerCase());
      if (!clip) throw new HttpError(404, 'NOT_FOUND', `Clip ${ref} not found`);
      parsed.clipId = clip.id;
    }
    return ctx.ai.start(op, parsed);
  }
  if (key === 'POST /api/record/start') {
    const r = await ctx.recorder.start();
    ctx.events.activity('cli', 'vo.start', `Recording voice-over (${r.device})`);
    return { ...r, state: ctx.recorder.state() };
  }
  if (key === 'POST /api/record/stop') {
    const at = Number((body as { at?: number | string })?.at ?? 0);
    const startFrame = Number.isFinite(at) ? Math.max(0, Math.round(at)) : parseTimecode(String((body as { at?: string }).at ?? '0'), fps);
    const { file } = await ctx.recorder.stop();
    let track = doc.toJSON().tracks.find((t) => t.kind === 'audio' && t.name === 'VO');
    track ??= doc.addTrack('audio', 'VO', ORIGIN_API);
    const result = await ctx.assets.import(file, { insertAt: startFrame, trackId: track.id, origin: ORIGIN_API });
    await ctx.recorder.discard();
    ctx.events.activity('cli', 'vo.done', `Voice-over take placed on ${track.name} at frame ${startFrame}`, { clipIds: result.clip ? [result.clip.id] : [] });
    return result;
  }
  if (key === 'GET /api/record/state') return ctx.recorder.state();
  if (key === `POST ${API_ROUTES.timelineDetach}`) {
    const { id } = DetachAudioRequestSchema.parse(body);
    return doc.detachAudio(id, ORIGIN_API);
  }
  if (key === `POST ${API_ROUTES.timelineCut}`) {
    const req = CutRangesRequestSchema.parse(body);
    const ranges = req.ranges.map((r) => ({ start: T(r.start)!, end: T(r.end)! }));
    return doc.cutRanges(ranges, { trackIds: req.trackIds, ripple: req.ripple, crossfadeFrames: req.crossfadeFrames }, ORIGIN_API);
  }

  // Dynamic render routes.
  const renderMatch = /^(GET|POST) \/api\/render\/([^/]+)(\/cancel)?$/.exec(key);
  if (renderMatch) {
    const id = decodeURIComponent(renderMatch[2]!);
    const job = ctx.renders.get(id);
    if (!job) throw new HttpError(404, 'NOT_FOUND', `Render job ${id} not found`);
    if (renderMatch[3]) return ctx.renders.cancel(id);
    return job;
  }

  switch (key) {
    case `GET ${API_ROUTES.status}`:
      return buildStatus(ctx);

    case `GET ${API_ROUTES.list}`: {
      const project = doc.toJSON();
      const list: ListResponse = {
        templates: listTemplates().map((t) => ({
          name: t.name,
          label: t.label,
          description: t.description,
          defaultDurationSeconds: t.defaultDurationSeconds,
          defaults: templateDefaults(t.name),
          jsonSchema: templateJsonSchema(t.name),
        })),
        tracks: project.tracks,
        clips: project.clips,
        assets: project.assets,
        presets: [projectPreset(project.meta), ...RENDER_PRESETS].map((p) => ({ id: p.id, label: p.label, width: p.width, height: p.height, fps: p.fps })),
      };
      return list;
    }

    case `GET ${API_ROUTES.state}`:
      return { project: doc.toJSON(), durationFrames: doc.durationFrames() };

    case `POST ${API_ROUTES.meta}`: {
      const patch = UpdateMetaRequestSchema.parse(body);
      doc.updateMeta(patch, ORIGIN_API);
      return doc.getMeta();
    }

    case `POST ${API_ROUTES.projectNew}`: {
      const req = ProjectNewRequestSchema.parse(body);
      const fresh = await ProjectStore.create(req);
      await ctx.store.adopt(fresh);
      return { path: ctx.store.isScratch ? null : ctx.store.dir, project: ctx.store.toJSON() };
    }

    case `POST ${API_ROUTES.projectOpen}`: {
      const { path } = ProjectOpenRequestSchema.parse(body);
      const opened = await ProjectStore.openDir(path);
      await ctx.store.adopt(opened);
      return { path: ctx.store.dir, project: ctx.store.toJSON() };
    }

    case `POST ${API_ROUTES.projectSave}`: {
      const { path } = ProjectSaveRequestSchema.parse(body);
      const saved = path ? await ctx.store.saveAs(path) : await ctx.store.save();
      return { path: saved };
    }

    case `POST ${API_ROUTES.timelineInsert}`: {
      const req = InsertClipRequestSchema.parse(body);
      const input: InsertClipInput =
        req.kind === 'component'
          ? {
              kind: 'component',
              componentName: req.componentName,
              props: req.props,
              startFrame: T(req.at),
              durationFrames: T(req.duration),
              trackId: req.trackId,
              name: req.name,
              placement: req.placement,
            }
          : {
              kind: req.kind,
              assetId: req.assetId,
              startFrame: T(req.at),
              durationFrames: T(req.duration),
              trimBefore: T(req.trimBefore),
              trackId: req.trackId,
              name: req.name,
              volume: req.volume,
              placement: req.placement,
            };
      return doc.insertClip(input, ORIGIN_API);
    }

    case `POST ${API_ROUTES.timelineUpdate}`: {
      const { id, patch } = UpdateClipRequestSchema.parse(body);
      return doc.updateClip(
        id,
        {
          name: patch.name,
          startFrame: T(patch.startFrame),
          durationFrames: T(patch.durationFrames),
          trimBefore: T(patch.trimBefore),
          volume: patch.volume,
          fit: patch.fit,
          fadeIn: T(patch.fadeIn),
          fadeOut: T(patch.fadeOut),
          trackId: patch.trackId,
          color: patch.color,
          props: patch.props,
          transform: patch.transform,
          animateIn: patch.animateIn,
          animateOut: patch.animateOut,
          volumeKeyframes: patch.volumeKeyframes,
          reframe: patch.reframe,
        },
        ORIGIN_API,
      );
    }

    case `POST ${API_ROUTES.timelineMove}`: {
      const { id, at, trackId } = MoveClipRequestSchema.parse(body);
      return doc.moveClip(id, T(at)!, trackId, ORIGIN_API);
    }

    case `POST ${API_ROUTES.timelineSplit}`: {
      const { id, at } = SplitClipRequestSchema.parse(body);
      return doc.splitClip(id, T(at)!, ORIGIN_API);
    }

    case `POST ${API_ROUTES.timelineRemove}`: {
      const { ids } = RemoveClipRequestSchema.parse(body);
      doc.removeClips(ids, ORIGIN_API);
      return { removed: ids.length };
    }

    case `POST ${API_ROUTES.trackAdd}`: {
      const { kind, name } = AddTrackRequestSchema.parse(body);
      return doc.addTrack(kind, name, ORIGIN_API);
    }

    case `POST ${API_ROUTES.trackUpdate}`: {
      const { id, patch } = UpdateTrackRequestSchema.parse(body);
      doc.updateTrack(id, patch, ORIGIN_API);
      return doc.getTrack(id);
    }

    case `POST ${API_ROUTES.trackRemove}`: {
      const { id } = (body ?? {}) as { id?: string };
      if (!id) throw new HttpError(400, 'VALIDATION', 'id is required');
      doc.removeTrack(id, ORIGIN_API);
      return { removed: id };
    }

    case `POST ${API_ROUTES.assetsImport}`: {
      const req = ImportAssetRequestSchema.parse(body);
      return ctx.assets.import(req.path, { insertAt: T(req.insert?.at), trackId: req.insert?.trackId, origin: ORIGIN_API });
    }

    case `POST ${API_ROUTES.assetsRemove}`: {
      const { id } = (body ?? {}) as { id?: string };
      if (!id) throw new HttpError(400, 'VALIDATION', 'id is required');
      doc.removeAsset(id, ORIGIN_API);
      return { removed: id };
    }

    case `POST ${API_ROUTES.render}`: {
      const req = RenderRequestSchema.parse(body);
      const from = T(req.from);
      const to = T(req.to);
      const frameRange: [number, number] | null = from !== undefined || to !== undefined ? [from ?? 0, to ?? Math.max(0, doc.durationFrames() - 1)] : null;
      return ctx.renders.start({ outputPath: req.output, presetId: req.preset, frameRange });
    }

    case `POST ${API_ROUTES.preview}`: {
      const req = PreviewControlRequestSchema.parse(body);
      const frame = T(req.at);
      ctx.rpc?.send.previewControl({ action: req.action, frame });
      return { action: req.action, frame: frame ?? null };
    }

    case `POST ${API_ROUTES.ui}`: {
      const req = UiControlRequestSchema.parse(body);
      ctx.rpc?.send.uiControl(req);
      return req;
    }

    case `POST ${API_ROUTES.roomHost}`: {
      const { password } = RoomHostRequestSchema.parse(body);
      return ctx.room.host(password);
    }
    case `POST ${API_ROUTES.roomJoin}`: {
      const req = RoomJoinRequestSchema.parse(body);
      return ctx.room.join(req);
    }
    case `POST ${API_ROUTES.roomLeave}`:
      return ctx.room.leave();

    default:
      throw new HttpError(404, 'NOT_FOUND', `No route ${key}`);
  }
}


// ---- live events (SSE) --------------------------------------------------------------------

function eventStream(ctx: MainContext, req: Request, url: URL): Response {
  const history = Math.min(200, Math.max(0, Number(url.searchParams.get('history') ?? 20)));
  let unsubscribe: (() => void) | null = null;
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const enc = new TextEncoder();
      const push = (frame: string) => {
        try {
          controller.enqueue(enc.encode(frame));
        } catch {
          cleanup();
        }
      };
      const cleanup = () => {
        unsubscribe?.();
        unsubscribe = null;
        if (heartbeat) clearInterval(heartbeat);
        heartbeat = null;
      };
      push(': neon-video-studio events\n\n');
      for (const entry of ctx.events.recent(history)) push(sseFrame({ type: 'activity', entry }));
      unsubscribe = ctx.events.subscribe((event) => push(sseFrame(event)));
      heartbeat = setInterval(() => push(sseFrame({ type: 'heartbeat', ts: Date.now() })), 15_000);
      req.signal.addEventListener('abort', () => {
        cleanup();
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      });
    },
    cancel() {
      unsubscribe?.();
      if (heartbeat) clearInterval(heartbeat);
    },
  });
  return new Response(stream, {
    headers: { ...CORS, 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' },
  });
}

/** Turn a successful mutating API call into a human-readable activity entry. */
function recordActivity(ctx: MainContext, path: string, body: unknown, result: unknown): void {
  const fps = ctx.store.doc.fps;
  const tc = (f: number) => framesToTimecode(f, fps);
  const b = (body ?? {}) as Record<string, unknown>;
  const r = (result ?? {}) as Record<string, unknown>;
  const trackName = (id: string | undefined) => (id ? ctx.store.doc.getTrack(id)?.name ?? id : '?');
  const clip = r as { id?: string; kind?: string; name?: string; startFrame?: number; durationFrames?: number; trackId?: string; componentName?: string };
  switch (path) {
    case API_ROUTES.timelineInsert:
      ctx.events.activity('cli', 'timeline.insert', `Inserted ${clip.componentName ?? clip.kind} “${clip.name}” at ${tc(clip.startFrame ?? 0)} on ${trackName(clip.trackId)} (${clip.durationFrames}f)`, { clipIds: clip.id ? [clip.id] : [] });
      break;
    case API_ROUTES.timelineUpdate:
      ctx.events.activity('cli', 'timeline.update', `Updated “${clip.name}” (${Object.keys((b.patch as object) ?? {}).join(', ')})`, { clipIds: clip.id ? [clip.id] : [] });
      break;
    case API_ROUTES.timelineMove:
      ctx.events.activity('cli', 'timeline.move', `Moved “${clip.name}” to ${tc(clip.startFrame ?? 0)} on ${trackName(clip.trackId)}`, { clipIds: clip.id ? [clip.id] : [] });
      break;
    case API_ROUTES.timelineSplit: {
      const [l, rr] = (result as { id: string; name: string; startFrame: number }[]) ?? [];
      ctx.events.activity('cli', 'timeline.split', `Split “${l?.name}” at ${tc(rr?.startFrame ?? 0)}`, { clipIds: [l?.id, rr?.id].filter(Boolean) as string[] });
      break;
    }
    case API_ROUTES.timelineRemove:
      ctx.events.activity('cli', 'timeline.remove', `Removed ${(b.ids as string[] | undefined)?.length ?? 0} clip(s)`, { clipIds: (b.ids as string[]) ?? [] });
      break;
    case API_ROUTES.trackAdd:
      ctx.events.activity('cli', 'tracks.add', `Added ${String(r.kind)} track “${String(r.name)}”`, { trackIds: [String(r.id)] });
      break;
    case API_ROUTES.trackUpdate:
      ctx.events.activity('cli', 'tracks.update', `Updated track “${String(r.name)}” (${Object.keys((b.patch as object) ?? {}).join(', ')})`, { trackIds: [String(r.id)] });
      break;
    case API_ROUTES.trackRemove:
      ctx.events.activity('cli', 'tracks.remove', `Removed track ${String(r.removed)}`, { trackIds: [String(r.removed)] });
      break;
    case API_ROUTES.assetsImport: {
      const imp = result as { asset: { id: string; name: string }; clip?: { id: string; startFrame: number }; deduplicated: boolean };
      ctx.events.activity('cli', 'assets.import', `${imp.deduplicated ? 'Re-used' : 'Imported'} “${imp.asset.name}”${imp.clip ? ` and placed it at ${tc(imp.clip.startFrame)}` : ''}`, { assetIds: [imp.asset.id], clipIds: imp.clip ? [imp.clip.id] : [] });
      break;
    }
    case API_ROUTES.assetsRemove:
      ctx.events.activity('cli', 'assets.remove', `Removed asset ${String(r.removed).slice(0, 12)}…`, { assetIds: [String(r.removed)] });
      break;
    case API_ROUTES.meta:
      ctx.events.activity('cli', 'project.meta', `Project settings changed (${Object.keys(b).join(', ')})`);
      break;
    case API_ROUTES.projectNew:
      ctx.events.activity('cli', 'project.new', `Created project “${(r.project as { meta: { name: string } }).meta.name}”`);
      break;
    case API_ROUTES.projectOpen:
      ctx.events.activity('cli', 'project.open', `Opened ${String(r.path)}`);
      break;
    case API_ROUTES.projectSave:
      ctx.events.activity('cli', 'project.save', `Saved to ${String(r.path)}`);
      break;
    case API_ROUTES.render:
      ctx.events.activity('cli', 'render.start', `Render requested (${String(r.presetId)}) → ${String(r.outputPath)}`, { jobId: String(r.id) });
      break;
    case API_ROUTES.preview:
      ctx.events.activity('cli', 'preview.control', r.action === 'seek' ? `Moved the playhead to ${tc(Number(r.frame ?? 0))}` : `Preview: ${String(r.action)}`);
      break;
    case API_ROUTES.timelineDetach:
      ctx.events.activity('cli', 'timeline.detach', `Detached audio of “${String((r as { name?: string }).name ?? '')}” to ${trackName(String((r as { trackId?: string }).trackId))}`, { clipIds: [String((r as { id?: string }).id)] });
      break;
    case API_ROUTES.timelineCut:
      ctx.events.activity('cli', 'timeline.cut', `Cut ${String((r as { cuts?: number }).cuts ?? 0)} clip segment(s), ${String(r.removedFrames)} frames removed (ripple)`);
      break;
    case API_ROUTES.ui: {
      const parts: string[] = [];
      if (r.panel) parts.push(`opened the ${String(r.panel)} panel`);
      if (Array.isArray(r.select)) parts.push(r.select.length ? `selected ${r.select.length} clip(s)` : 'cleared the selection');
      if (r.dialog) parts.push(r.dialog === 'none' ? 'closed dialogs' : `opened the ${String(r.dialog)} dialog`);
      ctx.events.activity('cli', 'ui.control', parts.length ? parts.join(', ').replace(/^./, (c) => c.toUpperCase()) : 'UI control', { clipIds: (r.select as string[]) ?? [] });
      break;
    }
    case API_ROUTES.roomHost:
      ctx.events.activity('cli', 'room.host', `Hosting room ${String(r.roomCode)}`);
      break;
    case API_ROUTES.roomJoin:
      ctx.events.activity('cli', 'room.join', `Joined room ${String(r.roomCode)}`);
      break;
    case API_ROUTES.roomLeave:
      ctx.events.activity('cli', 'room.leave', 'Left room');
      break;
    default:
      if (/^\/api\/ai\//.test(path) && typeof r.op === 'string') {
        ctx.events.activity('cli', `ai.${String(r.op)}.requested`, `AI ${String(r.op)} requested${r.clipId ? ` for clip ${String(r.clipId).slice(-6)}` : ''}`, { jobId: String(r.id), clipIds: r.clipId ? [String(r.clipId)] : [] });
      } else if (/\/cancel$/.test(path)) ctx.events.activity('cli', 'render.cancel', `Render ${String(r.id)} cancelled`, { jobId: String(r.id) });
      break;
  }
}
