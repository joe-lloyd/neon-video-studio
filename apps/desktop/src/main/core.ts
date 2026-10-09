/**
 * The window-free half of the main process: project store, control API, sync, renders, AI and
 * recording. The desktop entry (index.ts) adds the Electrobun window + RPC on top; the headless
 * entry (headless.ts) runs it as-is so the CLI and agents can work without a GUI.
 *
 * Nothing here may import `electrobun/*` — headless runs on plain Bun.
 */
import { randomBytes } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { clearInstanceInfo, isProcessAlive, readInstanceInfo, writeInstanceInfo } from '@neon/core/node';
import { registerAllPacks } from '@neon/remotion-workspace/packs';
import { AssetManager } from './assets.ts';
import type { MainContext } from './context.ts';
import { startControlServer, type RunningServer } from './control-server.ts';
import { paths, repoRoot } from './paths.ts';
import { ProjectStore } from './project-store.ts';
import { RenderManager } from './render-manager.ts';
import { RoomManager } from './room.ts';
import { loadSettings, saveSettings } from './settings.ts';
import { SyncHub } from './sync-hub.ts';
import { EventHub } from './events.ts';
import { AiManager } from './ai-manager.ts';
import { VoiceRecorder } from './recorder.ts';
import { ScreenRecorder } from './screen-recorder.ts';
import { ensureRenderRuntime } from './render-runtime.ts';
import { HistoryStore } from './history.ts';
import { WaveformCache } from './waveforms.ts';
import { PackManager } from './packs.ts';

export const VERSION = '0.8.3';

export interface Core {
  ctx: MainContext;
  local: RunningServer;
  /** Rewrite ~/.neon-video/instance.json (after a project switch). */
  writeInstance(): Promise<void>;
  /** Stop renders, leave the room, close the server, clear instance.json. Idempotent. */
  shutdown(): void;
}

/** Refuse to start a second instance: two processes would fight over instance.json. */
async function assertNoLiveInstance(): Promise<void> {
  const existing = await readInstanceInfo();
  if (existing && existing.pid !== process.pid && isProcessAlive(existing.pid)) {
    throw new Error(`Neon Video Studio is already running (pid ${existing.pid}, ${existing.headless ? 'headless' : 'desktop'}, port ${existing.port}). Stop it first.`);
  }
}

export async function bootCore(opts: { headless: boolean }): Promise<Core> {
  registerAllPacks();
  await assertNoLiveInstance();
  const startedAt = Date.now();
  await mkdir(paths.home(), { recursive: true, mode: 0o700 });
  await mkdir(paths.renders(), { recursive: true });
  const settings = await loadSettings();
  const store = await ProjectStore.openOrCreate(settings);
  const token = randomBytes(24).toString('base64url');

  // Services that need the context are assigned right below, before anything can read them.
  const events = new EventHub();
  const ctx = {
    version: VERSION,
    token,
    settings,
    store,
    events,
    recorder: new VoiceRecorder(() => ctx.capture.busy()),
    localPort: 0,
    startedAt,
    rpc: null,
    isDev: false,
    headless: opts.headless,
    requestExit: null,
  } as Omit<MainContext, 'assets' | 'capture' | 'renders' | 'sync' | 'room' | 'ai' | 'history' | 'waveforms' | 'packs'> as MainContext;
  ctx.assets = new AssetManager(store, settings.peerId);
  ctx.capture = new ScreenRecorder(ctx);
  ctx.waveforms = new WaveformCache(ctx.assets);
  ctx.history = new HistoryStore(store);
  await ctx.history.load();
  let examplesDir: string | null = null;
  try {
    examplesDir = join(repoRoot(), 'examples/packs');
  } catch {
    /* packaged app: no in-repo examples */
  }
  ctx.packs = new PackManager({ examplesDir, onChange: (packs) => ctx.rpc?.send.packsChanged({ packs }) });
  await ctx.packs.load();
  ctx.sync = new SyncHub(store);
  ctx.room = new RoomManager(ctx);
  ctx.ai = new AiManager(ctx);
  ctx.renders = new RenderManager({
    getProject: () => store.toJSON(),
    projectDir: () => store.dir,
    assetBaseUrl: () => `http://127.0.0.1:${ctx.localPort}/assets`,
    renderRuntime: (onLog) => ensureRenderRuntime({ version: VERSION, settings }, onLog),
    packsFor: (project) => ctx.packs.renderPacks(project.meta.packs),
    onUpdate: (job) => {
      ctx.rpc?.send.renderUpdate({ job });
      ctx.events.emit({ type: 'render', job });
      if (job.status === 'done') {
        ctx.rpc?.send.toast({ kind: 'success', message: `Rendered ${basename(job.outputPath)}` });
        ctx.events.activity('render', 'render.done', `Rendered ${job.totalFrames} frames → ${job.outputPath}`, { jobId: job.id });
      }
      if (job.status === 'failed') {
        ctx.rpc?.send.toast({ kind: 'error', message: `Render failed: ${job.error ?? 'unknown error'}` });
        ctx.events.activity('render', 'render.failed', `Render failed: ${job.error ?? 'unknown error'}`, { jobId: job.id });
      }
      if (job.status === 'rendering' && job.renderedFrames === 0) ctx.events.activity('render', 'render.started', `Rendering ${job.totalFrames} frames (${job.presetId})`, { jobId: job.id });
    },
  });

  const local = await startControlServer(ctx);
  ctx.localPort = local.port;
  const writeInstance = () =>
    writeInstanceInfo({
      pid: process.pid,
      port: local.port,
      token,
      startedAt: new Date(startedAt).toISOString(),
      version: VERSION,
      projectPath: store.isScratch ? null : store.dir,
      headless: opts.headless,
    });
  await writeInstance();
  console.log(`[main] control API on http://127.0.0.1:${local.port} (token in ${paths.home()}/instance.json)`);

  ctx.room.onChange((info) => ctx.events.emit({ type: 'room', room: info }));
  let knownPeers = new Map<string, string>();
  ctx.sync.onPeersChanged(() => {
    const now = ctx.sync.peerNames();
    for (const [id, name] of now) if (!knownPeers.has(id) && id !== settings.peerId) ctx.events.activity('peer', 'peer.joined', `${name} joined`);
    for (const [id, name] of knownPeers) if (!now.has(id) && id !== settings.peerId) ctx.events.activity('peer', 'peer.left', `${name} left`);
    knownPeers = now;
    ctx.rpc?.send.roomUpdate({ room: ctx.room.state, info: ctx.room.info() });
  });
  let changeTimer: ReturnType<typeof setTimeout> | null = null;
  store.on('changed', () => {
    if (changeTimer) return;
    changeTimer = setTimeout(() => {
      changeTimer = null;
      ctx.events.emit({ type: 'project-changed', durationFrames: store.doc.durationFrames(), clips: store.toJSON().clips.length, updatedAt: new Date().toISOString() });
    }, 250);
  });
  store.on('doc-replaced', async () => {
    await ctx.history.load();
    settings.lastProjectPath = store.dir;
    settings.recent = [store.dir, ...settings.recent.filter((p) => p !== store.dir)].slice(0, 10);
    await saveSettings(settings);
    await writeInstance();
    const name = store.doc.isInitialized ? store.doc.getMeta().name : 'Syncing…';
    ctx.rpc?.send.projectOpened({ projectId: store.projectId, path: store.isScratch ? null : store.dir, name });
    ctx.events.emit({ type: 'project-opened', projectId: store.projectId, path: store.isScratch ? null : store.dir, name });
    ctx.events.activity('system', 'project.switched', `Now editing “${store.doc.isInitialized ? store.doc.getMeta().name : basename(store.dir)}” (${store.dir})`);
  });
  settings.lastProjectPath = store.dir;
  await saveSettings(settings);

  let stopped = false;
  const shutdown = () => {
    if (stopped) return;
    stopped = true;
    console.log('[main] shutting down');
    ctx.renders.cancelAll();
    void ctx.recorder.discard();
    void ctx.capture.cancel();
    void ctx.room.leave();
    local.stop();
    void clearInstanceInfo(process.pid);
  };

  // Fresh machine? Install the core media engines (ffmpeg/ffprobe, yt-dlp) so everything just works.
  setTimeout(() => void ctx.ai.autoProvision(), 3000);
  return { ctx, local, writeInstance, shutdown };
}
