import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { ffmpegInput, localSource } from '../src/node/probe.ts';

test('localSource downloads http sources once and ffmpegInput then points at the copy', async () => {
  let hits = 0;
  const body = Buffer.from('not really an mp4, but bytes are bytes');
  const server = createServer((_req, res) => {
    hits++;
    res.writeHead(200, { 'Content-Type': 'video/mp4' }).end(body);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  const src = `http://127.0.0.1:${port}/assets/abc.mp4`;
  try {
    assert.equal(ffmpegInput(src), src, 'before download the URL passes through');
    const [a, b] = await Promise.all([localSource(src), localSource(src)]);
    assert.equal(a, b);
    assert.equal(hits, 1, 'concurrent callers share one download');
    assert.match(a, /\.mp4$/);
    assert.deepEqual(await readFile(a), body);
    assert.equal(ffmpegInput(src), a);
  } finally {
    server.close();
  }
});

test('localSource maps file URLs and leaves plain paths alone; failed downloads are not cached', async () => {
  assert.equal(await localSource(pathToFileURL('/tmp/clip.mp4').href), '/tmp/clip.mp4');
  assert.equal(await localSource('/tmp/clip.mp4'), '/tmp/clip.mp4');
  const server = createServer((_req, res) => res.writeHead(404).end());
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const src = `http://127.0.0.1:${(server.address() as { port: number }).port}/missing.mp4`;
  try {
    await assert.rejects(localSource(src), /HTTP 404/);
    await assert.rejects(localSource(src), /HTTP 404/);
  } finally {
    server.close();
  }
});
