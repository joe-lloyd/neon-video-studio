/** Typed HTTP client for the desktop app's control API. */
import { API_ROUTES, type AiCapabilities, type AiJob, type ApiResult, type AppStatus, type ImportAssetResponse, type ListResponse, type RenderJob, type RoomInfo, type StateResponse, type Transcript , type HistoryStatus, type PackSummary } from '@neon/core';
import { isProcessAlive, readInstanceInfo } from '@neon/core/node';
import type { Asset, Clip, Project, Track } from '@neon/core';

export class ApiError extends Error {
  readonly code: string;
  readonly details: unknown;
  constructor(code: string, message: string, details?: unknown) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

export interface ClientOptions {
  endpoint: string;
  token: string;
}

export async function discoverClient(explicit: Partial<ClientOptions> = {}): Promise<ClientOptions> {
  const endpoint = explicit.endpoint ?? process.env.NEON_ENDPOINT;
  const token = explicit.token ?? process.env.NEON_TOKEN;
  if (endpoint && token) return { endpoint: endpoint.replace(/\/$/, ''), token };
  const info = await readInstanceInfo();
  if (!info) {
    throw new ApiError(
      'NOT_RUNNING',
      'Neon Video Studio is not running (no instance file). Start the desktop app, or pass --endpoint and --token, or use `render --headless`.',
    );
  }
  if (!isProcessAlive(info.pid)) {
    throw new ApiError('STALE_INSTANCE', `Instance file points at pid ${info.pid} which is not alive. Start the desktop app.`);
  }
  return { endpoint: endpoint ?? `http://127.0.0.1:${info.port}`, token: token ?? info.token };
}

export class NeonClient {
  private readonly opts: ClientOptions;

  constructor(opts: ClientOptions) {
    this.opts = opts;
  }

  get endpoint(): string {
    return this.opts.endpoint;
  }

  private async call<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    let res: Response;
    try {
      res = await fetch(`${this.opts.endpoint}${path}`, {
        method,
        headers: { Authorization: `Bearer ${this.opts.token}`, 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (err) {
      throw new ApiError('UNREACHABLE', `Cannot reach ${this.opts.endpoint}: ${(err as Error).message}`);
    }
    const json = (await res.json().catch(() => null)) as ApiResult<T> | null;
    if (!json) throw new ApiError('BAD_RESPONSE', `Non-JSON response (${res.status}) from ${path}`);
    if (!json.ok) throw new ApiError(json.error.code, json.error.message, json.error.details);
    return json.data;
  }

  status = () => this.call<AppStatus>('GET', API_ROUTES.status);
  list = () => this.call<ListResponse>('GET', API_ROUTES.list);
  state = () => this.call<StateResponse>('GET', API_ROUTES.state);
  updateMeta = (patch: Record<string, unknown>) => this.call<Project['meta']>('POST', API_ROUTES.meta, patch);

  projectNew = (body: Record<string, unknown>) => this.call<{ path: string | null; project: Project }>('POST', API_ROUTES.projectNew, body);
  projectOpen = (path: string) => this.call<{ path: string; project: Project }>('POST', API_ROUTES.projectOpen, { path });
  projectSave = (path?: string) => this.call<{ path: string }>('POST', API_ROUTES.projectSave, { path });

  insert = (body: Record<string, unknown>) => this.call<Clip>('POST', API_ROUTES.timelineInsert, body);
  update = (id: string, patch: Record<string, unknown>) => this.call<Clip>('POST', API_ROUTES.timelineUpdate, { id, patch });
  move = (id: string, at: string | number, trackId?: string) => this.call<Clip>('POST', API_ROUTES.timelineMove, { id, at, trackId });
  split = (id: string, at: string | number) => this.call<[Clip, Clip]>('POST', API_ROUTES.timelineSplit, { id, at });
  remove = (ids: string[]) => this.call<{ removed: number }>('POST', API_ROUTES.timelineRemove, { ids });
  nudge = (ids: string[], by: string) => this.call<Clip[]>('POST', API_ROUTES.timelineNudge, { ids, by });

  trackAdd = (kind: string, name?: string) => this.call<Track>('POST', API_ROUTES.trackAdd, { kind, name });
  trackUpdate = (id: string, patch: Record<string, unknown>) => this.call<Track>('POST', API_ROUTES.trackUpdate, { id, patch });
  trackRemove = (id: string) => this.call<{ removed: string }>('POST', API_ROUTES.trackRemove, { id });

  importAsset = (path: string, insert?: { at?: string | number; trackId?: string }) =>
    this.call<ImportAssetResponse>('POST', API_ROUTES.assetsImport, { path, insert });
  removeAsset = (id: string) => this.call<{ removed: string }>('POST', API_ROUTES.assetsRemove, { id });

  render = (body: Record<string, unknown>) => this.call<RenderJob>('POST', API_ROUTES.render, body);
  renderJob = (id: string) => this.call<RenderJob>('GET', API_ROUTES.renderJob.replace(':id', encodeURIComponent(id)));
  renderCancel = (id: string) => this.call<RenderJob>('POST', API_ROUTES.renderCancel.replace(':id', encodeURIComponent(id)));

  roomHost = (password?: string) => this.call<RoomInfo>('POST', API_ROUTES.roomHost, { password });
  roomJoin = (body: Record<string, unknown>) => this.call<RoomInfo>('POST', API_ROUTES.roomJoin, body);
  roomLeave = () => this.call<RoomInfo>('POST', API_ROUTES.roomLeave, {});

  preview = (action: 'play' | 'pause' | 'toggle' | 'seek', at?: string | number) =>
    this.call<{ action: string; frame: number | null }>('POST', API_ROUTES.preview, { action, at });

  ui = (body: { panel?: string; select?: string[]; dialog?: string }) => this.call<typeof body>('POST', API_ROUTES.ui, body);

  cut = (body: Record<string, unknown>) => this.call<{ removedFrames: number; cuts: number }>('POST', API_ROUTES.timelineCut, body);
  detach = (id: string) => this.call<Clip>('POST', API_ROUTES.timelineDetach, { id });
  aiStatus = () => this.call<AiCapabilities & { hints: Record<string, string> }>('GET', API_ROUTES.aiStatus);
  aiJobs = () => this.call<AiJob[]>('GET', API_ROUTES.aiJobs);
  aiJob = (id: string) => this.call<AiJob>('GET', `${API_ROUTES.aiJobs}/${encodeURIComponent(id)}`);
  aiCancel = (id: string) => this.call<AiJob>('POST', `${API_ROUTES.aiJobs}/${encodeURIComponent(id)}/cancel`);
  aiRun = (op: string, body: Record<string, unknown>) => this.call<AiJob>('POST', `${API_ROUTES.ai}/${op}`, body);
  transcript = (assetId: string) => this.call<Transcript>('GET', `${API_ROUTES.aiTranscript}/${assetId}`);
  transcriptCut = (assetId: string, opts: { fromWord?: number; toWord?: number; words?: number[]; mode?: 'timeline' | 'audio' }) =>
    this.call<AiJob>('POST', `${API_ROUTES.aiTranscript}/cut`, { assetId, ...opts });

  packs = () => this.call<PackSummary[]>('GET', API_ROUTES.packs);
  packsInstall = (path: string) => this.call<PackSummary>('POST', API_ROUTES.packsInstall, { path });
  packsReload = () => this.call<PackSummary[]>('POST', API_ROUTES.packsReload, {});
  packsUninstall = (name: string) => this.call<{ removed: string }>('POST', API_ROUTES.packsUninstall.replace(':name', encodeURIComponent(name)), {});
  projectPacks = (body: { enable?: string[]; disable?: string[] }) => this.call<{ packs: string[] }>('POST', API_ROUTES.projectPacks, body);
  history = () => this.call<HistoryStatus>('GET', API_ROUTES.history);
  historyUndo = () => this.call<HistoryStatus>('POST', API_ROUTES.historyUndo, {});
  historyRedo = () => this.call<HistoryStatus>('POST', API_ROUTES.historyRedo, {});
  historyCheckpoint = () => this.call<HistoryStatus>('POST', API_ROUTES.historyCheckpoint, {});

  /** Waveform peaks (one byte per 10 ms, 0..255); empty array = no audio stream, null = unavailable. */
  async waveform(assetId: string): Promise<Uint8Array | null> {
    const res = await fetch(`${this.opts.endpoint}${API_ROUTES.waveforms}/${assetId}`, { headers: { Authorization: `Bearer ${this.opts.token}` } });
    if (res.status === 204) return new Uint8Array(0);
    if (!res.ok) return null;
    return new Uint8Array(await res.arrayBuffer());
  }

  /** Generic escape hatch for new endpoints. */
  call2 = (method: 'GET' | 'POST', path: string, body?: unknown) => this.call<unknown>(method, path, body);

  /** Open the Server-Sent Events stream (GET /api/events). Caller reads `res.body`. */
  async openEventStream(history = 20): Promise<Response> {
    const res = await fetch(`${this.opts.endpoint}${API_ROUTES.events}?history=${history}`, {
      headers: { Authorization: `Bearer ${this.opts.token}`, Accept: 'text/event-stream' },
    });
    if (!res.ok) throw new ApiError('HTTP_' + res.status, `Event stream request failed (${res.status})`);
    return res;
  }

  /** Resolve an asset by full hash, hash prefix or (unique) file name. */
  async resolveAsset(ref: string, assets?: Asset[]): Promise<Asset> {
    const list = assets ?? (await this.list()).assets;
    const exact = list.find((a) => a.id === ref);
    if (exact) return exact;
    const byPrefix = list.filter((a) => a.id.startsWith(ref.toLowerCase()));
    if (byPrefix.length === 1) return byPrefix[0]!;
    const byName = list.filter((a) => a.name === ref || a.name.toLowerCase() === ref.toLowerCase());
    if (byName.length === 1) return byName[0]!;
    if (byPrefix.length > 1 || byName.length > 1) throw new ApiError('AMBIGUOUS', `Asset reference "${ref}" matches several assets`);
    throw new ApiError('NOT_FOUND', `No asset matches "${ref}"`);
  }

  /** Resolve a track by id or name (e.g. "V1"). */
  async resolveTrack(ref: string, tracks?: Track[]): Promise<Track> {
    const list = tracks ?? (await this.list()).tracks;
    const t = list.find((x) => x.id === ref) ?? list.find((x) => x.name.toLowerCase() === ref.toLowerCase());
    if (!t) throw new ApiError('NOT_FOUND', `No track matches "${ref}". Tracks: ${list.map((x) => x.name).join(', ')}`);
    return t;
  }

  /** Resolve a clip by id, id prefix or (unique) name. */
  async resolveClip(ref: string, clips?: Clip[]): Promise<Clip> {
    const list = clips ?? (await this.list()).clips;
    const exact = list.find((c) => c.id === ref);
    if (exact) return exact;
    const prefix = list.filter((c) => c.id.startsWith(ref));
    if (prefix.length === 1) return prefix[0]!;
    const byName = list.filter((c) => c.name.toLowerCase() === ref.toLowerCase());
    if (byName.length === 1) return byName[0]!;
    if (prefix.length > 1 || byName.length > 1) throw new ApiError('AMBIGUOUS', `Clip reference "${ref}" is ambiguous`);
    throw new ApiError('NOT_FOUND', `No clip matches "${ref}"`);
  }
}
