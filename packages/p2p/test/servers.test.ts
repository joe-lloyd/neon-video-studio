import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as Y from 'yjs';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';
import * as syncProtocol from 'y-protocols/sync';
import { YjsSyncServer, MESSAGE_SYNC, type SyncSocket } from '../src/server/yjs-sync.ts';
import { SignalingServer, type SignalSocket } from '../src/server/signaling.ts';
import { decodeBeacon, encodeBeacon, hostEndpoints } from '../src/protocol.ts';

/** A fake client that speaks the y-websocket protocol against the server in-memory. */
function fakeClient(server: YjsSyncServer): { doc: Y.Doc; sock: SyncSocket; close(): void } {
  const doc = new Y.Doc();
  const sock: SyncSocket = {
    send(data) {
      const dec = decoding.createDecoder(data);
      const type = decoding.readVarUint(dec);
      if (type !== MESSAGE_SYNC) return;
      const enc = encoding.createEncoder();
      encoding.writeVarUint(enc, MESSAGE_SYNC);
      syncProtocol.readSyncMessage(dec, enc, doc, 'server');
      if (encoding.length(enc) > 1) server.onMessage(sock, encoding.toUint8Array(enc));
    },
    close() {},
  };
  doc.on('update', (update, origin) => {
    if (origin === 'server') return;
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, MESSAGE_SYNC);
    syncProtocol.writeUpdate(enc, update);
    server.onMessage(sock, encoding.toUint8Array(enc));
  });
  server.onOpen(sock);
  // client sends its own sync step 1
  const enc = encoding.createEncoder();
  encoding.writeVarUint(enc, MESSAGE_SYNC);
  syncProtocol.writeSyncStep1(enc, doc);
  server.onMessage(sock, encoding.toUint8Array(enc));
  return { doc, sock, close: () => server.onClose(sock) };
}

test('YjsSyncServer syncs two clients through the server doc', () => {
  const serverDoc = new Y.Doc();
  serverDoc.getMap('m').set('seed', 1);
  const server = new YjsSyncServer(serverDoc);
  const a = fakeClient(server);
  const b = fakeClient(server);
  assert.equal(a.doc.getMap('m').get('seed'), 1);
  a.doc.getMap('m').set('fromA', 'x');
  assert.equal(serverDoc.getMap('m').get('fromA'), 'x');
  assert.equal(b.doc.getMap('m').get('fromA'), 'x');
  b.doc.getMap('m').set('fromB', 'y');
  assert.equal(a.doc.getMap('m').get('fromB'), 'y');
  assert.equal(server.connectionCount, 2);
  a.close();
  assert.equal(server.connectionCount, 1);
  server.destroy();
});

test('SignalingServer relays publish to subscribers of a topic', () => {
  const server = new SignalingServer();
  const received: Record<string, string[]> = { a: [], b: [], c: [] };
  const mk = (name: string): SignalSocket => ({ send: (t) => received[name]!.push(t), close() {} });
  const a = mk('a');
  const b = mk('b');
  const c = mk('c');
  for (const s of [a, b, c]) server.onOpen(s);
  server.onMessage(a, JSON.stringify({ type: 'subscribe', topics: ['room1'] }));
  server.onMessage(b, JSON.stringify({ type: 'subscribe', topics: ['room1'] }));
  server.onMessage(c, JSON.stringify({ type: 'subscribe', topics: ['room2'] }));
  server.onMessage(a, JSON.stringify({ type: 'publish', topic: 'room1', data: 'hello' }));
  assert.equal(received.a!.length, 1);
  assert.equal(received.b!.length, 1);
  assert.equal(received.c!.length, 0);
  assert.equal(JSON.parse(received.b![0]!).clients, 2);
  server.onMessage(c, JSON.stringify({ type: 'ping' }));
  assert.deepEqual(JSON.parse(received.c![0]!), { type: 'pong' });
  server.onClose(a);
  server.onMessage(b, JSON.stringify({ type: 'publish', topic: 'room1', data: 'again' }));
  assert.equal(received.a!.length, 1);
  assert.equal(received.b!.length, 2);
});

test('beacon encode/decode + host endpoints', () => {
  const beacon = { v: 1 as const, app: 'neon' as const, roomCode: 'AAAA-BBBB-CCCC', url: 'ws://10.0.0.5:47611', hostName: 'mac', projectName: 'P', ts: 1 };
  assert.deepEqual(decodeBeacon(encodeBeacon(beacon)), beacon);
  assert.equal(decodeBeacon('{"app":"other"}'), null);
  const ep = hostEndpoints('ws://10.0.0.5:47611/', 'AAAA-BBBB-CCCC');
  assert.equal(ep.yjs, 'ws://10.0.0.5:47611/yjs?room=AAAA-BBBB-CCCC');
  assert.equal(ep.assets, 'http://10.0.0.5:47611/assets');
});
