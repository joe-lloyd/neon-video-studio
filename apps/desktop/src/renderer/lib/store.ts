/**
 * Renderer state. Three small external stores (project / ui / playhead) consumed through
 * useSyncExternalStore so 60 Hz playhead updates never re-render the whole editor.
 */
import { useSyncExternalStore } from 'react';
import type * as Y from 'yjs';
import {
  ORIGIN_LOCAL,
  ProjectDoc,
  createUndoManager,
  newId,
  peerColor,
  projectDurationFrames,
  type ActivityEntry,
  type AiCapabilities,
  type AiJob,
  type AiOperation,
  type Clip,
  type Project,
  type RenderJob,
  type RoomInfo,
  registerPack,
  unregisterPack,
} from '@neon/core';
import { PeerSession, type SessionSnapshot } from '@neon/p2p/browser';
import { registerAllPacks } from '@neon/remotion-workspace/packs';

registerAllPacks();
import type { Bridge } from './bridge.ts';
import type { HistoryStatus, PackInfo, RoomState, UpdateState } from '../../shared/rpc.ts';
import { registerRuntimeComponents, unregisterRuntimeComponents } from '@neon/remotion-workspace/templates';
import { importPackBundle } from './pack-host.ts';
import { FULL_FRAME, anchoredTransform, type NaturalBox } from './transform-math.ts';

export function createStore<T>(initial: T) {
  let state = initial;
  const listeners = new Set<() => void>();
  return {
    get: () => state,
    set(patch: Partial<T> | ((prev: T) => Partial<T>)) {
      const next = typeof patch === 'function' ? patch(state) : patch;
      state = { ...state, ...next };
      for (const l of listeners) l();
    },
    subscribe(l: () => void) {
      listeners.add(l);
      return () => listeners.delete(l);
    },
  };
}

export type Panel = 'assets' | 'templates' | 'inspector' | 'peers' | 'renders' | 'activity' | 'ai' | 'script';
export interface Toast {
  id: string;
  kind: 'info' | 'success' | 'error';
  message: string;
}

export interface UiState {
  selection: string[];
  /** Pixels per frame on the timeline. */
  pxPerFrame: number;
  snapping: boolean;
  panel: Panel;
  toasts: Toast[];
  renders: RenderJob[];
  room: RoomState;
  roomInfo: RoomInfo | null;
  session: SessionSnapshot | null;
  projectName: string;
  projectPath: string | null;
  dialog: 'render' | 'room' | 'shortcuts' | null;
  saving: 'idle' | 'saved' | 'dirty';
  previewMuted: boolean;
  /** Live feed of what the app, CLI/agents and peers are doing (newest first). */
  activity: ActivityEntry[];
  /** Clip ids that were just changed by someone else (CLI or peer) → neon flash on the timeline. */
  flash: Record<string, number>;
  /** Most recent activity, for the status-bar pulse. */
  lastActivity: ActivityEntry | null;
  aiJobs: AiJob[];
  aiCaps: AiCapabilities | null;
  /** Words selected in the Script panel — possibly non-contiguous; anchor drives shift-range extension. */
  scriptSelection: { assetId: string; words: number[]; anchor: number } | null;
  /** Right sidebar width in px (drag its left edge). */
  sidebarWidth: number;
  /** Project overview / start page. */
  showStart: boolean;
  recentProjects: { path: string; name: string; updatedAt: string; current: boolean }[];
  /** Voice-over recording state. */
  recording: { startFrame: number; startedAt: number } | null;
  /** Auto-update state pushed by the main process. */
  update: UpdateState;
  /** Undo/redo availability — in-memory stack or persisted history (see main/history.ts). */
  canUndo: boolean;
  canRedo: boolean;
  /** FX packs known to the main process (built-in, installed, examples). */
  packs: PackInfo[];
  packsBusy: boolean;
}

export interface PlayheadState {
  frame: number;
  playing: boolean;
}

export const EMPTY_PROJECT: Project = {
  meta: { id: '', name: 'Loading…', fps: 30, width: 1920, height: 1080, background: '#09090B', createdAt: '', updatedAt: '', schemaVersion: 1 },
  tracks: [],
  clips: [],
  assets: [],
  transcripts: [],
};

export class Editor {
  readonly bridge: Bridge;
  doc!: ProjectDoc;
  session!: PeerSession;
  undo!: Y.UndoManager;
  readonly project = createStore<{ project: Project; durationFrames: number; ready: boolean }>({ project: EMPTY_PROJECT, durationFrames: 0, ready: false });
  readonly ui = createStore<UiState>({
    selection: [],
    pxPerFrame: 2,
    snapping: true,
    panel: 'assets',
    toasts: [],
    renders: [],
    room: { role: 'none' },
    roomInfo: null,
    session: null,
    projectName: '',
    projectPath: null,
    dialog: null,
    saving: 'idle',
    previewMuted: false,
    activity: [],
    flash: {},
    lastActivity: null,
    aiJobs: [],
    aiCaps: null,
    scriptSelection: null,
    sidebarWidth: 320,
    showStart: true,
    recentProjects: [],
    recording: null,
    update: { phase: 'idle', currentVersion: '' },
    canUndo: false,
    canRedo: false,
    packs: [],
    packsBusy: false,
  });
  readonly playhead = createStore<PlayheadState>({ frame: 0, playing: false });
  /** Set by the Preview component so the editor can drive the Remotion Player. */
  player: { seekTo(frame: number): void; play(): void; pause(): void; toggle(): void; getCurrentFrame(): number } | null = null;
  private teardown: (() => void)[] = [];
  private projectId: string;
  /** Mirror of the persisted history position; the main process owns the files. */
  private history: HistoryStatus = { count: 0, cursor: -1 };
  private historyPushTimer: ReturnType<typeof setTimeout> | null = null;
  /** True while we drive Y.UndoManager ourselves, so its stack events are not mistaken for new edits. */
  private replaying = false;
  /** Installed pack bundles loaded into this renderer: pack → bundle path + component names. */
  private readonly loadedPacks = new Map<string, { path: string; names: string[] }>();
  /** Painted-content bounds per visible clip, measured by the canvas editor (composition fractions). */
  readonly canvasBounds = new Map<string, NaturalBox>();

  constructor(bridge: Bridge) {
    this.bridge = bridge;
    this.projectId = bridge.bootstrap.projectId;
    this.ui.set({ room: bridge.bootstrap.room, projectName: bridge.bootstrap.projectName, projectPath: bridge.bootstrap.projectPath });
    this.attachDocument();
    bridge.onMessage({
      renderUpdate: ({ job }) => this.upsertRender(job),
      roomUpdate: ({ room, info }) => {
        this.ui.set({ room, roomInfo: info });
        this.applyRoom(room);
        this.refreshUndoState();
      },
      projectOpened: ({ projectId, name, path }) => {
        this.ui.set({ projectName: name, projectPath: path, selection: [] });
        if (projectId !== this.projectId) {
          this.projectId = projectId;
          this.attachDocument();
        }
      },
      toast: ({ kind, message }) => this.toast(kind, message),
      updateStatus: ({ state }) => this.ui.set({ update: state }),
      packsChanged: ({ packs }) => void this.applyPacks(packs),
      historyChanged: ({ status }) => this.setHistory(status),
      menuAction: ({ action }) => this.handleMenuAction(action),
      activity: ({ entry }) => this.pushActivity(entry),
      aiUpdate: ({ job }) => this.upsertAiJob(job),
      previewControl: ({ action, frame }) => {
        switch (action) {
          case 'play':
            this.player?.play();
            break;
          case 'pause':
            this.player?.pause();
            break;
          case 'toggle':
            this.player?.toggle();
            break;
          case 'seek':
            this.player?.pause();
            this.seek(frame ?? 0);
            setTimeout(() => this.reportPreviewState('after seek'), 700);
            break;
        }
      },
      uiControl: ({ panel, select, dialog }) => {
        if (select) {
          const ids = this.project.get().project.clips.filter((c) => select.includes(c.id)).map((c) => c.id);
          this.select(ids);
          if (ids.length) {
            this.flashClips(ids);
            const first = this.doc.getClip(ids[0]!);
            if (first) this.seek(first.startFrame);
          }
        }
        if (panel) this.setPanel(panel);
        if (dialog) this.ui.set({ dialog: dialog === 'none' ? null : dialog });
      },
    });
    bridge.request('listRenders', {}).then((jobs) => this.ui.set({ renders: jobs })).catch(() => undefined);
    bridge.request('aiJobs', {}).then((jobs) => this.ui.set({ aiJobs: jobs })).catch(() => undefined);
    void this.loadAiStatus();
    void this.refreshRecentProjects();
    void this.refreshPacks();
    // Media diagnostics: WKWebView surfaces <video>/<audio> failures only on the element, so
    // capture them here and forward to the main-process log.
    const mediaLog = (e: Event) => {
      const el = e.target as HTMLMediaElement | null;
      if (!el || (el.tagName !== 'VIDEO' && el.tagName !== 'AUDIO')) return;
      const err = el.error ? ` code=${el.error.code} ${el.error.message}` : '';
      bridge.log(e.type === 'error' ? 'error' : 'info', `media ${e.type} ${el.tagName.toLowerCase()} ${el.currentSrc.slice(0, 90)}${err} readyState=${el.readyState}`);
    };
    for (const type of ['error', 'loadeddata', 'stalled']) document.addEventListener(type, mediaLog, true);
    bridge.ready();
  }

  // ---- document + sync -----------------------------------------------------------------

  private attachDocument(): void {
    for (const fn of this.teardown) fn();
    this.teardown = [];
    this.doc = new ProjectDoc();
    this.undo = createUndoManager(this.doc, [ORIGIN_LOCAL]);
    this.bindHistory();
    const b = this.bridge.bootstrap;
    this.session = new PeerSession({
      doc: this.doc.doc,
      localUrl: `ws://127.0.0.1:${b.port}/yjs`,
      localParams: { token: b.token, doc: this.projectId },
      peerId: b.peerId,
      name: b.peerName,
      color: peerColor(b.peerId),
      assetBaseUrl: `http://127.0.0.1:${b.port}/assets`,
    });
    this.project.set({ project: EMPTY_PROJECT, durationFrames: 0, ready: false });
    const unsubDoc = this.doc.subscribe((project) => {
      this.project.set({ project, durationFrames: projectDurationFrames(project), ready: this.doc.isInitialized });
      this.ui.set((u) => ({ projectName: project.meta.name || u.projectName, saving: 'dirty', selection: u.selection.filter((id) => project.clips.some((c) => c.id === id)) }));
      this.scheduleSavedIndicator();
    });
    const unsubSession = this.session.subscribe((snap) => {
      this.ui.set({ session: snap });
      if (snap.localSynced && this.doc.isInitialized) {
        const project = this.doc.toJSON();
        this.project.set({ project, durationFrames: projectDurationFrames(project), ready: true });
      }
    });
    // Anything not typed here (CLI through the main process, or remote peers) flashes on the timeline.
    const observer = (events: Y.YEvent<Y.Map<unknown>>[], tx: Y.Transaction) => {
      if (tx.local || tx.origin === ORIGIN_LOCAL) return;
      const ids = new Set<string>();
      for (const ev of events) {
        if (ev.path.length === 0) for (const key of (ev as Y.YMapEvent<unknown>).keysChanged) ids.add(String(key));
        else ids.add(String(ev.path[0]));
      }
      if (ids.size === 0) return;
      this.flashClips([...ids]);
      // Edits from the local main process are already announced by the main process itself;
      // anything else came over WebRTC / LAN from a peer.
      if (tx.origin !== this.session.local) {
        const names = [...ids].map((id) => this.doc.getClip(id)?.name).filter(Boolean);
        this.pushActivity({
          id: newId('act'),
          ts: new Date().toISOString(),
          source: 'peer',
          action: 'peer.edit',
          message: `Peer edited ${ids.size} clip${ids.size === 1 ? '' : 's'}${names.length ? ` (${names.slice(0, 3).join(', ')}${names.length > 3 ? '…' : ''})` : ''}`,
          clipIds: [...ids],
        });
      }
    };
    this.doc.clips.observeDeep(observer);
    this.teardown.push(unsubDoc, unsubSession, () => this.doc.clips.unobserveDeep(observer), () => this.session.destroy(), () => this.undo.destroy());
    this.applyRoom(this.ui.get().room);
  }

  /** Diagnostics for the main-process log: what the Player is actually showing. */
  reportPreviewState(label: string): void {
    const videos = [...document.querySelectorAll('video')].map((v) => {
      const r = v.getBoundingClientRect();
      const cs = getComputedStyle(v);
      return { src: v.currentSrc.slice(-12), t: v.currentTime.toFixed(2), rs: v.readyState, vw: v.videoWidth, w: Math.round(r.width), h: Math.round(r.height), op: cs.opacity, vis: cs.visibility, disp: cs.display, paused: v.paused };
    });
    const playerFrame = (this.player as { getCurrentFrame?: () => number } | null)?.getCurrentFrame?.();
    const wrap = document.querySelector('.player-wrap');
    const inner = wrap?.firstElementChild as HTMLElement | null;
    this.bridge.log('info', `preview ${label}: playerFrame=${String(playerFrame)} store=${this.playhead.get().frame} wrap=${wrap ? Math.round(wrap.getBoundingClientRect().width) : 'none'} inner=${inner ? `${inner.tagName} ${inner.className.toString().slice(0, 40)} ${Math.round(inner.getBoundingClientRect().width)}x${Math.round(inner.getBoundingClientRect().height)}` : 'none'} videos=${JSON.stringify(videos)}`);
  }

  pushActivity(entry: ActivityEntry): void {
    this.ui.set((u) => ({ activity: [entry, ...u.activity.filter((e) => e.id !== entry.id)].slice(0, 200), lastActivity: entry }));
    setTimeout(() => this.ui.set((u) => (u.lastActivity?.id === entry.id ? { lastActivity: null } : {})), 4500);
  }

  flashClips(ids: string[], ms = 1800): void {
    const until = Date.now() + ms;
    this.ui.set((u) => ({ flash: { ...u.flash, ...Object.fromEntries(ids.map((id) => [id, until])) } }));
    setTimeout(() => {
      this.ui.set((u) => {
        const now = Date.now();
        const next: Record<string, number> = {};
        for (const [id, t] of Object.entries(u.flash)) if (t > now) next[id] = t;
        return { flash: next };
      });
    }, ms + 50);
  }

  // ---- projects overview ------------------------------------------------------------------

  async refreshRecentProjects(): Promise<void> {
    try {
      this.ui.set({ recentProjects: await this.bridge.request('recentProjects', {}) });
    } catch {
      /* http mode without support */
    }
  }

  async openProjectPath(path: string): Promise<void> {
    try {
      await this.bridge.request('openProject', { path });
      this.ui.set({ showStart: false });
    } catch (err) {
      this.toast('error', (err as Error).message);
    }
  }

  async createProject(opts: { name?: string; fps?: number; width?: number; height?: number; dir?: string }): Promise<void> {
    try {
      await this.bridge.request('newProjectAt', opts);
      this.ui.set({ showStart: false });
      void this.refreshRecentProjects();
    } catch (err) {
      this.toast('error', (err as Error).message);
    }
  }

  // ---- voice-over recording ---------------------------------------------------------------

  private mediaRecorder: MediaRecorder | null = null;
  private recordedChunks: Blob[] = [];

  async startVoiceOver(): Promise<void> {
    if (this.ui.get().recording) return;
    // views:// is not a secure context → navigator.mediaDevices does not exist in the webview.
    // The main process records via ffmpeg/avfoundation instead; MediaRecorder is the browser-mode path.
    if (this.bridge.mode === 'electrobun' || typeof navigator.mediaDevices?.getUserMedia !== 'function') {
      const startFrame = this.playhead.get().frame;
      try {
        const { device } = await this.bridge.request('voStart', {});
        this.ui.set({ recording: { startFrame, startedAt: Date.now() } });
        this.noteUiAction('vo.record', `Recording voice-over (${device}) from frame ${startFrame}`);
        this.player?.play();
      } catch (err) {
        this.toast('error', (err as Error).message);
      }
      return;
    }
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: false } });
    } catch (err) {
      this.toast('error', `Microphone unavailable: ${(err as Error).message}. Grant mic access to Neon Video Studio in System Settings → Privacy.`);
      return;
    }
    const mime = ['audio/mp4', 'audio/webm;codecs=opus', 'audio/webm'].find((m) => MediaRecorder.isTypeSupported(m)) ?? '';
    const recorder = new MediaRecorder(stream, mime ? { mimeType: mime, audioBitsPerSecond: 192_000 } : undefined);
    this.recordedChunks = [];
    recorder.ondataavailable = (e) => e.data.size && this.recordedChunks.push(e.data);
    const startFrame = this.playhead.get().frame;
    recorder.onstop = () => {
      stream.getTracks().forEach((t) => t.stop());
      void this.finishVoiceOver(startFrame, mime);
    };
    this.mediaRecorder = recorder;
    recorder.start(250);
    this.ui.set({ recording: { startFrame, startedAt: Date.now() } });
    this.noteUiAction('vo.record', `Recording voice-over from frame ${startFrame}`);
    // Roll the timeline so you can speak to the picture (wear headphones or mute the preview).
    this.player?.play();
  }

  stopVoiceOver(): void {
    const rec = this.ui.get().recording;
    this.player?.pause();
    if (this.mediaRecorder) {
      this.mediaRecorder.stop();
      this.mediaRecorder = null;
      return;
    }
    if (!rec) return;
    this.ui.set({ recording: null });
    this.bridge
      .request('voStop', { startFrame: rec.startFrame })
      .then((result) => {
        if (result.clip) {
          this.select([result.clip.id]);
          this.flashClips([result.clip.id]);
        }
        this.seek(rec.startFrame);
        this.toast('success', `Voice-over placed at frame ${rec.startFrame}`);
      })
      .catch((err: Error) => this.toast('error', err.message));
  }

  private async finishVoiceOver(startFrame: number, mime: string): Promise<void> {
    this.ui.set({ recording: null });
    const blob = new Blob(this.recordedChunks, { type: mime || 'audio/mp4' });
    this.recordedChunks = [];
    if (blob.size < 2000) {
      this.toast('error', 'Recording was empty');
      return;
    }
    try {
      // A dedicated VO track keeps takes out of the music lane.
      let track = this.project.get().project.tracks.find((t) => t.kind === 'audio' && t.name === 'VO');
      track ??= this.doc.addTrack('audio', 'VO', ORIGIN_LOCAL);
      const ext = blob.type.includes('mp4') ? 'm4a' : 'webm';
      const name = `voiceover-${new Date().toISOString().slice(11, 19).replace(/:/g, '')}.${ext}`;
      const b = this.bridge.bootstrap;
      const res = await fetch(`http://127.0.0.1:${b.port}/api/assets/upload?name=${encodeURIComponent(name)}&at=${startFrame}&track=${encodeURIComponent(track.id)}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${b.token}`, 'Content-Type': blob.type || 'application/octet-stream' },
        body: blob,
      });
      const json = (await res.json()) as { ok: boolean; data?: { clip?: { id: string } }; error?: { message: string } };
      if (!json.ok) throw new Error(json.error?.message ?? 'upload failed');
      if (json.data?.clip) {
        this.select([json.data.clip.id]);
        this.flashClips([json.data.clip.id]);
      }
      this.seek(startFrame);
      this.toast('success', `Voice-over placed on ${track.name} at frame ${startFrame}`);
    } catch (err) {
      this.toast('error', `Voice-over import failed: ${(err as Error).message}`);
    }
  }

  /**
   * Change scale and/or rotation while the element stays put: the composition pivots on the frame
   * centre, so the position is re-solved to keep the element's painted centre fixed.
   */
  setTransformAnchored(clipId: string, patch: { scale?: number; rotation?: number }): void {
    const clip = this.doc.getClip(clipId);
    if (!clip) return;
    const { width, height } = this.project.get().project.meta;
    const current = { x: clip.transform?.x ?? 0.5, y: clip.transform?.y ?? 0.5, scale: clip.transform?.scale ?? 1, rotation: clip.transform?.rotation ?? 0 };
    this.setTransform(clipId, anchoredTransform(this.canvasBounds.get(clipId) ?? FULL_FRAME, current, patch, width, height));
  }

  setTransform(clipId: string, transform: { x: number; y: number; scale: number; rotation?: number } | null): void {
    // Normalise rotation to (-180, 180] so "one full turn" lands back on 0.
    let rot = Math.round(((transform?.rotation ?? 0) % 360) * 10) / 10;
    if (rot > 180) rot -= 360;
    if (rot <= -180) rot += 360;
    const t = transform
      ? { x: Math.round(transform.x * 1000) / 1000, y: Math.round(transform.y * 1000) / 1000, scale: Math.round(transform.scale * 1000) / 1000, ...(rot !== 0 ? { rotation: rot } : {}) }
      : null;
    this.updateClip(clipId, { transform: t && t.x === 0.5 && t.y === 0.5 && t.scale === 1 && rot === 0 ? null : t });
  }

  detachAudio(clipId: string): void {
    this.bridge
      .request('detachAudio', { id: clipId })
      .then(() => this.noteUiAction('timeline.detach', 'Detached audio to an audio track', [clipId]))
      .catch((err: Error) => this.toast('error', err.message));
  }

  /** Zoom keeping `anchorFrame` at the same x position within the lanes viewport. */
  zoomAt(factor: number, anchorFrame: number, lanes: HTMLElement | null): void {
    const prev = this.ui.get().pxPerFrame;
    const px = Math.min(40, Math.max(0.05, prev * factor));
    if (px === prev) return;
    let scrollLeft: number | null = null;
    if (lanes) {
      const offset = anchorFrame * prev - lanes.scrollLeft;
      scrollLeft = Math.max(0, anchorFrame * px - offset);
    }
    this.ui.set({ pxPerFrame: px });
    if (lanes && scrollLeft !== null) requestAnimationFrame(() => (lanes.scrollLeft = scrollLeft!));
  }

  // ---- AI ------------------------------------------------------------------------------

  private upsertAiJob(job: AiJob): void {
    this.ui.set((u) => ({ aiJobs: [job, ...u.aiJobs.filter((j) => j.id !== job.id)].sort((a, b) => b.startedAt.localeCompare(a.startedAt)).slice(0, 30) }));
    if (job.status === 'done') this.toast('success', job.message);
    if (job.status === 'failed') this.toast('error', job.message);
  }

  async loadAiStatus(refresh = false): Promise<void> {
    if (this.ui.get().aiCaps && !refresh) return;
    try {
      this.ui.set({ aiCaps: await this.bridge.request('aiStatus', {}) });
    } catch (err) {
      this.toast('error', `AI status: ${(err as Error).message}`);
    }
  }

  async runAi(op: AiOperation, params: Record<string, unknown>): Promise<AiJob | null> {
    try {
      const job = await this.bridge.request('aiRun', { op, params });
      this.upsertAiJob(job);
      this.noteUiAction(`ai.${op}`, `Started AI ${op}`, typeof params.clipId === 'string' ? [params.clipId] : undefined);
      return job;
    } catch (err) {
      this.toast('error', (err as Error).message);
      return null;
    }
  }

  async cancelAi(id: string): Promise<void> {
    const job = await this.bridge.request('aiCancel', { id }).catch(() => null);
    if (job) this.upsertAiJob(job);
  }

  /**
   * Remove the words selected in the Script panel: 'timeline' ripple-cuts video+audio,
   * 'audio' just mutes the words in place (volume keyframes) — the picture keeps playing.
   */
  async cutScriptSelection(mode: 'timeline' | 'audio' = 'timeline'): Promise<void> {
    const sel = this.ui.get().scriptSelection;
    if (!sel || sel.words.length === 0) return;
    await this.runAi('transcript-cut', { assetId: sel.assetId, words: [...sel.words].sort((a, b) => a - b), mode });
    this.ui.set({ scriptSelection: null });
  }

  /** Transcript for an asset, following derivedFrom links in both directions (denoised copies share timing). */
  transcriptForAsset(assetId: string) {
    const { transcripts, assets } = this.project.get().project;
    const family = new Set([assetId]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const a of assets) {
        if (a.derivedFrom && family.has(a.derivedFrom) && !family.has(a.id)) { family.add(a.id); changed = true; }
        if (a.derivedFrom && family.has(a.id) && !family.has(a.derivedFrom)) { family.add(a.derivedFrom); changed = true; }
      }
    }
    return transcripts.find((t) => family.has(t.assetId));
  }

  /** Timeline frame where a source second of `assetId` is shown (first clip that contains it), if any. */
  timelineFrameForSource(assetId: string, seconds: number): number | null {
    const fps = this.fps;
    const { assets } = this.project.get().project;
    const family = new Set([assetId]);
    for (const a of assets) if (a.derivedFrom === assetId) family.add(a.id);
    for (const a of assets) if (a.id === assetId && a.derivedFrom) family.add(a.derivedFrom);
    const clips = this.project.get().project.clips.filter((c): c is Clip & { kind: 'video' | 'audio' | 'image' } => c.kind !== 'component' && family.has(c.assetId));
    for (const c of clips) {
      const local = Math.round(seconds * fps) - c.trimBefore;
      if (local >= 0 && local < c.durationFrames) return c.startFrame + local;
    }
    return null;
  }

  /** Record a UI action in the feed (kept local — the main process learns about it through Yjs). */
  noteUiAction(action: string, message: string, clipIds?: string[]): void {
    this.pushActivity({ id: newId('act'), ts: new Date().toISOString(), source: 'ui', action, message, clipIds });
  }

  private applyRoom(room: RoomState): void {
    if (room.role === 'host') this.session.joinRoom({ roomCode: room.roomCode, password: room.password, signaling: room.signaling });
    else if (room.role === 'guest') this.session.joinRoom({ roomCode: room.roomCode, password: room.password, hostUrl: room.hostUrl });
    else this.session.leaveRoom();
  }

  private savedTimer: ReturnType<typeof setTimeout> | null = null;
  private scheduleSavedIndicator(): void {
    if (this.savedTimer) clearTimeout(this.savedTimer);
    this.savedTimer = setTimeout(() => this.ui.set({ saving: 'saved' }), 2200);
  }

  assetUrl(assetId: string): string {
    return `http://127.0.0.1:${this.bridge.bootstrap.port}/assets/${assetId}`;
  }

  // ---- ui helpers ----------------------------------------------------------------------

  toast(kind: Toast['kind'], message: string): void {
    const id = Math.random().toString(36).slice(2);
    this.ui.set((u) => ({ toasts: [...u.toasts, { id, kind, message }].slice(-5) }));
    setTimeout(() => this.ui.set((u) => ({ toasts: u.toasts.filter((t) => t.id !== id) })), kind === 'error' ? 7000 : 3500);
  }

  /** Manual "search for updates": reports the outcome as a toast; the pill appears when one exists. */
  async checkForUpdates(): Promise<void> {
    try {
      const state = await this.bridge.request('updateCheck', {});
      this.ui.set({ update: state });
      if (state.phase === 'up-to-date') this.toast('success', `You're on the latest version (${state.currentVersion || this.bridge.bootstrap.version}).`);
      else if (state.phase === 'available') this.toast('info', `Update ${state.version} is available — click “Update” in the title bar.`);
      else if (state.phase === 'error' || state.phase === 'unsupported') this.toast('info', `Update check: ${state.error ?? 'unavailable'}`);
    } catch (err) {
      this.toast('error', (err as Error).message);
    }
  }

  /** Download + install + restart. On success the app restarts, so this usually never resolves. */
  async applyUpdate(): Promise<void> {
    try {
      const state = await this.bridge.request('updateApply', {});
      this.ui.set({ update: state });
      if (state.phase === 'error') this.toast('error', `Update failed: ${state.error ?? 'unknown error'}`);
    } catch (err) {
      // A download longer than the RPC timeout surfaces here even though the update keeps going —
      // the pushed updateStatus messages stay authoritative, so only report real failures.
      const phase = this.ui.get().update.phase;
      if (phase !== 'downloading' && phase !== 'installing') this.toast('error', (err as Error).message);
    }
  }

  private upsertRender(job: RenderJob): void {
    this.ui.set((u) => {
      const others = u.renders.filter((r) => r.id !== job.id);
      return { renders: [job, ...others].sort((a, b) => b.startedAt.localeCompare(a.startedAt)).slice(0, 20) };
    });
  }

  select(ids: string[], additive = false): void {
    this.ui.set((u) => ({ selection: additive ? Array.from(new Set([...u.selection, ...ids])) : ids }));
    this.session.setSelection(ids);
  }

  setPanel(panel: Panel): void {
    this.ui.set({ panel });
  }

  zoomBy(factor: number, anchorFrame?: number): void {
    const px = Math.min(40, Math.max(0.05, this.ui.get().pxPerFrame * factor));
    this.ui.set({ pxPerFrame: px });
    void anchorFrame;
  }

  fitTimeline(widthPx: number): void {
    const frames = Math.max(this.project.get().durationFrames, this.fps * 10);
    this.ui.set({ pxPerFrame: Math.max(0.05, (widthPx - 40) / frames) });
  }

  get fps(): number {
    return this.project.get().project.meta.fps || 30;
  }

  // ---- playback ------------------------------------------------------------------------

  seek(frame: number, opts: { fromPlayer?: boolean } = {}): void {
    const max = Math.max(0, this.project.get().durationFrames - 1);
    const f = Math.max(0, Math.min(max, Math.round(frame)));
    if (this.playhead.get().frame !== f) this.playhead.set({ frame: f });
    if (!opts.fromPlayer) this.player?.seekTo(f);
    this.session.setPlayhead(f);
  }

  setPlaying(playing: boolean): void {
    if (this.playhead.get().playing !== playing) this.playhead.set({ playing });
  }

  togglePlay(): void {
    this.player?.toggle();
  }

  stepFrames(delta: number): void {
    this.player?.pause();
    this.seek(this.playhead.get().frame + delta);
  }

  // ---- editing (all local, undoable) ---------------------------------------------------

  insertTemplate(componentName: string, atFrame?: number, props?: Record<string, unknown>): void {
    try {
      const clip = this.doc.insertClip({ kind: 'component', componentName, props, startFrame: atFrame ?? this.playhead.get().frame, placement: 'free' }, ORIGIN_LOCAL);
      this.select([clip.id]);
      this.noteUiAction('timeline.insert', `Added ${componentName} at frame ${clip.startFrame}`, [clip.id]);
      this.setPanel('inspector');
    } catch (err) {
      this.toast('error', (err as Error).message);
    }
  }

  insertAsset(assetId: string, atFrame?: number, trackId?: string): void {
    const asset = this.doc.getAsset(assetId);
    if (!asset) return;
    try {
      const clip = this.doc.insertClip({ kind: asset.kind, assetId, startFrame: atFrame ?? this.playhead.get().frame, trackId, placement: 'free' }, ORIGIN_LOCAL);
      this.select([clip.id]);
      this.noteUiAction('timeline.insert', `Placed “${asset.name}” at frame ${clip.startFrame}`, [clip.id]);
    } catch (err) {
      this.toast('error', (err as Error).message);
    }
  }

  async importMedia(atFrame?: number, trackId?: string): Promise<void> {
    try {
      const results = await this.bridge.request('importMediaDialog', { at: atFrame, trackId });
      if (results.length > 0) this.toast('success', `Imported ${results.length} file${results.length === 1 ? '' : 's'}`);
    } catch (err) {
      this.toast('error', (err as Error).message);
    }
  }

  /** ⌘/Ctrl-click: add or remove one clip from the selection. */
  toggleSelect(id: string): void {
    const current = this.ui.get().selection;
    this.select(current.includes(id) ? current.filter((x) => x !== id) : [...current, id]);
  }

  /** Move a multi-selection together by the same number of frames. */
  moveClips(ids: string[], deltaFrames: number): void {
    try {
      const moved = this.doc.moveClips(ids, deltaFrames, ORIGIN_LOCAL);
      this.noteUiAction('timeline.move', `Moved ${moved.length} clips by ${deltaFrames > 0 ? '+' : ''}${deltaFrames} frames`, ids);
    } catch (err) {
      this.toast('error', (err as Error).message);
    }
  }

  moveClip(id: string, startFrame: number, trackId?: string): void {
    try {
      const moved = this.doc.moveClip(id, startFrame, trackId, ORIGIN_LOCAL);
      this.noteUiAction('timeline.move', `Moved “${moved.name}” to frame ${moved.startFrame}`, [id]);
    } catch (err) {
      this.toast('error', (err as Error).message);
    }
  }

  trimClip(id: string, edge: 'start' | 'end', frame: number): void {
    try {
      this.doc.trimClip(id, edge, frame, ORIGIN_LOCAL);
    } catch (err) {
      this.toast('error', (err as Error).message);
    }
  }

  updateClip(id: string, patch: Parameters<ProjectDoc['updateClip']>[1]): void {
    try {
      this.doc.updateClip(id, patch, ORIGIN_LOCAL);
    } catch (err) {
      this.toast('error', (err as Error).message);
    }
  }

  splitAtPlayhead(): void {
    const frame = this.playhead.get().frame;
    const { project } = this.project.get();
    const selection = this.ui.get().selection;
    const candidates = project.clips.filter((c) => (selection.length === 0 || selection.includes(c.id)) && c.startFrame < frame && frame < c.startFrame + c.durationFrames);
    if (candidates.length === 0) return this.toast('info', 'Nothing under the playhead to split');
    this.doc.transact(() => {
      for (const c of candidates) this.doc.splitClip(c.id, frame, ORIGIN_LOCAL);
    }, ORIGIN_LOCAL);
    this.noteUiAction('timeline.split', `Split ${candidates.length} clip${candidates.length === 1 ? '' : 's'} at frame ${frame}`, candidates.map((c) => c.id));
  }

  deleteSelection(): void {
    const ids = this.ui.get().selection;
    if (ids.length === 0) return;
    this.doc.removeClips(ids, ORIGIN_LOCAL);
    this.select([]);
    this.noteUiAction('timeline.remove', `Deleted ${ids.length} clip${ids.length === 1 ? '' : 's'}`);
  }

  removeAsset(id: string): void {
    this.doc.removeAsset(id, ORIGIN_LOCAL);
  }

  addTrack(kind: 'video' | 'audio' | 'overlay'): void {
    this.doc.addTrack(kind, undefined, ORIGIN_LOCAL);
  }

  updateTrack(id: string, patch: Parameters<ProjectDoc['updateTrack']>[1]): void {
    this.doc.updateTrack(id, patch, ORIGIN_LOCAL);
  }

  removeTrack(id: string): void {
    try {
      this.doc.removeTrack(id, ORIGIN_LOCAL);
    } catch (err) {
      this.toast('error', (err as Error).message);
    }
  }

  renameProject(name: string): void {
    if (name.trim()) this.doc.updateMeta({ name: name.trim() }, ORIGIN_LOCAL);
  }

  // ---- FX packs ------------------------------------------------------------------------

  async refreshPacks(): Promise<void> {
    try {
      await this.applyPacks(await this.bridge.request('listPacks', {}));
    } catch (err) {
      this.bridge.log('warn', `listPacks failed: ${(err as Error).message}`);
    }
  }

  /** Mirror the main process's pack list: register metadata + load compiled bundles for ready installed packs. */
  private async applyPacks(packs: PackInfo[]): Promise<void> {
    this.ui.set({ packs });
    const seen = new Set<string>();
    for (const p of packs) {
      if (p.source !== 'installed') continue;
      seen.add(p.name);
      if (p.status === 'ready' && p.manifest && p.bundlePath) {
        const loaded = this.loadedPacks.get(p.name);
        if (loaded?.path !== p.bundlePath) {
          try {
            const mod = await importPackBundle(`http://127.0.0.1:${this.bridge.bootstrap.port}${p.bundlePath}`);
            if (loaded) unregisterRuntimeComponents(loaded.names);
            const names = registerRuntimeComponents(p.name, mod);
            this.loadedPacks.set(p.name, { path: p.bundlePath, names });
          } catch (err) {
            this.bridge.log('error', `pack ${p.name} failed to load: ${(err as Error).message}`);
            this.ui.set((u) => ({ packs: u.packs.map((x) => (x.name === p.name ? { ...x, status: 'error', error: `Load failed: ${(err as Error).message}` } : x)) }));
            continue;
          }
        }
        // (Re)register after the components exist so template listeners see a renderable pack.
        registerPack(p.manifest, 'installed');
      } else {
        this.unloadPack(p.name);
      }
    }
    for (const name of [...this.loadedPacks.keys()]) if (!seen.has(name)) this.unloadPack(name);
  }

  private unloadPack(name: string): void {
    const loaded = this.loadedPacks.get(name);
    if (loaded) unregisterRuntimeComponents(loaded.names);
    this.loadedPacks.delete(name);
    unregisterPack(name);
  }

  /** Enable/disable an installed pack for the current project (stored in project.meta.packs). */
  setPackEnabled(name: string, enabled: boolean): void {
    const current = this.project.get().project.meta.packs ?? [];
    const next = enabled ? [...new Set([...current, name])] : current.filter((n) => n !== name);
    if (next.length === current.length && next.every((n, i) => n === current[i])) return;
    this.doc.updateMeta({ packs: next }, ORIGIN_LOCAL);
    this.noteUiAction('packs.toggle', `${enabled ? 'Added' : 'Removed'} FX pack ${name} ${enabled ? 'to' : 'from'} the project`);
  }

  private async packOp<T>(label: string, fn: () => Promise<T>): Promise<T | null> {
    this.ui.set({ packsBusy: true });
    try {
      const result = await fn();
      await this.refreshPacks();
      return result;
    } catch (err) {
      this.toast('error', `${label}: ${(err as Error).message}`);
      return null;
    } finally {
      this.ui.set({ packsBusy: false });
    }
  }

  async installPackFromDialog(): Promise<void> {
    const dir = await this.bridge.request('choosePackFolder', {}).catch(() => null);
    if (!dir) return;
    await this.installPackDir(dir);
  }

  async installPackDir(dir: string): Promise<void> {
    const info = await this.packOp('Install pack', () => this.bridge.request('installPack', { path: dir }));
    if (info) this.afterInstall(info);
  }

  async installPackFiles(files: { path: string; content: string }[]): Promise<void> {
    const info = await this.packOp('Install pack', () => this.bridge.request('installPackFiles', { files }));
    if (info) this.afterInstall(info);
  }

  private afterInstall(info: PackInfo): void {
    if (info.status === 'ready') {
      this.toast('success', `Installed ${info.label} (${info.templates.length} component${info.templates.length === 1 ? '' : 's'})`);
      this.setPackEnabled(info.name, true);
    } else {
      this.toast('error', `${info.label}: ${info.error ?? 'failed to load'}`);
    }
  }

  async uninstallPack(name: string): Promise<void> {
    await this.packOp('Uninstall pack', () => this.bridge.request('uninstallPack', { name }));
  }

  async reloadPacks(): Promise<void> {
    await this.packOp('Reload packs', () => this.bridge.request('reloadPacks', {}));
  }

  // ---- undo / redo ---------------------------------------------------------------------
  //
  // Two layers: Y.UndoManager for this session (fine-grained, only our own edits — safe in a
  // room), and the persisted checkpoint history in the main process so undo still works after
  // the app was closed. Every in-memory step is mirrored as a cursor move so both stay aligned;
  // when the in-memory stack is empty we step through the persisted checkpoints instead.

  private bindHistory(): void {
    this.history = { count: 0, cursor: -1 };
    if (this.historyPushTimer) clearTimeout(this.historyPushTimer);
    this.historyPushTimer = null;
    const onAdded = (ev: { type: 'undo' | 'redo' }) => {
      if (!this.replaying && ev.type === 'undo') this.scheduleHistoryPush();
      this.refreshUndoState();
    };
    const onUpdated = (ev: { type: 'undo' | 'redo' }) => {
      if (!this.replaying && ev.type === 'undo') this.scheduleHistoryPush();
    };
    const onChanged = () => this.refreshUndoState();
    this.undo.on('stack-item-added', onAdded);
    this.undo.on('stack-item-updated', onUpdated);
    this.undo.on('stack-item-popped', onChanged);
    this.undo.on('stack-cleared', onChanged);
    this.teardown.push(() => {
      this.undo.off('stack-item-added', onAdded);
      this.undo.off('stack-item-updated', onUpdated);
      this.undo.off('stack-item-popped', onChanged);
      this.undo.off('stack-cleared', onChanged);
    });
    this.refreshUndoState();
    this.bridge
      .request('historyStatus', {})
      .then((status) => this.setHistory(status))
      .catch(() => undefined);
  }

  /** Persisted history is whole-project state, so it is only safe to step through when nobody else is editing. */
  private get coldHistoryUsable(): boolean {
    return this.ui.get().room.role === 'none';
  }

  private setHistory(status: HistoryStatus): void {
    this.history = status;
    this.refreshUndoState();
  }

  private refreshUndoState(): void {
    const cold = this.coldHistoryUsable;
    const canUndo = this.undo.undoStack.length > 0 || (cold && this.history.cursor > 0);
    const canRedo = this.undo.redoStack.length > 0 || (cold && this.history.cursor >= 0 && this.history.cursor < this.history.count - 1);
    const ui = this.ui.get();
    if (ui.canUndo !== canUndo || ui.canRedo !== canRedo) this.ui.set({ canUndo, canRedo });
  }

  private scheduleHistoryPush(): void {
    if (this.historyPushTimer) clearTimeout(this.historyPushTimer);
    // A little longer than the undo manager's 300ms capture window so one checkpoint = one undo step.
    this.historyPushTimer = setTimeout(() => this.flushHistoryPush(), 400);
  }

  private flushHistoryPush(): void {
    if (!this.historyPushTimer) return;
    clearTimeout(this.historyPushTimer);
    this.historyPushTimer = null;
    this.bridge
      .request('historyPush', {})
      .then((status) => this.setHistory(status))
      .catch((err: Error) => this.bridge.log('warn', `history push failed: ${err.message}`));
  }

  private historyRequest(name: 'historyMove' | 'historyRestore', params: { delta: number } | { index: number }): void {
    this.bridge
      .request(name as 'historyMove', params as { delta: number })
      .then((status) => this.setHistory(status))
      .catch((err: Error) => this.toast('error', `History: ${err.message}`));
  }

  undoEdit(): void {
    if (this.undo.undoStack.length > 0) {
      this.flushHistoryPush();
      this.replaying = true;
      try {
        this.undo.undo();
      } finally {
        this.replaying = false;
      }
      this.historyRequest('historyMove', { delta: -1 });
    } else if (this.coldHistoryUsable && this.history.cursor > 0) {
      this.historyRequest('historyRestore', { index: this.history.cursor - 1 });
    }
    this.refreshUndoState();
  }

  redoEdit(): void {
    if (this.undo.redoStack.length > 0) {
      this.replaying = true;
      try {
        this.undo.redo();
      } finally {
        this.replaying = false;
      }
      this.historyRequest('historyMove', { delta: 1 });
    } else if (this.coldHistoryUsable && this.history.cursor >= 0 && this.history.cursor < this.history.count - 1) {
      this.historyRequest('historyRestore', { index: this.history.cursor + 1 });
    }
    this.refreshUndoState();
  }

  selectedClip(): Clip | undefined {
    const [id] = this.ui.get().selection;
    return id ? this.project.get().project.clips.find((c) => c.id === id) : undefined;
  }

  // ---- app-level actions ---------------------------------------------------------------

  async save(saveAs = false): Promise<void> {
    try {
      const r = await this.bridge.request('saveProject', { saveAs });
      if (r) {
        this.ui.set({ projectPath: r.path, saving: 'saved' });
        this.toast('success', `Saved to ${r.path}`);
      }
    } catch (err) {
      this.toast('error', (err as Error).message);
    }
  }

  async startRender(presetId: string, outputPath?: string): Promise<void> {
    try {
      const job = await this.bridge.request('startRender', { presetId, outputPath });
      if (job) {
        this.upsertRender(job);
        this.toast('info', `Render started (${presetId})`);
        this.setPanel('renders');
      }
    } catch (err) {
      this.toast('error', (err as Error).message);
    }
  }

  async cancelRender(id: string): Promise<void> {
    const job = await this.bridge.request('cancelRender', { id }).catch(() => null);
    if (job) this.upsertRender(job);
  }

  async hostRoom(password?: string): Promise<void> {
    try {
      const info = await this.bridge.request('hostRoom', { password });
      this.toast('success', `Hosting room ${info.roomCode}`);
    } catch (err) {
      this.toast('error', (err as Error).message);
    }
  }

  async joinRoom(roomCode: string, password?: string, hostUrl?: string): Promise<void> {
    try {
      const info = await this.bridge.request('joinRoom', { roomCode, password, hostUrl: hostUrl || undefined });
      this.toast('success', `Joined room ${info.roomCode}`);
    } catch (err) {
      this.toast('error', (err as Error).message);
    }
  }

  async leaveRoom(): Promise<void> {
    await this.bridge.request('leaveRoom', {}).catch(() => undefined);
  }

  private handleMenuAction(action: string): void {
    switch (action) {
      case 'project:save':
        void this.save(false);
        break;
      case 'project:save-as':
        void this.save(true);
        break;
      case 'assets:import':
        void this.importMedia();
        break;
      case 'render:open':
        this.ui.set({ dialog: 'render' });
        break;
      case 'edit:undo':
        this.undoEdit();
        break;
      case 'edit:redo':
        this.redoEdit();
        break;
      case 'timeline:split':
        this.splitAtPlayhead();
        break;
      case 'timeline:delete':
        this.deleteSelection();
        break;
      case 'room:host':
        void this.hostRoom();
        break;
      case 'room:join':
        this.ui.set({ dialog: 'room' });
        break;
      case 'room:leave':
        void this.leaveRoom();
        break;
      case 'view:zoom-in':
        this.zoomBy(1.25);
        break;
      case 'view:zoom-out':
        this.zoomBy(0.8);
        break;
      default:
        break;
    }
  }
}

// ---- hooks -----------------------------------------------------------------------------

export function useStoreValue<T>(store: { get: () => T; subscribe: (l: () => void) => () => void }): T {
  return useSyncExternalStore(store.subscribe, store.get, store.get);
}

export function useSelector<T, S>(store: { get: () => T; subscribe: (l: () => void) => () => void }, selector: (s: T) => S): S {
  return useSyncExternalStore(
    store.subscribe,
    () => selector(store.get()),
    () => selector(store.get()),
  );
}
