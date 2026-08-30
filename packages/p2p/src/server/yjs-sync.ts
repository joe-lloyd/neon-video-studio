/**
 * Runtime-agnostic implementation of the y-websocket server protocol (compatible with the
 * `y-websocket` WebsocketProvider). Plug it into Bun.serve, `ws`, or anything that can hand
 * us binary frames.
 */
import * as Y from 'yjs';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';
import * as syncProtocol from 'y-protocols/sync';
import * as awarenessProtocol from 'y-protocols/awareness';

export const MESSAGE_SYNC = 0;
export const MESSAGE_AWARENESS = 1;
export const MESSAGE_AUTH = 2;
export const MESSAGE_QUERY_AWARENESS = 3;

export interface SyncSocket {
  send(data: Uint8Array): void;
  close(code?: number, reason?: string): void;
}

export class YjsSyncServer {
  readonly doc: Y.Doc;
  readonly awareness: awarenessProtocol.Awareness;
  private readonly conns = new Map<SyncSocket, Set<number>>();

  private readonly ownsAwareness: boolean;

  constructor(doc: Y.Doc, awareness?: awarenessProtocol.Awareness) {
    this.doc = doc;
    this.ownsAwareness = !awareness;
    this.awareness = awareness ?? new awarenessProtocol.Awareness(doc);
    this.awareness.setLocalState(null);
    this.doc.on('update', this.onDocUpdate);
    this.awareness.on('update', this.onAwarenessUpdate);
  }

  get connectionCount(): number {
    return this.conns.size;
  }

  destroy(): void {
    this.doc.off('update', this.onDocUpdate);
    this.awareness.off('update', this.onAwarenessUpdate);
    for (const sock of [...this.conns.keys()]) this.onClose(sock);
    // The Awareness we created runs a cleanup interval that would otherwise keep the process alive.
    if (this.ownsAwareness) this.awareness.destroy();
  }

  onOpen(sock: SyncSocket): void {
    this.conns.set(sock, new Set());
    // Sync step 1: tell the client what we have.
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, MESSAGE_SYNC);
    syncProtocol.writeSyncStep1(enc, this.doc);
    this.safeSend(sock, encoding.toUint8Array(enc));
    // Current awareness states.
    const states = this.awareness.getStates();
    if (states.size > 0) {
      const aenc = encoding.createEncoder();
      encoding.writeVarUint(aenc, MESSAGE_AWARENESS);
      encoding.writeVarUint8Array(aenc, awarenessProtocol.encodeAwarenessUpdate(this.awareness, Array.from(states.keys())));
      this.safeSend(sock, encoding.toUint8Array(aenc));
    }
  }

  onMessage(sock: SyncSocket, data: Uint8Array): void {
    try {
      const dec = decoding.createDecoder(data);
      const enc = encoding.createEncoder();
      const type = decoding.readVarUint(dec);
      switch (type) {
        case MESSAGE_SYNC: {
          encoding.writeVarUint(enc, MESSAGE_SYNC);
          syncProtocol.readSyncMessage(dec, enc, this.doc, sock);
          if (encoding.length(enc) > 1) this.safeSend(sock, encoding.toUint8Array(enc));
          break;
        }
        case MESSAGE_AWARENESS: {
          const update = decoding.readVarUint8Array(dec);
          // Remember which client ids this socket controls so we can clean up on close.
          const controlled = this.conns.get(sock);
          if (controlled) {
            const peek = decoding.createDecoder(update);
            const len = decoding.readVarUint(peek);
            for (let i = 0; i < len; i++) {
              const clientId = decoding.readVarUint(peek);
              decoding.readVarUint(peek); // clock
              const state = JSON.parse(decoding.readVarString(peek)) as unknown;
              if (state === null) controlled.delete(clientId);
              else controlled.add(clientId);
            }
          }
          awarenessProtocol.applyAwarenessUpdate(this.awareness, update, sock);
          break;
        }
        case MESSAGE_QUERY_AWARENESS: {
          encoding.writeVarUint(enc, MESSAGE_AWARENESS);
          encoding.writeVarUint8Array(
            enc,
            awarenessProtocol.encodeAwarenessUpdate(this.awareness, Array.from(this.awareness.getStates().keys())),
          );
          this.safeSend(sock, encoding.toUint8Array(enc));
          break;
        }
        default:
          break; // MESSAGE_AUTH and unknown types are ignored.
      }
    } catch (err) {
      console.error('[yjs-sync] bad message', err);
    }
  }

  onClose(sock: SyncSocket): void {
    const controlled = this.conns.get(sock);
    this.conns.delete(sock);
    if (controlled && controlled.size > 0) {
      awarenessProtocol.removeAwarenessStates(this.awareness, Array.from(controlled), null);
    }
  }

  private onDocUpdate = (update: Uint8Array, origin: unknown): void => {
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, MESSAGE_SYNC);
    syncProtocol.writeUpdate(enc, update);
    const payload = encoding.toUint8Array(enc);
    for (const sock of this.conns.keys()) {
      if (sock === origin) continue; // the sender already has it
      this.safeSend(sock, payload);
    }
  };

  private onAwarenessUpdate = (
    { added, updated, removed }: { added: number[]; updated: number[]; removed: number[] },
    _origin: unknown,
  ): void => {
    const changed = added.concat(updated, removed);
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, MESSAGE_AWARENESS);
    encoding.writeVarUint8Array(enc, awarenessProtocol.encodeAwarenessUpdate(this.awareness, changed));
    const payload = encoding.toUint8Array(enc);
    for (const sock of this.conns.keys()) this.safeSend(sock, payload);
  };

  private safeSend(sock: SyncSocket, data: Uint8Array): void {
    try {
      sock.send(data);
    } catch {
      this.onClose(sock);
      try {
        sock.close();
      } catch {
        /* ignore */
      }
    }
  }
}
