/**
 * Browser-side peer session: keeps one Y.Doc in sync with
 *   1. the local desktop main process (WebsocketProvider → ws://127.0.0.1:port/yjs)
 *   2. remote peers in a room (WebrtcProvider, signaling hosted by the room host — no cloud)
 *   3. the room host's LAN WebSocket as a fallback when WebRTC cannot connect
 * All providers share one Awareness instance so presence is visible over every transport.
 */
import type * as Y from 'yjs';
import { WebsocketProvider } from 'y-websocket';
import { WebrtcProvider } from 'y-webrtc';
import type { Awareness } from 'y-protocols/awareness';
import { hostEndpoints, webrtcRoomName, type PeerAwarenessState } from '../protocol.ts';

export interface PeerSessionOptions {
  doc: Y.Doc;
  /** ws://127.0.0.1:PORT/yjs */
  localUrl: string;
  /** Auth params appended to the local URL (e.g. { token }). */
  localParams?: Record<string, string>;
  peerId: string;
  name: string;
  color: string;
  assetBaseUrl?: string;
}

export interface JoinRoomOptions {
  roomCode: string;
  password?: string;
  /** ws://<host-ip>:<port> base of the host's LAN listener. */
  hostUrl?: string;
  /** Extra signaling servers (e.g. a self-hosted y-webrtc signaling instance). */
  signaling?: string[];
}

export interface RemotePeer extends PeerAwarenessState {
  clientId: number;
  isLocal: boolean;
}

export interface SessionSnapshot {
  localSynced: boolean;
  localConnected: boolean;
  room: { roomCode: string; hostUrl?: string } | null;
  webrtcPeers: number;
  lanConnected: boolean;
  peers: RemotePeer[];
}

type Listener = (snapshot: SessionSnapshot) => void;

export class PeerSession {
  readonly doc: Y.Doc;
  readonly local: WebsocketProvider;
  readonly awareness: Awareness;
  private webrtc: WebrtcProvider | null = null;
  private lan: WebsocketProvider | null = null;
  private room: { roomCode: string; hostUrl?: string } | null = null;
  private readonly listeners = new Set<Listener>();
  private readonly opts: PeerSessionOptions;
  private snapshotCache: SessionSnapshot | null = null;

  constructor(opts: PeerSessionOptions) {
    this.opts = opts;
    this.doc = opts.doc;
    this.local = new WebsocketProvider(opts.localUrl, '', opts.doc, {
      params: opts.localParams ?? {},
      disableBc: true,
    });
    this.awareness = this.local.awareness;
    this.setPresence({ playheadFrame: 0, selection: [] });
    this.local.on('status', this.notify);
    this.local.on('sync', this.notify);
    this.awareness.on('change', this.notify);
  }

  // ---- presence -------------------------------------------------------------------------

  private presence(): PeerAwarenessState {
    return (this.awareness.getLocalState() as PeerAwarenessState | null) ?? this.basePresence();
  }

  private basePresence(): PeerAwarenessState {
    return {
      peerId: this.opts.peerId,
      name: this.opts.name,
      color: this.opts.color,
      playheadFrame: 0,
      selection: [],
      assetBaseUrl: this.opts.assetBaseUrl,
      updatedAt: Date.now(),
    };
  }

  setPresence(patch: Partial<PeerAwarenessState>): void {
    this.awareness.setLocalState({ ...this.basePresence(), ...this.presence(), ...patch, updatedAt: Date.now() });
  }

  setPlayhead(frame: number): void {
    const current = this.presence();
    if (current.playheadFrame === frame) return;
    this.awareness.setLocalStateField('playheadFrame', frame);
    this.awareness.setLocalStateField('updatedAt', Date.now());
  }

  setSelection(ids: string[]): void {
    this.awareness.setLocalStateField('selection', ids);
  }

  // ---- rooms -----------------------------------------------------------------------------

  joinRoom(options: JoinRoomOptions): void {
    this.leaveRoom();
    const signaling = [...(options.signaling ?? [])];
    if (options.hostUrl) {
      const endpoints = hostEndpoints(options.hostUrl, options.roomCode);
      signaling.unshift(endpoints.signaling);
      this.lan = new WebsocketProvider(endpoints.yjs, '', this.doc, {
        awareness: this.awareness,
        disableBc: true,
        params: {},
      });
      this.lan.on('status', this.notify);
      this.lan.on('sync', this.notify);
    }
    if (signaling.length > 0) {
      this.webrtc = new WebrtcProvider(webrtcRoomName(options.roomCode), this.doc, {
        signaling,
        password: options.password ?? options.roomCode,
        awareness: this.awareness,
        filterBcConns: true,
        maxConns: 20,
      });
      this.webrtc.on('peers', this.notify);
      this.webrtc.on('status', this.notify);
      this.webrtc.on('synced', this.notify);
    }
    this.room = { roomCode: options.roomCode, hostUrl: options.hostUrl };
    this.notify();
  }

  leaveRoom(): void {
    if (this.webrtc) {
      this.webrtc.destroy();
      this.webrtc = null;
    }
    if (this.lan) {
      this.lan.destroy();
      this.lan = null;
    }
    this.room = null;
    this.notify();
  }

  // ---- observation ----------------------------------------------------------------------

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  getSnapshot = (): SessionSnapshot => {
    if (this.snapshotCache) return this.snapshotCache;
    const peers: RemotePeer[] = [];
    for (const [clientId, state] of this.awareness.getStates()) {
      const s = state as Partial<PeerAwarenessState>;
      if (!s || typeof s.peerId !== 'string') continue;
      peers.push({
        clientId,
        isLocal: clientId === this.doc.clientID,
        peerId: s.peerId,
        name: s.name ?? 'peer',
        color: s.color ?? '#FF007F',
        playheadFrame: s.playheadFrame ?? 0,
        selection: s.selection ?? [],
        assetBaseUrl: s.assetBaseUrl,
        updatedAt: s.updatedAt ?? 0,
      });
    }
    peers.sort((a, b) => Number(b.isLocal) - Number(a.isLocal) || a.name.localeCompare(b.name));
    this.snapshotCache = {
      localSynced: this.local.synced,
      localConnected: this.local.wsconnected,
      room: this.room,
      webrtcPeers: this.webrtc ? this.webrtc.room?.webrtcConns.size ?? 0 : 0,
      lanConnected: this.lan?.wsconnected ?? false,
      peers,
    };
    return this.snapshotCache;
  };

  private notify = (): void => {
    this.snapshotCache = null;
    const snap = this.getSnapshot();
    for (const l of this.listeners) l(snap);
  };

  destroy(): void {
    this.leaveRoom();
    this.awareness.off('change', this.notify);
    this.local.destroy();
    this.listeners.clear();
  }
}
