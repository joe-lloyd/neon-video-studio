import type { AssetManager } from './assets.ts';
import type { ProjectStore } from './project-store.ts';
import type { RenderManager } from './render-manager.ts';
import type { RoomManager } from './room.ts';
import type { Settings } from './settings.ts';
import type { SyncHub } from './sync-hub.ts';
import type { EventHub } from './events.ts';
import type { AiManager } from './ai-manager.ts';
import type { VoiceRecorder } from './recorder.ts';
import type { UpdateManager } from './updates.ts';
import type { HistoryStore } from './history.ts';
import type { WaveformCache } from './waveforms.ts';
import type { PackManager } from './packs.ts';
import type { DesktopRPC } from '../shared/rpc.ts';

/** Minimal shape of the Electrobun RPC object we use from the main side. */
export interface MainRpc {
  send: {
    [K in keyof DesktopRPC['webview']['messages']]: (payload: DesktopRPC['webview']['messages'][K]) => void;
  };
}

export interface MainContext {
  version: string;
  token: string;
  settings: Settings;
  store: ProjectStore;
  assets: AssetManager;
  renders: RenderManager;
  sync: SyncHub;
  room: RoomManager;
  events: EventHub;
  ai: AiManager;
  recorder: VoiceRecorder;
  updates: UpdateManager;
  history: HistoryStore;
  waveforms: WaveformCache;
  packs: PackManager;
  localPort: number;
  startedAt: number;
  rpc: MainRpc | null;
  isDev: boolean;
}
