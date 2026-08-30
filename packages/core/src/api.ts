import type { Asset, Clip, Project, Track } from './types.ts';

/**
 * Control API shared by the desktop main process (server), the CLI and the renderer.
 * Transport: HTTP JSON on 127.0.0.1 + bearer token. Every response is `ApiResult<T>`.
 */

export const API_VERSION = 1;

export interface ApiOk<T> {
  ok: true;
  data: T;
}
export interface ApiErr {
  ok: false;
  error: { code: string; message: string; details?: unknown };
}
export type ApiResult<T> = ApiOk<T> | ApiErr;

export type RenderStatus = 'queued' | 'bundling' | 'rendering' | 'done' | 'failed' | 'cancelled';

export interface RenderJob {
  id: string;
  status: RenderStatus;
  /** 0..1 */
  progress: number;
  renderedFrames: number;
  totalFrames: number;
  outputPath: string;
  presetId: string;
  startedAt: string;
  finishedAt?: string;
  error?: string;
  /** Last few log lines from the worker, for diagnostics. */
  log: string[];
}

export interface PeerInfo {
  clientId: number;
  peerId: string;
  name: string;
  color: string;
  playheadFrame?: number;
  selection?: string[];
  isLocal: boolean;
  transport: 'local' | 'webrtc' | 'websocket';
}

export interface RoomInfo {
  roomCode: string;
  role: 'host' | 'guest' | 'none';
  /** LAN URL other machines can use to sync + fetch assets (ws://ip:port). */
  lanUrl?: string;
  signalingUrls: string[];
  peers: PeerInfo[];
}

export interface AppStatus {
  app: 'neon-video-studio';
  version: string;
  apiVersion: number;
  pid: number;
  uptimeSeconds: number;
  project: {
    id: string;
    name: string;
    path: string | null;
    dirty: boolean;
    fps: number;
    width: number;
    height: number;
    durationFrames: number;
    tracks: number;
    clips: number;
    assets: number;
  };
  room: RoomInfo;
  renders: RenderJob[];
  capabilities: { ffprobe: boolean; node: boolean; renderRuntime: string };
}

export interface TemplateInfo {
  name: string;
  label: string;
  description: string;
  defaultDurationSeconds: number;
  defaults: Record<string, unknown>;
  jsonSchema: Record<string, unknown>;
}

export interface ListResponse {
  templates: TemplateInfo[];
  tracks: Track[];
  clips: Clip[];
  assets: Asset[];
  presets: { id: string; label: string; width: number; height: number; fps: number }[];
}

export interface ImportAssetResponse {
  asset: Asset;
  clip?: Clip;
  /** True when the file was already known (same hash). */
  deduplicated: boolean;
}

export interface StateResponse {
  project: Project;
  durationFrames: number;
}

/** Written to $NEON_HOME/instance.json so the CLI can find the running app. */
export interface InstanceInfo {
  pid: number;
  port: number;
  token: string;
  startedAt: string;
  version: string;
  projectPath: string | null;
}

export const API_ROUTES = {
  status: '/api/status',
  list: '/api/list',
  state: '/api/state',
  meta: '/api/meta',
  projectNew: '/api/project/new',
  projectOpen: '/api/project/open',
  projectSave: '/api/project/save',
  timelineInsert: '/api/timeline/insert',
  timelineUpdate: '/api/timeline/update',
  timelineMove: '/api/timeline/move',
  timelineSplit: '/api/timeline/split',
  timelineRemove: '/api/timeline/remove',
  trackAdd: '/api/tracks/add',
  trackUpdate: '/api/tracks/update',
  trackRemove: '/api/tracks/remove',
  assetsImport: '/api/assets/import',
  assetsRemove: '/api/assets/remove',
  render: '/api/render',
  renderJob: '/api/render/:id',
  renderCancel: '/api/render/:id/cancel',
  roomHost: '/api/room/host',
  roomJoin: '/api/room/join',
  roomLeave: '/api/room/leave',
  events: '/api/events',
  preview: '/api/preview',
  ui: '/api/ui',
  yjs: '/yjs',
  signaling: '/signaling',
  assets: '/assets',
} as const;

/** Who caused an action. */
export type ActivitySource = 'cli' | 'ui' | 'peer' | 'render' | 'room' | 'system';

/** One line in the live activity feed (shown in the app, streamed on /api/events, tailed by `neon-cli events`). */
export interface ActivityEntry {
  id: string;
  ts: string;
  source: ActivitySource;
  /** Short machine-readable action, e.g. "timeline.insert" */
  action: string;
  /** Human sentence, e.g. "Inserted TextOverlay “Hello” at 00:00:01:00 on FX1" */
  message: string;
  /** Clips touched, so the UI can flash them. */
  clipIds?: string[];
  trackIds?: string[];
  assetIds?: string[];
  jobId?: string;
}

/** Server-sent events on GET /api/events (text/event-stream, `event:` = type). */
export type ServerEvent =
  | { type: 'activity'; entry: ActivityEntry }
  | { type: 'project-changed'; durationFrames: number; clips: number; updatedAt: string }
  | { type: 'render'; job: RenderJob }
  | { type: 'room'; room: RoomInfo }
  | { type: 'project-opened'; path: string | null; name: string; projectId: string }
  | { type: 'heartbeat'; ts: number };
