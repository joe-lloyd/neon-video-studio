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
} from '@neon/core';
import { PeerSession, type SessionSnapshot } from '@neon/p2p/browser';
import type { Bridge } from './bridge.ts';
import type { RoomState } from '../../shared/rpc.ts';

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
  /** Word range selected in the Script panel (inclusive indexes). */
  scriptSelection: { assetId: string; from: number; to: number } | null;
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
  });
  readonly playhead = createStore<PlayheadState>({ frame: 0, playing: false });
  /** Set by the Preview component so the editor can drive the Remotion Player. */
  player: { seekTo(frame: number): void; play(): void; pause(): void; toggle(): void; getCurrentFrame(): number } | null = null;
  private teardown: (() => void)[] = [];
  private projectId: string;

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
      },
      projectOpened: ({ projectId, name, path }) => {
        this.ui.set({ projectName: name, projectPath: path, selection: [] });
        if (projectId !== this.projectId) {
          this.projectId = projectId;
          this.attachDocument();
        }
      },
      toast: ({ kind, message }) => this.toast(kind, message),
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

  /** Cut the words currently selected in the Script panel out of the timeline. */
  async cutScriptSelection(): Promise<void> {
    const sel = this.ui.get().scriptSelection;
    if (!sel) return;
    await this.runAi('transcript-cut', { assetId: sel.assetId, fromWord: Math.min(sel.from, sel.to), toWord: Math.max(sel.from, sel.to) });
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

  insertTemplate(componentName: string, atFrame?: number): void {
    try {
      const clip = this.doc.insertClip({ kind: 'component', componentName, startFrame: atFrame ?? this.playhead.get().frame, placement: 'free' }, ORIGIN_LOCAL);
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

  undoEdit(): void {
    this.undo.undo();
  }

  redoEdit(): void {
    this.undo.redo();
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
