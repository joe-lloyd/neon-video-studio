/**
 * Neon Video Studio — Bun main process (Electrobun 2).
 *
 * Responsibilities: own the project document + persistence, run the local control API
 * (CLI/agents), host Yjs sync + WebRTC signaling + asset server, drive renders, manage rooms.
 */
import Electrobun, { BrowserView, BrowserWindow, Updater, Utils } from 'electrobun/main';
import { randomBytes } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { SUPPORTED_EXTENSIONS, clearInstanceInfo, writeInstanceInfo } from '@neon/core/node';
import { ORIGIN_LOCAL, type ImportAssetResponse } from '@neon/core';
import { AssetManager } from './assets.ts';
import type { MainContext } from './context.ts';
import { buildStatus, startControlServer } from './control-server.ts';
import { installMenu } from './menu.ts';
import { paths } from './paths.ts';
import { ProjectStore } from './project-store.ts';
import { RenderManager } from './render-manager.ts';
import { RoomManager } from './room.ts';
import { loadSettings, saveSettings } from './settings.ts';
import { SyncHub } from './sync-hub.ts';
import { EventHub } from './events.ts';
import { AiManager } from './ai-manager.ts';
import { registerAllPacks } from '@neon/remotion-workspace/packs';
import type { Bootstrap, DesktopRPC } from '../shared/rpc.ts';

const VERSION = '0.2.1';
const DEV_SERVER_URL = 'http://localhost:5173';

async function resolveViewUrl(port: number, token: string): Promise<{ url: string; isDev: boolean }> {
  let channel = 'dev';
  try {
    channel = await Updater.localInfo.channel();
  } catch {
    /* treat as dev */
  }
  if (channel === 'dev') {
    try {
      await fetch(DEV_SERVER_URL, { method: 'HEAD', signal: AbortSignal.timeout(800) });
      console.log(`[main] using Vite dev server at ${DEV_SERVER_URL}`);
      // Pass the control-API credentials in the URL so the UI still works over HTTP if the
      // Electrobun RPC transport is unavailable on the dev-server origin.
      return { url: `${DEV_SERVER_URL}/?port=${port}&token=${encodeURIComponent(token)}`, isDev: true };
    } catch {
      /* fall through */
    }
  }
  return { url: 'views://mainview/index.html', isDev: channel === 'dev' };
}

async function main(): Promise<void> {
  registerAllPacks();
  const startedAt = Date.now();
  await mkdir(paths.home(), { recursive: true, mode: 0o700 });
  await mkdir(paths.renders(), { recursive: true });
  const settings = await loadSettings();
  const store = await ProjectStore.openOrCreate(settings);
  const token = randomBytes(24).toString('base64url');

  const ctx: MainContext = {
    version: VERSION,
    token,
    settings,
    store,
    assets: null as unknown as AssetManager,
    renders: null as unknown as RenderManager,
    sync: null as unknown as SyncHub,
    room: null as unknown as RoomManager,
    events: new EventHub(),
    ai: null as unknown as AiManager,
    localPort: 0,
    startedAt,
    rpc: null,
    isDev: false,
  };
  ctx.assets = new AssetManager(store, settings.peerId);
  ctx.sync = new SyncHub(store);
  ctx.room = new RoomManager(ctx);
  ctx.ai = new AiManager(ctx);
  ctx.renders = new RenderManager({
    getProject: () => store.toJSON(),
    projectDir: () => store.dir,
    assetBaseUrl: () => `http://127.0.0.1:${ctx.localPort}/assets`,
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
  await writeInstanceInfo({
    pid: process.pid,
    port: local.port,
    token,
    startedAt: new Date(startedAt).toISOString(),
    version: VERSION,
    projectPath: store.isScratch ? null : store.dir,
  });
  console.log(`[main] control API on http://127.0.0.1:${local.port} (token in ${paths.home()}/instance.json)`);

  // ---- RPC with the renderer ------------------------------------------------------------

  const importPaths = async (files: string[], at?: number, trackId?: string): Promise<ImportAssetResponse[]> => {
    const results: ImportAssetResponse[] = [];
    for (const file of files) {
      try {
        results.push(await ctx.assets.import(file, { insertAt: at, trackId }));
      } catch (err) {
        ctx.rpc?.send.toast({ kind: 'error', message: `${basename(file)}: ${(err as Error).message}` });
      }
    }
    return results;
  };

  const bootstrap = (): Bootstrap => ({
    version: VERSION,
    port: local.port,
    token,
    peerId: settings.peerId,
    peerName: settings.peerName,
    projectId: store.projectId,
    projectPath: store.isScratch ? null : store.dir,
    projectName: store.doc.isInitialized ? store.doc.getMeta().name : 'Syncing…',
    platform: process.platform,
    isDev: ctx.isDev,
    room: ctx.room.state,
  });

  let win: BrowserWindow | null = null;

  const rpc = BrowserView.defineRPC<DesktopRPC>({
    maxRequestTime: 120_000,
    handlers: {
      requests: {
        getBootstrap: () => bootstrap(),
        getStatus: () => buildStatus(ctx),
        importMediaDialog: async ({ at, trackId }) => {
          const files = await Utils.openFileDialog({
            startingFolder: paths.home(),
            allowedFileTypes: SUPPORTED_EXTENSIONS.join(','),
            canChooseFiles: true,
            canChooseDirectory: false,
            allowsMultipleSelection: true,
          });
          return importPaths(files, at, trackId);
        },
        importPaths: ({ paths: files, at, trackId }) => importPaths(files, at, trackId),
        newProject: async ({ name }) => {
          await store.adopt(await ProjectStore.create({ name }));
          return { projectId: store.projectId };
        },
        openProjectDialog: async () => {
          const [dir] = await Utils.openFileDialog({ canChooseFiles: false, canChooseDirectory: true, allowsMultipleSelection: false });
          if (!dir) return null;
          await store.adopt(await ProjectStore.openDir(dir));
          return { path: store.dir };
        },
        openProject: async ({ path }) => {
          await store.adopt(await ProjectStore.openDir(path));
          return { path: store.dir };
        },
        saveProject: async ({ saveAs }) => {
          if (saveAs || store.isScratch) {
            const [parent] = await Utils.openFileDialog({ canChooseFiles: false, canChooseDirectory: true, allowsMultipleSelection: false });
            if (!parent) return null;
            const name = store.doc.getMeta().name.replace(/[^a-zA-Z0-9-_ ]/g, '').trim() || 'project';
            return { path: await store.saveAs(join(parent, `${name}.neon`)) };
          }
          return { path: await store.save() };
        },
        startRender: ({ outputPath, presetId, from, to }) => {
          try {
            const frameRange: [number, number] | null = from !== undefined || to !== undefined ? [from ?? 0, to ?? Math.max(0, store.doc.durationFrames() - 1)] : null;
            return ctx.renders.start({ outputPath, presetId, frameRange });
          } catch (err) {
            ctx.rpc?.send.toast({ kind: 'error', message: (err as Error).message });
            return null;
          }
        },
        cancelRender: ({ id }) => ctx.renders.cancel(id) ?? null,
        listRenders: () => ctx.renders.list(),
        hostRoom: ({ password }) => ctx.room.host(password),
        joinRoom: (params) => ctx.room.join(params),
        leaveRoom: () => ctx.room.leave(),
        revealPath: ({ path }) => {
          Utils.showItemInFolder(path);
          return true;
        },
        windowCommand: ({ command }) => {
          if (!win) return false;
          switch (command) {
            case 'minimize':
              win.minimize();
              break;
            case 'maximize':
              if (win.isMaximized()) win.unmaximize();
              else win.maximize();
              break;
            case 'close':
              win.requestClose();
              break;
            case 'toggleFullscreen':
              win.setFullScreen(!win.isFullScreen());
              break;
          }
          return true;
        },
        aiRun: ({ op, params }) => ctx.ai.start(op, params),
        aiStatus: () => ctx.ai.capabilities(),
        aiJobs: () => ctx.ai.list(),
        aiCancel: ({ id }) => ctx.ai.cancel(id) ?? null,
        cutRanges: ({ ranges, trackIds }) => store.doc.cutRanges(ranges, { trackIds, ripple: true, crossfadeFrames: 2 }, ORIGIN_LOCAL),
        detachAudio: ({ id }) => store.doc.detachAudio(id, ORIGIN_LOCAL),
        recentProjects: async () => {
          const { readFile: rf } = await import('node:fs/promises');
          const out: { path: string; name: string; updatedAt: string; current: boolean }[] = [];
          for (const dir of [store.dir, ...settings.recent.filter((d) => d !== store.dir)].slice(0, 12)) {
            try {
              const meta = (JSON.parse(await rf(join(dir, 'project.json'), 'utf8')) as { meta: { name: string; updatedAt: string } }).meta;
              out.push({ path: dir, name: meta.name, updatedAt: meta.updatedAt, current: dir === store.dir });
            } catch {
              /* project folder gone — skip */
            }
          }
          return out;
        },
        newProjectAt: async ({ name, fps, width, height, dir }) => {
          const fresh = await ProjectStore.create({ name, fps, width, height });
          if (dir) {
            await fresh.saveAs(join(dir, `${(name ?? 'project').replace(/[^a-zA-Z0-9-_ ]/g, '').trim() || 'project'}.neon`));
          }
          await store.adopt(fresh);
          return { projectId: store.projectId, path: store.isScratch ? null : store.dir };
        },
        chooseFolder: async () => {
          const [dir] = await Utils.openFileDialog({ canChooseFiles: false, canChooseDirectory: true, allowsMultipleSelection: false });
          return dir ?? null;
        },
        setPeerName: async ({ name }) => {
          settings.peerName = name.trim().slice(0, 40) || settings.peerName;
          await saveSettings(settings);
          return true;
        },
      },
      messages: {
        rendererReady: () => {
          console.log('[main] renderer ready');
          ctx.rpc?.send.roomUpdate({ room: ctx.room.state, info: ctx.room.info() });
        },
        log: ({ level, message }) => {
          const fn = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
          fn(`[renderer] ${message}`);
        },
      },
    },
  });
  ctx.rpc = rpc;
  // Everything that happens becomes a live activity line in the UI and on /api/events.
  ctx.events.subscribe((event) => {
    if (event.type === 'activity') rpc.send.activity({ entry: event.entry });
  });
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
    settings.lastProjectPath = store.dir;
    settings.recent = [store.dir, ...settings.recent.filter((p) => p !== store.dir)].slice(0, 10);
    await saveSettings(settings);
    await writeInstanceInfo({ pid: process.pid, port: local.port, token, startedAt: new Date(startedAt).toISOString(), version: VERSION, projectPath: store.isScratch ? null : store.dir });
    rpc.send.projectOpened({ projectId: store.projectId, path: store.isScratch ? null : store.dir, name: store.doc.isInitialized ? store.doc.getMeta().name : 'Syncing…' });
    ctx.events.emit({ type: 'project-opened', projectId: store.projectId, path: store.isScratch ? null : store.dir, name: store.doc.isInitialized ? store.doc.getMeta().name : 'Syncing…' });
    ctx.events.activity('system', 'project.switched', `Now editing “${store.doc.isInitialized ? store.doc.getMeta().name : basename(store.dir)}” (${store.dir})`);
  });
  settings.lastProjectPath = store.dir;
  await saveSettings(settings);

  // ---- window ---------------------------------------------------------------------------

  const view = await resolveViewUrl(local.port, token);
  ctx.isDev = view.isDev;
  win = new BrowserWindow({
    title: 'Neon Video Studio',
    url: view.url,
    frame: { width: 1480, height: 920, x: 80, y: 60 },
    titleBarStyle: 'hiddenInset',
    rpc,
  });

  installMenu((action) => {
    void (async () => {
      switch (action) {
        case 'project:new':
          await store.adopt(await ProjectStore.create({}));
          break;
        case 'project:open': {
          const [dir] = await Utils.openFileDialog({ canChooseFiles: false, canChooseDirectory: true, allowsMultipleSelection: false });
          if (dir) await store.adopt(await ProjectStore.openDir(dir));
          break;
        }
        case 'project:save':
        case 'project:save-as':
        case 'assets:import':
        case 'render:open':
        case 'edit:undo':
        case 'edit:redo':
        case 'timeline:split':
        case 'timeline:delete':
        case 'room:host':
        case 'room:join':
        case 'room:leave':
        case 'view:zoom-in':
        case 'view:zoom-out':
          rpc.send.menuAction({ action });
          break;
        case 'project:reveal':
          Utils.showItemInFolder(store.dir);
          break;
        case 'renders:reveal':
          Utils.openPath(paths.renders());
          break;
        case 'view:fullscreen':
          win?.setFullScreen(!win.isFullScreen());
          break;
        case 'help:cli':
          rpc.send.toast({ kind: 'info', message: 'Run `pnpm cli --help` in the repo (or neon-cli --help when linked).' });
          break;
        case 'help:remotion-license':
          Utils.openExternal('https://www.remotion.pro/license');
          break;
        case 'about':
          rpc.send.toast({ kind: 'info', message: `Neon Video Studio ${VERSION} · Electrobun + Bun ${Bun.version} · Remotion` });
          break;
        default:
          console.log('[menu] unhandled action', action);
      }
    })().catch((err) => {
      console.error('[menu] action failed', err);
      rpc.send.toast({ kind: 'error', message: (err as Error).message });
    });
  });

  // ---- shutdown -------------------------------------------------------------------------

  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    console.log('[main] shutting down');
    ctx.renders.cancelAll();
    void ctx.room.leave();
    local.stop();
    void clearInstanceInfo(process.pid);
  };
  Electrobun.events.on('before-quit', () => {
    cleanup();
    // Flush is async; best effort — autosave keeps the on-disk copy at most 1.5s stale.
    void store.flush();
  });
  process.on('exit', cleanup);
  process.on('SIGINT', () => {
    cleanup();
    process.exit(0);
  });
  process.on('SIGTERM', () => {
    cleanup();
    process.exit(0);
  });

  ctx.events.activity('system', 'app.ready', `Neon Video Studio ${VERSION} ready · project “${store.doc.getMeta().name}” · API :${local.port}`);
  console.log(`[main] Neon Video Studio ${VERSION} ready (project: ${store.doc.getMeta().name} @ ${store.dir})`);
}

main().catch((err) => {
  console.error('[main] fatal', err);
  process.exit(1);
});
