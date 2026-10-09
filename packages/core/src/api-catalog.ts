/**
 * Machine-readable catalogue of the control API: one entry per API_ROUTES key with a one-line
 * summary and, for POST routes, the zod schema of the body. `neon-cli schema` prints it (offline),
 * `neon-cli apply --dry-run` validates plans against it, and POST /api/batch uses it to refuse
 * routes that cannot be rolled back.
 *
 * The table is keyed by ApiRouteKey, so adding a route to API_ROUTES without describing it here
 * fails the typecheck.
 */
import { z } from 'zod';
import { API_ROUTES, type ApiRouteKey } from './api.ts';
import {
  AddTrackRequestSchema,
  AiBreathsRequestSchema,
  AiBrollRequestSchema,
  AiCleanRequestSchema,
  AiDenoiseRequestSchema,
  AiEnhanceRequestSchema,
  AiFillersRequestSchema,
  AiMatteRequestSchema,
  AiPaceRequestSchema,
  AiReframeRequestSchema,
  AiRipRequestSchema,
  AiSetupRequestSchema,
  AiSilenceRequestSchema,
  AiTranscribeRequestSchema,
  BatchRequestSchema,
  ClipSpeedRequestSchema,
  ClipZoomRequestSchema,
  CutRangesRequestSchema,
  DetachAudioRequestSchema,
  IdRequestSchema,
  ImportAssetRequestSchema,
  InsertClipRequestSchema,
  MoveClipRequestSchema,
  NudgeClipsRequestSchema,
  PacksInstallRequestSchema,
  PreviewControlRequestSchema,
  ProjectNewRequestSchema,
  ProjectOpenRequestSchema,
  ProjectPacksRequestSchema,
  ProjectSaveRequestSchema,
  RecordStopRequestSchema,
  RemoveClipRequestSchema,
  RenderRequestSchema,
  SheetRequestSchema,
  StillRequestSchema,
  RoomHostRequestSchema,
  RoomJoinRequestSchema,
  SplitClipRequestSchema,
  TranscriptCutRequestSchema,
  UiControlRequestSchema,
  UpdateClipRequestSchema,
  UpdateMetaRequestSchema,
  UpdateTrackRequestSchema,
} from './schemas.ts';

export type RouteSpec =
  /** JSON response, no body. */
  | { method: 'GET'; summary: string }
  /**
   * JSON body (or none when `body` is null). `notInBatch` says why POST /api/batch refuses the
   * route: its effect is not a document edit that a rollback can undo.
   */
  | { method: 'POST'; summary: string; body: z.ZodType | null; notInBatch?: string }
  /** WebSocket upgrade (CRDT sync, WebRTC signaling). */
  | { method: 'WS'; summary: string }
  /** Base path only; the concrete routes under it have their own entries. */
  | { method: 'PREFIX'; summary: string };

const JOB = 'starts a background job that keeps editing after the batch ends';
const PROJECT = 'switches or writes the project';
const HISTORY = 'steps the edit history the batch relies on';
const ROOM = 'changes the collaboration room';
const STILL = 'renders a picture rather than editing; run it after the batch';

export const API_CATALOG: { readonly [K in ApiRouteKey]: RouteSpec } = {
  status: { method: 'GET', summary: 'App, project, room and render status' },
  list: { method: 'GET', summary: 'Templates (with prop JSON Schemas), packs, tracks, clips, assets and presets' },
  state: { method: 'GET', summary: 'Full project document and its length in frames' },
  meta: { method: 'POST', summary: 'Change project settings (name, fps, size, background, packs)', body: UpdateMetaRequestSchema },
  projectNew: { method: 'POST', summary: 'Create and switch to a new project', body: ProjectNewRequestSchema, notInBatch: PROJECT },
  projectOpen: { method: 'POST', summary: 'Open a .neon project directory', body: ProjectOpenRequestSchema, notInBatch: PROJECT },
  projectSave: { method: 'POST', summary: 'Save, or Save As when path is given', body: ProjectSaveRequestSchema, notInBatch: PROJECT },
  timelineInsert: { method: 'POST', summary: 'Insert a component (template) or media clip; returns the clip', body: InsertClipRequestSchema },
  timelineUpdate: { method: 'POST', summary: 'Patch a clip (timing, props, volume, fades, transform, animation, zooms)', body: UpdateClipRequestSchema },
  timelineMove: { method: 'POST', summary: 'Move one clip to a time and optionally another track', body: MoveClipRequestSchema },
  timelineSplit: { method: 'POST', summary: 'Split a clip at a time; returns [left, right]', body: SplitClipRequestSchema },
  timelineRemove: { method: 'POST', summary: 'Remove clips by id', body: RemoveClipRequestSchema },
  trackAdd: { method: 'POST', summary: 'Add a video, audio or overlay track', body: AddTrackRequestSchema },
  trackUpdate: { method: 'POST', summary: 'Rename, mute, lock, hide or reorder a track', body: UpdateTrackRequestSchema },
  trackRemove: { method: 'POST', summary: 'Remove a track and its clips', body: IdRequestSchema },
  assetsImport: { method: 'POST', summary: 'Import a file by absolute path, optionally placing it on the timeline', body: ImportAssetRequestSchema },
  assetsRemove: { method: 'POST', summary: 'Remove an asset from the project', body: IdRequestSchema },
  render: { method: 'POST', summary: 'Start an export; poll GET /api/render/:id', body: RenderRequestSchema, notInBatch: JOB },
  renderJob: { method: 'GET', summary: 'One render job' },
  renderCancel: { method: 'POST', summary: 'Cancel a render job', body: null, notInBatch: JOB },
  renderStill: { method: 'POST', summary: 'Render one frame as a PNG and wait for it', body: StillRequestSchema, notInBatch: STILL },
  renderSheet: { method: 'POST', summary: 'Render a contact sheet of frames as one PNG and wait for it', body: SheetRequestSchema, notInBatch: STILL },
  roomHost: { method: 'POST', summary: 'Host a P2P room', body: RoomHostRequestSchema, notInBatch: ROOM },
  roomJoin: { method: 'POST', summary: 'Join a P2P room', body: RoomJoinRequestSchema, notInBatch: ROOM },
  roomLeave: { method: 'POST', summary: 'Leave the room', body: null, notInBatch: ROOM },
  events: { method: 'GET', summary: 'Server-sent events: activity, project changes, renders, AI jobs (?history=N)' },
  preview: { method: 'POST', summary: 'Drive the preview player (play, pause, toggle, seek)', body: PreviewControlRequestSchema },
  ui: { method: 'POST', summary: 'Open a panel, select clips or open a dialog in the app', body: UiControlRequestSchema },
  timelineCut: { method: 'POST', summary: 'Remove time ranges across tracks (ripple by default)', body: CutRangesRequestSchema },
  timelineNudge: { method: 'POST', summary: 'Move several clips by a signed time ("2s", "-15f")', body: NudgeClipsRequestSchema },
  timelineDetach: { method: 'POST', summary: 'Split a video clip’s audio onto an audio track', body: DetachAudioRequestSchema },
  timelineSpeed: { method: 'POST', summary: 'Re-time a clip or a range of it; later clips ripple', body: ClipSpeedRequestSchema },
  timelineZoom: { method: 'POST', summary: 'Add a zoom region (timeline time) to a video or image clip', body: ClipZoomRequestSchema },
  assetsUpload: { method: 'POST', summary: 'Upload a file as the raw body (?name=&at=&track=); not JSON', body: null, notInBatch: 'takes a binary body' },
  ai: { method: 'PREFIX', summary: 'AI operations: /api/ai/<op>' },
  aiStatus: { method: 'GET', summary: 'Which AI engines are installed, with install hints' },
  aiJobs: { method: 'GET', summary: 'All AI jobs' },
  aiTranscript: { method: 'PREFIX', summary: 'Transcripts: /api/ai/transcript/<assetId> and /cut' },
  packs: { method: 'GET', summary: 'Built-in, installed and example FX packs' },
  packsInstall: { method: 'POST', summary: 'Install a pack folder and enable it for the project', body: PacksInstallRequestSchema, notInBatch: 'writes ~/.neon-video/packs' },
  packsReload: { method: 'POST', summary: 'Re-scan and recompile installed packs', body: null, notInBatch: 'recompiles packs on disk' },
  packsUninstall: { method: 'POST', summary: 'Delete an installed pack', body: null, notInBatch: 'deletes from ~/.neon-video/packs' },
  projectPacks: { method: 'POST', summary: 'Enable or disable installed packs for this project', body: ProjectPacksRequestSchema },
  history: { method: 'GET', summary: 'Edit-history position: checkpoint cursor and count' },
  historyUndo: { method: 'POST', summary: 'Restore the previous checkpoint', body: null, notInBatch: HISTORY },
  historyRedo: { method: 'POST', summary: 'Restore the next checkpoint', body: null, notInBatch: HISTORY },
  historyCheckpoint: { method: 'POST', summary: 'Record the current state as a checkpoint', body: null, notInBatch: HISTORY },
  shutdown: { method: 'POST', summary: 'Stop a headless instance', body: null, notInBatch: 'stops the app' },
  yjs: { method: 'WS', summary: 'Yjs CRDT sync of the project document' },
  signaling: { method: 'WS', summary: 'WebRTC signaling for rooms' },
  assets: { method: 'PREFIX', summary: 'Asset bytes: GET /assets/<sha256> (range requests)' },
  waveforms: { method: 'PREFIX', summary: 'Waveform peaks: GET /waveforms/<sha256> (one byte per 10 ms)' },
  aiJob: { method: 'GET', summary: 'One AI job' },
  aiJobCancel: { method: 'POST', summary: 'Cancel an AI job', body: null, notInBatch: JOB },
  aiTranscriptGet: { method: 'GET', summary: 'Word-level transcript of an asset (id or id prefix)' },
  aiTranscriptCut: { method: 'POST', summary: 'Cut words out of the video by transcript index', body: TranscriptCutRequestSchema, notInBatch: JOB },
  aiTranscribe: { method: 'POST', summary: 'Transcribe a clip or asset (whisper.cpp)', body: AiTranscribeRequestSchema, notInBatch: JOB },
  aiFillers: { method: 'POST', summary: 'Find (or with apply, cut) filler words', body: AiFillersRequestSchema, notInBatch: JOB },
  aiSilence: { method: 'POST', summary: 'Find (or with apply, cut) silences', body: AiSilenceRequestSchema, notInBatch: JOB },
  aiBreaths: { method: 'POST', summary: 'Attenuate breaths with volume keyframes', body: AiBreathsRequestSchema, notInBatch: JOB },
  aiDenoise: { method: 'POST', summary: 'Denoise audio into a new asset', body: AiDenoiseRequestSchema, notInBatch: JOB },
  aiEnhance: { method: 'POST', summary: 'Voice clarity and loudness into a new asset', body: AiEnhanceRequestSchema, notInBatch: JOB },
  aiMatte: { method: 'POST', summary: 'Remove the background into an alpha asset', body: AiMatteRequestSchema, notInBatch: JOB },
  aiReframe: { method: 'POST', summary: 'Face-tracked reframe for another aspect ratio', body: AiReframeRequestSchema, notInBatch: JOB },
  aiBroll: { method: 'POST', summary: 'Suggest (or with apply, place) B-roll from the transcript', body: AiBrollRequestSchema, notInBatch: JOB },
  aiPace: { method: 'POST', summary: 'Screen recordings: cut pauses over a still screen, speed up the rest', body: AiPaceRequestSchema, notInBatch: JOB },
  aiClean: { method: 'POST', summary: 'Fillers, silences, breaths and optional denoise in one job', body: AiCleanRequestSchema, notInBatch: JOB },
  aiSetup: { method: 'POST', summary: 'Install the AI engines and models', body: AiSetupRequestSchema, notInBatch: JOB },
  aiRip: { method: 'POST', summary: 'Download a web video into the media library (yt-dlp)', body: AiRipRequestSchema, notInBatch: JOB },
  recordStart: { method: 'POST', summary: 'Start recording a mic voice-over', body: null, notInBatch: 'records from the microphone' },
  recordStop: { method: 'POST', summary: 'Stop recording and place the take on the VO track', body: RecordStopRequestSchema, notInBatch: 'records from the microphone' },
  recordState: { method: 'GET', summary: 'Voice-over recorder state' },
  batch: { method: 'POST', summary: 'Run POST ops as one unit: all apply (one undo step) or the project is restored', body: BatchRequestSchema, notInBatch: 'batches do not nest' },
};

export interface CatalogEntry {
  key: ApiRouteKey;
  path: string;
  spec: RouteSpec;
}

/** Every route in API_ROUTES order. */
export function catalogEntries(): CatalogEntry[] {
  return (Object.keys(API_ROUTES) as ApiRouteKey[]).map((key) => ({ key, path: API_ROUTES[key], spec: API_CATALOG[key] }));
}

function pathPattern(path: string): RegExp {
  const escaped = path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/:[A-Za-z]+/g, '[^/]+');
  return new RegExp(`^${escaped}$`);
}

/** The catalogue entry serving `method path`; literal paths win over `:param` patterns. */
export function findRoute(method: 'GET' | 'POST', path: string): CatalogEntry | undefined {
  const candidates = catalogEntries().filter((e) => e.spec.method === method);
  return candidates.find((e) => e.path === path) ?? candidates.find((e) => e.path.includes(':') && pathPattern(e.path).test(path));
}

/** JSON Schema (draft 2020-12) of what a client may send; null when the route takes no JSON body. */
export function bodyJsonSchema(spec: RouteSpec): Record<string, unknown> | null {
  if (spec.method !== 'POST' || spec.body === null) return null;
  return z.toJSONSchema(spec.body, { io: 'input' }) as Record<string, unknown>;
}

export type BatchRouteCheck = { ok: true; entry: CatalogEntry & { spec: Extract<RouteSpec, { method: 'POST' }> } } | { ok: false; reason: string };

/** Whether POST /api/batch may run `route`. */
export function checkBatchRoute(route: string): BatchRouteCheck {
  const entry = findRoute('POST', route);
  if (!entry || entry.spec.method !== 'POST') return { ok: false, reason: `no POST route ${route} (see neon-cli schema)` };
  if (entry.spec.notInBatch) return { ok: false, reason: `${route} cannot run inside a batch: it ${entry.spec.notInBatch}` };
  return { ok: true, entry: { ...entry, spec: entry.spec } };
}
