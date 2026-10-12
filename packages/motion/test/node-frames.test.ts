import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { deflateSync } from 'node:zlib';
import { FrameServer, ImageStreamSplitter, parseShowinfoFrame, parseShowinfoTimebase, selectFrame } from '../src/node/frames.ts';
import { startRenderServer } from '../src/node/server.ts';
import { fpsToRational, resolveConcurrency } from '../src/node/render.ts';

// ---- image stream splitting ----

function bmp(width: number, height: number, fill: number): Buffer {
  const row = Math.ceil((width * 3) / 4) * 4;
  const size = 54 + row * height;
  const b = Buffer.alloc(size, fill);
  b.write('BM', 0, 'latin1');
  b.writeUInt32LE(size, 2);
  b.writeUInt32LE(54, 10);
  return b;
}

function crc32(buf: Buffer): number {
  let c = ~0;
  for (const byte of buf) {
    c ^= byte;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])));
  return Buffer.concat([head, data, crc]);
}

function png(idatChunks: number, seed: number): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(2, 0);
  ihdr.writeUInt32BE(2, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const raw = deflateSync(Buffer.alloc(2 * (1 + 8), seed));
  const parts = [Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), pngChunk('IHDR', ihdr)];
  // Split the zlib stream over several IDAT chunks, like large frames.
  const step = Math.ceil(raw.length / idatChunks);
  for (let i = 0; i < raw.length; i += step) parts.push(pngChunk('IDAT', raw.subarray(i, i + step)));
  parts.push(pngChunk('IEND', Buffer.alloc(0)));
  return Buffer.concat(parts);
}

function feedInPieces(splitter: ImageStreamSplitter, stream: Buffer, sizes: number[]): Buffer[] {
  const out: Buffer[] = [];
  let pos = 0;
  let i = 0;
  while (pos < stream.length) {
    const n = sizes[i++ % sizes.length]!;
    out.push(...splitter.push(stream.subarray(pos, pos + n)));
    pos += n;
  }
  return out;
}

test('ImageStreamSplitter splits concatenated BMPs regardless of chunk boundaries', () => {
  const images = [bmp(3, 2, 1), bmp(5, 5, 2), bmp(1, 1, 3), bmp(64, 64, 4)];
  const stream = Buffer.concat(images);
  for (const sizes of [[1], [2, 7, 3], [5000], [stream.length]]) {
    const out = feedInPieces(new ImageStreamSplitter('bmp'), stream, sizes);
    assert.equal(out.length, images.length, `pieces ${sizes.join(',')}`);
    out.forEach((img, i) => assert.ok(img.equals(images[i]!)));
  }
});

test('ImageStreamSplitter splits concatenated PNGs with multiple IDAT chunks', () => {
  const images = [png(1, 10), png(3, 20), png(2, 30)];
  const stream = Buffer.concat(images);
  for (const sizes of [[1], [3, 11], [stream.length]]) {
    const splitter = new ImageStreamSplitter('png');
    const out = feedInPieces(splitter, stream, sizes);
    assert.equal(out.length, images.length);
    out.forEach((img, i) => assert.ok(img.equals(images[i]!)));
    assert.equal(splitter.buffered, 0);
  }
});

test('ImageStreamSplitter rejects a stream in the wrong format', () => {
  assert.throws(() => new ImageStreamSplitter('bmp').push(png(1, 1)), /not BMP/);
  assert.throws(() => new ImageStreamSplitter('png').push(bmp(2, 2, 0)), /not PNG/);
});

// ---- showinfo ----

test('showinfo parsing gives integer pts and the time base', () => {
  assert.equal(parseShowinfoTimebase('[Parsed_showinfo_0 @ 0x1] config in time_base: 1/15360, frame_rate: 30/1'), 1 / 15360);
  assert.equal(parseShowinfoTimebase('[Parsed_showinfo_0 @ 0x1] config out time_base: 0/0, frame_rate: 0/0'), null);
  const f = parseShowinfoFrame('[Parsed_showinfo_0 @ 0x1] n:  12 pts:   6144 pts_time:0.4     duration:    512 duration_time:0.0333333 fmt:yuv420p');
  assert.deepEqual(f, { n: 12, pts: 6144, ptsTime: 0.4 });
  assert.deepEqual(parseShowinfoFrame('[Parsed_showinfo_0 @ 0x1] n:   0 pts:NOPTS pts_time:NOPTS'), { n: 0, pts: null, ptsTime: null });
  assert.equal(parseShowinfoFrame('[Parsed_showinfo_0 @ 0x1] color_range:unknown'), null);
});

// ---- frame selection ----

test('selectFrame picks the last frame at or before t (with epsilon)', () => {
  const pts = [0, 1 / 30, 2 / 30, 3 / 30];
  const mid = { atStart: false, ended: false };
  assert.deepEqual(selectFrame(pts, 0, mid), { kind: 'hit', index: 0 });
  assert.deepEqual(selectFrame(pts, 1 / 30, mid), { kind: 'hit', index: 1 });
  // Float error just below a frame boundary still lands on that frame.
  assert.deepEqual(selectFrame(pts, 2 / 30 - 5e-5, mid), { kind: 'hit', index: 2 });
  assert.deepEqual(selectFrame(pts, 2 / 30 - 5e-3, mid), { kind: 'hit', index: 1 });
  // The newest frame can't answer until the next one (or EOF) proves nothing comes between.
  assert.deepEqual(selectFrame(pts, 3 / 30, mid), { kind: 'more' });
  assert.deepEqual(selectFrame(pts, 10, { atStart: false, ended: true }), { kind: 'hit', index: 3 });
});

test('selectFrame before the window: first frame only at the stream start', () => {
  const pts = [0.5, 0.6];
  assert.deepEqual(selectFrame(pts, 0.1, { atStart: true, ended: false }), { kind: 'hit', index: 0 });
  assert.deepEqual(selectFrame(pts, 0.1, { atStart: false, ended: false }), { kind: 'miss' });
  assert.deepEqual(selectFrame([], 0.1, { atStart: true, ended: false }), { kind: 'more' });
  assert.deepEqual(selectFrame([], 0.1, { atStart: true, ended: true }), { kind: 'miss' });
});

test('render helpers: frame rates and concurrency', () => {
  assert.equal(fpsToRational(30), '30');
  assert.equal(fpsToRational(29.97), '30000/1001');
  assert.equal(fpsToRational(23.976), '24000/1001');
  assert.equal(fpsToRational(12.5), '12500/1000');
  assert.equal(resolveConcurrency(3), 3);
  assert.equal(resolveConcurrency('2'), 2);
  assert.ok(resolveConcurrency('50%') >= 1);
  const d = resolveConcurrency(null);
  assert.ok(d >= 1 && d <= 8);
});

// ---- frame server against real ffmpeg ----

const hasFfmpeg = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0 && spawnSync('ffprobe', ['-version'], { stdio: 'ignore' }).status === 0;

function centreLuma(bmpData: Buffer): number {
  // bgr24 bottom-up; grey frames, so any channel of any pixel works.
  return bmpData[bmpData.readUInt32LE(10)]!;
}

test('FrameServer returns exact frames for sequential, shuffled, backward and out-of-range requests', { skip: !hasFfmpeg && 'ffmpeg not available', timeout: 60_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'neon-frames-'));
  try {
    const file = join(dir, 'counter.mp4');
    // 60 frames at 30 fps, grey level 4·N; short GOPs with B-frames so seeks land on keyframes.
    const gen = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', "nullsrc=s=32x32:r=30,geq=lum='16+N*3':cb=128:cr=128", '-frames:v', '60', '-c:v', 'libx264', '-g', '15', '-bf', '3', '-pix_fmt', 'yuv420p', file]);
    assert.equal(gen.status, 0, gen.stderr.toString());
    const src = pathToFileURL(file).href;
    const server = new FrameServer({ keepBehind: 6, readAhead: 4 });
    try {
      // Reference: decoded level of every frame, from a request we trust (sequential from 0).
      const levels: number[] = [];
      for (let n = 0; n < 60; n++) {
        const f = await server.getFrame(src, n / 30);
        assert.ok(Math.abs(f.time - n / 30) < 1e-6, `frame ${n} time ${f.time}`);
        levels.push(centreLuma(f.data));
      }
      for (let n = 1; n < 60; n++) assert.ok(levels[n]! > levels[n - 1]!, 'levels increase frame by frame');
      const sessionsAfterSequential = server.stats.sessionsStarted;
      assert.equal(sessionsAfterSequential, 1, 'one session serves a sequential pass');

      // Mid-frame times resolve to the frame on screen.
      assert.equal(centreLuma((await server.getFrame(src, 10.5 / 30)).data), levels[10]);
      // Backward jump, then far forward jump, then shuffled concurrent requests.
      assert.equal(centreLuma((await server.getFrame(src, 3 / 30)).data), levels[3]);
      assert.equal(centreLuma((await server.getFrame(src, 47 / 30)).data), levels[47]);
      const order = [20, 22, 21, 25, 23, 24, 28, 26, 27, 29];
      const shuffled = await Promise.all(order.map((n) => server.getFrame(src, n / 30)));
      shuffled.forEach((f, i) => assert.equal(centreLuma(f.data), levels[order[i]!]!, `frame ${order[i]}`));
      // Past the end → last frame; negative → first.
      assert.equal(centreLuma((await server.getFrame(src, 100)).data), levels[59]);
      assert.equal(centreLuma((await server.getFrame(src, -1)).data), levels[0]);
      // Alpha frames are PNG.
      const a = await server.getFrame(src, 5 / 30, true);
      assert.equal(a.contentType, 'image/png');
      assert.equal(a.data.subarray(1, 4).toString('latin1'), 'PNG');
    } finally {
      server.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('render server serves the bundle and reports frame errors as HTTP 500', { skip: !hasFfmpeg && 'ffmpeg not available', timeout: 30_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'neon-server-'));
  try {
    const { writeFile } = await import('node:fs/promises');
    await writeFile(join(dir, 'index.html'), '<!doctype html><p>hi</p>');
    await writeFile(join(dir, 'index.js'), 'export {};');
    const srv = await startRenderServer({ bundleDir: dir });
    try {
      const page = await fetch(`${srv.url}/index.html`);
      assert.equal(page.status, 200);
      assert.match(page.headers.get('content-type') ?? '', /text\/html/);
      const js = await fetch(`${srv.url}/index.js`);
      assert.match(js.headers.get('content-type') ?? '', /javascript/);
      assert.equal((await fetch(`${srv.url}/nope.js`)).status, 404);
      assert.equal((await fetch(`${srv.url}/..%2f..%2fetc%2fpasswd`)).status, 403);
      const missing = await fetch(`${srv.url}/frame?src=${encodeURIComponent(pathToFileURL(join(dir, 'missing.mp4')).href)}&t=0`);
      assert.equal(missing.status, 500);
      assert.match(await missing.text(), /missing\.mp4/);
      assert.equal((await fetch(`${srv.url}/frame?t=0`)).status, 400);
      assert.equal(srv.frames.recentErrors().length, 1);
    } finally {
      await srv.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
