/** LAN discovery over UDP multicast — no mDNS daemon or cloud service required. */
import dgram from 'node:dgram';
import { networkInterfaces } from 'node:os';
import { DISCOVERY_INTERVAL_MS, DISCOVERY_MULTICAST_ADDR, DISCOVERY_PORT, decodeBeacon, encodeBeacon, type DiscoveryBeacon } from '@neon/p2p';

export function lanAddresses(): string[] {
  const out: string[] = [];
  for (const [name, addrs] of Object.entries(networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family !== 'IPv4' || a.internal) continue;
      if (/^(utun|awdl|llw|bridge|docker|vboxnet)/.test(name)) continue;
      out.push(a.address);
    }
  }
  return out;
}

export class Beacon {
  private socket: dgram.Socket | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;

  start(info: () => Omit<DiscoveryBeacon, 'v' | 'app' | 'ts'>): void {
    this.stop();
    const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    socket.on('error', (err) => console.warn('[discovery] beacon socket error', err.message));
    socket.bind(0, () => {
      try {
        socket.setMulticastTTL(1);
        socket.setBroadcast(true);
      } catch {
        /* ignore */
      }
    });
    this.socket = socket;
    const send = () => {
      const payload = encodeBeacon({ v: 1, app: 'neon', ts: Date.now(), ...info() });
      socket.send(payload, 0, payload.length, DISCOVERY_PORT, DISCOVERY_MULTICAST_ADDR, () => undefined);
      // Also plain broadcast for networks that filter multicast.
      socket.send(payload, 0, payload.length, DISCOVERY_PORT, '255.255.255.255', () => undefined);
    };
    this.timer = setInterval(send, DISCOVERY_INTERVAL_MS);
    setTimeout(send, 50);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.socket?.close();
    this.socket = null;
  }
}

/** Listen for beacons until one matching `roomCode` arrives (or the timeout elapses). */
export function resolveRoom(roomCode: string, timeoutMs = 4000): Promise<DiscoveryBeacon | null> {
  return new Promise((resolve) => {
    const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    let done = false;
    const finish = (value: DiscoveryBeacon | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      socket.close();
      resolve(value);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    socket.on('error', (err) => {
      console.warn('[discovery] resolve socket error', err.message);
      finish(null);
    });
    socket.on('message', (msg) => {
      const beacon = decodeBeacon(msg);
      if (beacon && beacon.roomCode === roomCode) finish(beacon);
    });
    socket.bind(DISCOVERY_PORT, () => {
      try {
        socket.addMembership(DISCOVERY_MULTICAST_ADDR);
      } catch (err) {
        console.warn('[discovery] multicast membership failed', (err as Error).message);
      }
    });
  });
}
