/**
 * Room lifecycle. Hosting starts a LAN listener (sync + signaling + assets) and a discovery
 * beacon; joining resolves the host on the LAN and swaps in an empty document that fills up
 * through sync. The renderer's PeerSession does the actual WebRTC/WebSocket connections.
 */
import { newRoomCode, normalizeRoomCode, type RoomInfo } from '@neon/core';
import { hostEndpoints } from '@neon/p2p';
import type { RoomState } from '../shared/rpc.ts';
import { Beacon, lanAddresses, resolveRoom } from './discovery.ts';
import type { MainContext } from './context.ts';
import { ProjectStore } from './project-store.ts';
import { startLanServer } from './control-server.ts';

export class RoomManager {
  state: RoomState = { role: 'none' };
  private lan: { port: number; stop(): void } | null = null;
  private readonly beacon = new Beacon();
  private readonly listeners = new Set<(info: RoomInfo) => void>();

  private readonly ctx: MainContext;

  constructor(ctx: MainContext) {
    this.ctx = ctx;
  }

  info(): RoomInfo {
    const peers = this.ctx.sync.peers(this.ctx.settings.peerId);
    if (this.state.role === 'host') {
      return { roomCode: this.state.roomCode, role: 'host', lanUrl: this.state.lanUrl, signalingUrls: this.state.signaling, peers };
    }
    if (this.state.role === 'guest') {
      return { roomCode: this.state.roomCode, role: 'guest', lanUrl: this.state.hostUrl, signalingUrls: [hostEndpoints(this.state.hostUrl, this.state.roomCode).signaling], peers };
    }
    return { roomCode: '', role: 'none', signalingUrls: [], peers };
  }

  onChange(listener: (info: RoomInfo) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  notify(): void {
    const info = this.info();
    for (const l of this.listeners) l(info);
    this.ctx.rpc?.send.roomUpdate({ room: this.state, info });
  }

  async host(password?: string): Promise<RoomInfo> {
    await this.leave();
    const roomCode = newRoomCode();
    this.lan = await startLanServer(this.ctx, roomCode);
    const ip = lanAddresses()[0] ?? '127.0.0.1';
    const lanUrl = `ws://${ip}:${this.lan.port}`;
    const signaling = [`ws://127.0.0.1:${this.lan.port}/signaling?room=${encodeURIComponent(roomCode)}`];
    this.state = { role: 'host', roomCode, password, signaling, lanUrl };
    this.beacon.start(() => ({
      roomCode,
      url: lanUrl,
      hostName: this.ctx.settings.peerName,
      projectName: this.ctx.store.doc.isInitialized ? this.ctx.store.doc.getMeta().name : 'project',
    }));
    console.log(`[room] hosting ${roomCode} at ${lanUrl}`);
    this.ctx.events.activity('room', 'room.hosting', `Room ${roomCode} open on the LAN (${lanUrl}) — waiting for peers`);
    this.notify();
    return this.info();
  }

  async join(input: { roomCode: string; password?: string; hostUrl?: string }): Promise<RoomInfo> {
    const roomCode = normalizeRoomCode(input.roomCode);
    let hostUrl = input.hostUrl;
    if (!hostUrl) {
      const beacon = await resolveRoom(roomCode, 4000);
      if (!beacon) {
        throw new Error(`No host advertising room ${roomCode} was found on this network. Pass hostUrl (ws://ip:port) explicitly.`);
      }
      hostUrl = beacon.url;
    }
    // Verify the host is reachable before throwing away the current project.
    const probe = await fetch(`${hostUrl.replace(/^ws/, 'http')}/room?room=${encodeURIComponent(roomCode)}`).catch(() => null);
    if (!probe || !probe.ok) throw new Error(`Host ${hostUrl} did not accept room ${roomCode}`);

    await this.leave();
    const fresh = await ProjectStore.createForJoin(roomCode);
    await this.ctx.store.adopt(fresh);
    const endpoints = hostEndpoints(hostUrl, roomCode);
    this.ctx.assets.remoteBases = [`${endpoints.assets}?${endpoints.assetQuery}`];
    this.state = { role: 'guest', roomCode, password: input.password, hostUrl };
    console.log(`[room] joined ${roomCode} via ${hostUrl}`);
    this.ctx.events.activity('room', 'room.joined', `Joined room ${roomCode} via ${hostUrl} — syncing project from host`);
    this.notify();
    return this.info();
  }

  async leave(): Promise<RoomInfo> {
    if (this.state.role === 'none') return this.info();
    this.beacon.stop();
    this.lan?.stop();
    this.lan = null;
    this.ctx.assets.remoteBases = [];
    this.state = { role: 'none' };
    this.notify();
    return this.info();
  }

  isRoom(code: string | null): boolean {
    return this.state.role === 'host' && code !== null && normalizeRoomCode(code) === this.state.roomCode;
  }
}
