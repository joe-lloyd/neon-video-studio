/**
 * Binds the y-websocket-compatible sync server and the y-webrtc signaling server to the
 * store's live document, rebinding whenever the document is replaced (new/open/join).
 */
import { SignalingServer, YjsSyncServer } from '@neon/p2p/server';
import type { PeerAwarenessState } from '@neon/p2p';
import type { PeerInfo } from '@neon/core';
import type { ProjectStore } from './project-store.ts';

export class SyncHub {
  sync: YjsSyncServer;
  readonly signaling = new SignalingServer();
  private readonly peerListeners = new Set<() => void>();
  private readonly rebindListeners = new Set<() => void>();

  private readonly store: ProjectStore;

  constructor(store: ProjectStore) {
    this.store = store;
    this.sync = new YjsSyncServer(store.doc.doc);
    this.sync.awareness.on('change', this.notifyPeers);
    store.on('doc-replaced', () => this.rebind());
  }

  private rebind(): void {
    this.sync.awareness.off('change', this.notifyPeers);
    this.sync.destroy();
    // Sockets bound to the old document must be dropped; clients reconnect with a fresh doc.
    for (const l of this.rebindListeners) l();
    this.sync = new YjsSyncServer(this.store.doc.doc);
    this.sync.awareness.on('change', this.notifyPeers);
    this.notifyPeers();
  }

  /** Awareness states of everyone connected (through the local renderer or LAN). */
  peers(localPeerId: string): PeerInfo[] {
    const out: PeerInfo[] = [];
    for (const [clientId, raw] of this.sync.awareness.getStates()) {
      const s = raw as Partial<PeerAwarenessState>;
      if (!s || typeof s.peerId !== 'string') continue;
      out.push({
        clientId,
        peerId: s.peerId,
        name: s.name ?? 'peer',
        color: s.color ?? '#FF007F',
        playheadFrame: s.playheadFrame,
        selection: s.selection,
        isLocal: s.peerId === localPeerId,
        transport: s.peerId === localPeerId ? 'local' : 'webrtc',
      });
    }
    return out;
  }

  /** Names of all peers currently present (for join/leave diffing). */
  peerNames(): Map<string, string> {
    const out = new Map<string, string>();
    for (const raw of this.sync.awareness.getStates().values()) {
      const s = raw as Partial<PeerAwarenessState>;
      if (s && typeof s.peerId === 'string') out.set(s.peerId, s.name ?? 'peer');
    }
    return out;
  }

  onPeersChanged(listener: () => void): () => void {
    this.peerListeners.add(listener);
    return () => this.peerListeners.delete(listener);
  }

  onRebind(listener: () => void): () => void {
    this.rebindListeners.add(listener);
    return () => this.rebindListeners.delete(listener);
  }

  private notifyPeers = (): void => {
    for (const l of this.peerListeners) l();
  };
}
