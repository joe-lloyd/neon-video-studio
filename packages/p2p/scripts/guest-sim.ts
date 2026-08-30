/**
 * Simulates a remote guest from Node (no browser, no WebRTC):
 *   1. listens for the host's UDP discovery beacon (or takes --host-url),
 *   2. connects to the host's LAN y-websocket endpoint and waits for the doc to sync,
 *   3. inserts a clip as the guest and checks the host sees it (via the local control API),
 *   4. exercises the y-webrtc signaling relay (subscribe/publish/pong).
 *
 *   node packages/p2p/scripts/guest-sim.ts <ROOM-CODE> [--host-url ws://ip:port]
 */
import * as Y from 'yjs';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';
import * as syncProtocol from 'y-protocols/sync';
import { ProjectDoc, ORIGIN_API } from '@neon/core';
import { hostEndpoints, DISCOVERY_MULTICAST_ADDR, DISCOVERY_PORT, decodeBeacon } from '@neon/p2p';
import dgram from 'node:dgram';

const [, , roomArg, ...rest] = process.argv;
if (!roomArg) throw new Error('usage: p2p-guest-sim.ts <ROOM-CODE> [--host-url ws://ip:port]');
const roomCode = roomArg.toUpperCase();
let hostUrl = rest.includes('--host-url') ? rest[rest.indexOf('--host-url') + 1] : undefined;

function log(step: string, detail: unknown = ''): void {
  console.log(`[guest] ${step}`, typeof detail === 'string' ? detail : JSON.stringify(detail));
}

async function discover(): Promise<string> {
  return new Promise((resolve, reject) => {
    const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    const timer = setTimeout(() => {
      sock.close();
      reject(new Error('no beacon received within 6s'));
    }, 6000);
    sock.on('message', (msg, rinfo) => {
      const b = decodeBeacon(msg);
      if (b && b.roomCode === roomCode) {
        clearTimeout(timer);
        sock.close();
        log('beacon received', { from: rinfo.address, url: b.url, host: b.hostName, project: b.projectName });
        resolve(b.url);
      }
    });
    sock.bind(DISCOVERY_PORT, () => sock.addMembership(DISCOVERY_MULTICAST_ADDR));
  });
}

async function main(): Promise<void> {
  if (!hostUrl) hostUrl = await discover();
  const ep = hostEndpoints(hostUrl, roomCode);

  // -- room probe
  const probe = await fetch(`${hostUrl.replace(/^ws/, 'http')}/room?room=${roomCode}`);
  log('room probe', { status: probe.status, body: await probe.json() });
  const bad = await fetch(`${hostUrl.replace(/^ws/, 'http')}/room?room=WRONG-CODE-0000`);
  log('wrong room rejected', bad.status === 403 ? 'yes (403)' : `NO (${bad.status})`);

  // -- y-websocket sync as a guest
  const doc = new Y.Doc();
  const project = new ProjectDoc(doc);
  const ws = new WebSocket(ep.yjs);
  ws.binaryType = 'arraybuffer';
  const synced = new Promise<void>((resolve) => {
    ws.onmessage = (ev) => {
      const data = new Uint8Array(ev.data as ArrayBuffer);
      const dec = decoding.createDecoder(data);
      const type = decoding.readVarUint(dec);
      if (type !== 0) return;
      const enc = encoding.createEncoder();
      encoding.writeVarUint(enc, 0);
      const msgType = syncProtocol.readSyncMessage(dec, enc, doc, 'host');
      if (encoding.length(enc) > 1) ws.send(encoding.toUint8Array(enc));
      if (msgType === syncProtocol.messageYjsSyncStep2) resolve();
    };
  });
  await new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve();
    ws.onerror = () => reject(new Error('ws connect failed'));
  });
  const enc = encoding.createEncoder();
  encoding.writeVarUint(enc, 0);
  syncProtocol.writeSyncStep1(enc, doc);
  ws.send(encoding.toUint8Array(enc));
  await synced;
  const before = project.toJSON();
  log('synced from host', { name: before.meta.name, tracks: before.tracks.length, clips: before.clips.length, assets: before.assets.length });

  // -- edit as guest → host
  doc.on('update', (update, origin) => {
    if (origin === 'host') return;
    const e = encoding.createEncoder();
    encoding.writeVarUint(e, 0);
    syncProtocol.writeUpdate(e, update);
    ws.send(encoding.toUint8Array(e));
  });
  const clip = project.insertClip({ kind: 'component', componentName: 'TitleCard', props: { title: 'From guest' }, startFrame: 0 }, ORIGIN_API);
  log('inserted clip as guest', clip.id);

  // -- asset fetch through the LAN listener
  const firstAsset = before.assets[0];
  if (firstAsset) {
    const res = await fetch(`${ep.assets}/${firstAsset.id}?${ep.assetQuery}`, { headers: { Range: 'bytes=0-15' } });
    log('asset range fetch', { status: res.status, type: res.headers.get('content-type'), range: res.headers.get('content-range') });
  }

  // -- signaling relay
  const sig = new WebSocket(ep.signaling);
  await new Promise<void>((resolve) => (sig.onopen = () => resolve()));
  const pong = new Promise<string>((resolve) => (sig.onmessage = (ev) => resolve(String(ev.data))));
  sig.send(JSON.stringify({ type: 'subscribe', topics: ['t'] }));
  sig.send(JSON.stringify({ type: 'ping' }));
  log('signaling pong', await pong);
  const echoed = new Promise<string>((resolve) => (sig.onmessage = (ev) => resolve(String(ev.data))));
  sig.send(JSON.stringify({ type: 'publish', topic: 't', data: 'hello' }));
  log('signaling publish echoed to subscriber', await echoed);
  sig.close();

  await new Promise((r) => setTimeout(r, 500));
  ws.close();
  process.stdout.write(`GUEST_CLIP_ID=${clip.id}\n`);
}

main().catch((err) => {
  console.error('[guest] FAILED', err);
  process.exit(1);
});
