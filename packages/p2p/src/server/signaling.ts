/**
 * Minimal y-webrtc-compatible signaling server (topic pub/sub over JSON WebSocket frames).
 * Protocol: {type:'subscribe'|'unsubscribe', topics:[]} · {type:'publish', topic, ...} · {type:'ping'} → {type:'pong'}
 */

export interface SignalSocket {
  send(text: string): void;
  close(code?: number, reason?: string): void;
}

interface SignalMessage {
  type?: string;
  topics?: string[];
  topic?: string;
  [key: string]: unknown;
}

export class SignalingServer {
  private readonly topics = new Map<string, Set<SignalSocket>>();
  private readonly subscriptions = new Map<SignalSocket, Set<string>>();

  get connectionCount(): number {
    return this.subscriptions.size;
  }

  onOpen(sock: SignalSocket): void {
    this.subscriptions.set(sock, new Set());
  }

  onMessage(sock: SignalSocket, raw: string | Uint8Array): void {
    let msg: SignalMessage;
    try {
      msg = JSON.parse(typeof raw === 'string' ? raw : new TextDecoder().decode(raw)) as SignalMessage;
    } catch {
      return;
    }
    const subs = this.subscriptions.get(sock);
    if (!subs || !msg || typeof msg.type !== 'string') return;
    switch (msg.type) {
      case 'subscribe':
        for (const topic of msg.topics ?? []) {
          if (typeof topic !== 'string') continue;
          let set = this.topics.get(topic);
          if (!set) this.topics.set(topic, (set = new Set()));
          set.add(sock);
          subs.add(topic);
        }
        break;
      case 'unsubscribe':
        for (const topic of msg.topics ?? []) {
          this.topics.get(topic)?.delete(sock);
          subs.delete(topic);
        }
        break;
      case 'publish': {
        if (typeof msg.topic !== 'string') return;
        const receivers = this.topics.get(msg.topic);
        if (!receivers) return;
        msg.clients = receivers.size;
        const text = JSON.stringify(msg);
        for (const r of receivers) this.safeSend(r, text);
        break;
      }
      case 'ping':
        this.safeSend(sock, JSON.stringify({ type: 'pong' }));
        break;
      default:
        break;
    }
  }

  onClose(sock: SignalSocket): void {
    const subs = this.subscriptions.get(sock);
    if (subs) {
      for (const topic of subs) {
        const set = this.topics.get(topic);
        set?.delete(sock);
        if (set && set.size === 0) this.topics.delete(topic);
      }
    }
    this.subscriptions.delete(sock);
  }

  private safeSend(sock: SignalSocket, text: string): void {
    try {
      sock.send(text);
    } catch {
      this.onClose(sock);
    }
  }
}
