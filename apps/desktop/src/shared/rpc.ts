/**
 * Typed RPC contract between the Bun main process and the webview. Types only — no runtime code.
 */
import type { RPCSchema } from 'electrobun/view';
import type { ActivityEntry, AiCapabilities, AiJob, AiOperation, AppStatus, ImportAssetResponse, RenderJob, RoomInfo } from '@neon/core';

export interface Bootstrap {
  version: string;
  port: number;
  token: string;
  peerId: string;
  peerName: string;
  projectId: string;
  projectPath: string | null;
  projectName: string;
  platform: string;
  isDev: boolean;
  room: RoomState;
}

export type RoomState =
  | { role: 'none' }
  | { role: 'host'; roomCode: string; password?: string; signaling: string[]; lanUrl: string }
  | { role: 'guest'; roomCode: string; password?: string; hostUrl: string };

export type WindowCommand = 'minimize' | 'maximize' | 'close' | 'toggleFullscreen';

export type DesktopRPC = {
  bun: RPCSchema<{
    requests: {
      getBootstrap: { params: Record<string, never>; response: Bootstrap };
      getStatus: { params: Record<string, never>; response: AppStatus };
      importMediaDialog: { params: { at?: number; trackId?: string }; response: ImportAssetResponse[] };
      importPaths: { params: { paths: string[]; at?: number; trackId?: string }; response: ImportAssetResponse[] };
      newProject: { params: { name?: string }; response: { projectId: string } };
      openProjectDialog: { params: Record<string, never>; response: { path: string } | null };
      openProject: { params: { path: string }; response: { path: string } };
      saveProject: { params: { saveAs?: boolean }; response: { path: string } | null };
      startRender: { params: { outputPath?: string; presetId: string; from?: number; to?: number }; response: RenderJob | null };
      cancelRender: { params: { id: string }; response: RenderJob | null };
      listRenders: { params: Record<string, never>; response: RenderJob[] };
      hostRoom: { params: { password?: string }; response: RoomInfo };
      joinRoom: { params: { roomCode: string; password?: string; hostUrl?: string }; response: RoomInfo };
      leaveRoom: { params: Record<string, never>; response: RoomInfo };
      revealPath: { params: { path: string }; response: boolean };
      windowCommand: { params: { command: WindowCommand }; response: boolean };
      setPeerName: { params: { name: string }; response: boolean };
      aiRun: { params: { op: AiOperation; params: Record<string, unknown> }; response: AiJob };
      aiStatus: { params: Record<string, never>; response: AiCapabilities };
      aiJobs: { params: Record<string, never>; response: AiJob[] };
      aiCancel: { params: { id: string }; response: AiJob | null };
      cutRanges: { params: { ranges: { start: number; end: number }[]; trackIds?: string[] }; response: { removedFrames: number; cuts: number } };
    };
    messages: {
      rendererReady: { ok: true };
      log: { level: 'info' | 'warn' | 'error'; message: string };
    };
  }>;
  webview: RPCSchema<{
    requests: Record<string, never>;
    messages: {
      renderUpdate: { job: RenderJob };
      roomUpdate: { room: RoomState; info: RoomInfo };
      projectOpened: { projectId: string; path: string | null; name: string };
      toast: { kind: 'info' | 'success' | 'error'; message: string };
      menuAction: { action: string };
      activity: { entry: ActivityEntry };
      aiUpdate: { job: AiJob };
      previewControl: { action: 'play' | 'pause' | 'toggle' | 'seek'; frame?: number };
      uiControl: { panel?: 'assets' | 'templates' | 'inspector' | 'peers' | 'renders' | 'activity' | 'ai' | 'script'; select?: string[]; dialog?: 'render' | 'room' | 'shortcuts' | 'none' };
    };
  }>;
};
