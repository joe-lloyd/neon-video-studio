/** Wire-level constants shared by the main process (servers) and the renderer (clients). */

export const DISCOVERY_MULTICAST_ADDR = '239.255.42.99';
export const DISCOVERY_PORT = 47700;
export const DISCOVERY_INTERVAL_MS = 2000;
export const DISCOVERY_PROTOCOL_VERSION = 1;

/** Beacon sent by a hosting node over UDP multicast every DISCOVERY_INTERVAL_MS. */
export interface DiscoveryBeacon {
  v: typeof DISCOVERY_PROTOCOL_VERSION;
  app: 'neon';
  roomCode: string;
  /** ws://<lan-ip>:<port> base URL of the host's LAN listener */
  url: string;
  hostName: string;
  projectName: string;
  ts: number;
}

export function encodeBeacon(b: DiscoveryBeacon): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(b));
}

export function decodeBeacon(data: Uint8Array | ArrayBuffer | string): DiscoveryBeacon | null {
  try {
    const text = typeof data === 'string' ? data : new TextDecoder().decode(data);
    const parsed = JSON.parse(text) as Partial<DiscoveryBeacon>;
    if (parsed.app !== 'neon' || parsed.v !== DISCOVERY_PROTOCOL_VERSION) return null;
    if (typeof parsed.roomCode !== 'string' || typeof parsed.url !== 'string') return null;
    return parsed as DiscoveryBeacon;
  } catch {
    return null;
  }
}

/** y-webrtc room name for a Neon room code. */
export function webrtcRoomName(roomCode: string): string {
  return `neon-video:${roomCode}`;
}

/** Build the URLs a guest uses to reach a host's LAN listener. */
export function hostEndpoints(baseWsUrl: string, roomCode: string) {
  const base = baseWsUrl.replace(/\/$/, '');
  const httpBase = base.replace(/^ws/, 'http');
  return {
    yjs: `${base}/yjs?room=${encodeURIComponent(roomCode)}`,
    signaling: `${base}/signaling?room=${encodeURIComponent(roomCode)}`,
    assets: `${httpBase}/assets`,
    assetQuery: `room=${encodeURIComponent(roomCode)}`,
  };
}

/** Awareness state published by every peer. */
export interface PeerAwarenessState {
  peerId: string;
  name: string;
  color: string;
  playheadFrame: number;
  selection: string[];
  /** HTTP base URL where this peer serves project assets (so others can fetch missing files). */
  assetBaseUrl?: string;
  updatedAt: number;
}
