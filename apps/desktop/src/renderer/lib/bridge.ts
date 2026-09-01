/**
 * Bridge to the main process. Inside the Electrobun webview we use typed RPC; in a plain
 * browser (Vite dev without Electrobun) we fall back to the HTTP control API with a token
 * from the URL (?port=…&token=…) or localStorage.
 */
import type { AiCapabilities, AiJob, AppStatus, ImportAssetResponse, RenderJob, RoomInfo } from '@neon/core';
import { newId } from '@neon/core';
import type { Bootstrap, DesktopRPC, RoomState, WindowCommand } from '../../shared/rpc.ts';

type Requests = DesktopRPC['bun']['requests'];
type Messages = DesktopRPC['webview']['messages'];
export type MessageHandlers = { [K in keyof Messages]?: (payload: Messages[K]) => void };

export interface Bridge {
  readonly mode: 'electrobun' | 'http';
  bootstrap: Bootstrap;
  request<K extends keyof Requests>(name: K, params: Requests[K]['params']): Promise<Requests[K]['response']>;
  onMessage(handlers: MessageHandlers): void;
  ready(): void;
  log(level: 'info' | 'warn' | 'error', message: string): void;
}

const RPC_TIMEOUT_MS = 6000;

function httpBootstrapParams(): { port: number; token: string } | null {
  const url = new URL(window.location.href);
  const port = url.searchParams.get('port') ?? localStorage.getItem('neon:port');
  const token = url.searchParams.get('token') ?? localStorage.getItem('neon:token');
  if (!port || !token) return null;
  localStorage.setItem('neon:port', port);
  localStorage.setItem('neon:token', token);
  return { port: Number(port), token };
}

async function tryElectrobun(): Promise<Bridge | null> {
  let mod: typeof import('electrobun/view');
  try {
    mod = await import('electrobun/view');
  } catch {
    return null;
  }
  if ((mod.Electroview as unknown as { isStub?: boolean }).isStub) return null;

  const handlers: MessageHandlers = {};
  // Every message type declared in DesktopRPC['webview']['messages'] must be forwarded here;
  // a missing entry silently drops the message (a bug we hit once — keep this list in sync).
  const MESSAGE_TYPES: (keyof Messages)[] = ['renderUpdate', 'roomUpdate', 'projectOpened', 'toast', 'menuAction', 'activity', 'previewControl', 'uiControl', 'aiUpdate', 'updateStatus'];
  const forward = Object.fromEntries(
    MESSAGE_TYPES.map((type) => [type, (payload: unknown) => (handlers[type] as ((p: unknown) => void) | undefined)?.(payload)]),
  ) as { [K in keyof Messages]: (payload: Messages[K]) => void };
  let rpc: ReturnType<typeof mod.Electroview.defineRPC<DesktopRPC>>;
  try {
    rpc = mod.Electroview.defineRPC<DesktopRPC>({
      maxRequestTime: 120_000,
      handlers: {
        requests: {},
        messages: forward,
      },
    });
    new mod.Electroview({ rpc });
  } catch (err) {
    console.warn('[bridge] Electroview unavailable', err);
    return null;
  }

  let bootstrap: Bootstrap;
  try {
    bootstrap = await Promise.race([
      rpc.request.getBootstrap({}),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('rpc timeout')), RPC_TIMEOUT_MS)),
    ]);
  } catch (err) {
    console.warn('[bridge] getBootstrap failed, falling back to HTTP', err);
    return null;
  }

  return {
    mode: 'electrobun',
    bootstrap,
    request: (name, params) => (rpc.request[name] as (p: unknown) => Promise<never>)(params),
    onMessage: (h) => Object.assign(handlers, h),
    ready: () => rpc.send.rendererReady({ ok: true }),
    log: (level, message) => rpc.send.log({ level, message }),
  };
}

async function httpBridge(): Promise<Bridge> {
  const params = httpBootstrapParams();
  if (!params) {
    throw new Error(
      'Not running inside Neon Video Studio. For browser development open this page with ?port=<port>&token=<token> from ~/.neon-video/instance.json.',
    );
  }
  const base = `http://127.0.0.1:${params.port}`;
  const call = async <T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> => {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: { Authorization: `Bearer ${params.token}`, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const json = (await res.json()) as { ok: boolean; data: T; error?: { message: string } };
    if (!json.ok) throw new Error(json.error?.message ?? 'request failed');
    return json.data;
  };
  const status = await call<AppStatus>('GET', '/api/status');
  const room: RoomState =
    status.room.role === 'host'
      ? { role: 'host', roomCode: status.room.roomCode, signaling: status.room.signalingUrls, lanUrl: status.room.lanUrl ?? '' }
      : status.room.role === 'guest'
        ? { role: 'guest', roomCode: status.room.roomCode, hostUrl: status.room.lanUrl ?? '' }
        : { role: 'none' };
  const bootstrap: Bootstrap = {
    version: status.version,
    port: params.port,
    token: params.token,
    peerId: localStorage.getItem('neon:peerId') ?? newId('browser'),
    peerName: 'browser',
    projectId: status.project.id,
    projectPath: status.project.path,
    projectName: status.project.name,
    platform: 'browser',
    isDev: true,
    room,
  };
  localStorage.setItem('neon:peerId', bootstrap.peerId);
  const handlers: MessageHandlers = {};

  // Poll renders + room since we have no push channel in HTTP mode.
  let lastRenders = '';
  setInterval(async () => {
    try {
      const s = await call<AppStatus>('GET', '/api/status');
      const key = JSON.stringify(s.renders);
      if (key !== lastRenders) {
        lastRenders = key;
        for (const job of s.renders) handlers.renderUpdate?.({ job });
      }
      const aiJobs = await call<AiJob[]>('GET', '/api/ai/jobs');
      for (const job of aiJobs) handlers.aiUpdate?.({ job });
      if (s.project.id !== bootstrap.projectId) {
        bootstrap.projectId = s.project.id;
        handlers.projectOpened?.({ projectId: s.project.id, path: s.project.path, name: s.project.name });
      }
    } catch {
      /* app gone */
    }
  }, 2000);

  const unsupported = (name: string) => Promise.reject(new Error(`${name} needs the desktop app (browser mode)`));
  return {
    mode: 'http',
    bootstrap,
    request: async (name, params) => {
      switch (name) {
        case 'getBootstrap':
          return bootstrap as never;
        case 'getStatus':
          return call<AppStatus>('GET', '/api/status') as never;
        case 'startRender': {
          const p = params as Requests['startRender']['params'];
          return call<RenderJob>('POST', '/api/render', { output: p.outputPath, preset: p.presetId, from: p.from, to: p.to }) as never;
        }
        case 'cancelRender':
          return call<RenderJob>('POST', `/api/render/${(params as { id: string }).id}/cancel`) as never;
        case 'listRenders':
          return (await call<AppStatus>('GET', '/api/status')).renders as never;
        case 'hostRoom':
          return call<RoomInfo>('POST', '/api/room/host', params) as never;
        case 'joinRoom':
          return call<RoomInfo>('POST', '/api/room/join', params) as never;
        case 'leaveRoom':
          return call<RoomInfo>('POST', '/api/room/leave', {}) as never;
        case 'importPaths': {
          const p = params as Requests['importPaths']['params'];
          const out: ImportAssetResponse[] = [];
          for (const path of p.paths) out.push(await call<ImportAssetResponse>('POST', '/api/assets/import', { path, insert: p.at !== undefined ? { at: p.at, trackId: p.trackId } : undefined }));
          return out as never;
        }
        case 'saveProject':
          return call<{ path: string }>('POST', '/api/project/save', {}) as never;
        case 'newProject':
          return call('POST', '/api/project/new', params) as never;
        case 'aiRun': {
          const p = params as Requests['aiRun']['params'];
          return call<AiJob>('POST', `/api/ai/${p.op}`, p.params) as never;
        }
        case 'aiStatus':
          return call<AiCapabilities>('GET', '/api/ai/status') as never;
        case 'aiJobs':
          return call<AiJob[]>('GET', '/api/ai/jobs') as never;
        case 'aiCancel':
          return call<AiJob>('POST', `/api/ai/jobs/${(params as { id: string }).id}/cancel`) as never;
        case 'cutRanges':
          return call('POST', '/api/timeline/cut', params) as never;
        case 'voStart':
          return call('POST', '/api/record/start') as never;
        case 'voStop':
          return call('POST', '/api/record/stop', { at: (params as { startFrame: number }).startFrame }) as never;
        case 'voCancel':
          return true as never;
        case 'windowCommand':
          return false as never;
        case 'updateCheck':
        case 'updateApply':
          return { phase: 'unsupported', currentVersion: bootstrap.version, error: 'updates need the desktop app' } as never;
        default:
          return unsupported(String(name));
      }
    },
    onMessage: (h) => Object.assign(handlers, h),
    ready: () => undefined,
    log: (level, message) => console[level](message),
  };
}

export async function connectBridge(): Promise<Bridge> {
  return (await tryElectrobun()) ?? httpBridge();
}

export type { Bootstrap, RoomState, WindowCommand };
