import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseRange, startAssetServer } from '../src/asset-server.ts';

test('parseRange', () => {
  assert.deepEqual(parseRange('bytes=0-9', 100), { start: 0, end: 9 });
  assert.deepEqual(parseRange('bytes=90-', 100), { start: 90, end: 99 });
  assert.deepEqual(parseRange('bytes=-10', 100), { start: 90, end: 99 });
  assert.deepEqual(parseRange('bytes=200-300', 100), { start: -1, end: -1 });
  assert.equal(parseRange(undefined, 100), null);
});

test('asset server serves content-addressed files with ranges', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'neon-assets-'));
  const hash = 'c'.repeat(64);
  await writeFile(join(dir, `${hash}.png`), Buffer.from('0123456789'));
  const srv = await startAssetServer(dir);
  try {
    const full = await fetch(`${srv.baseUrl}/${hash}`);
    assert.equal(full.status, 200);
    assert.equal(full.headers.get('content-type'), 'image/png');
    assert.equal(await full.text(), '0123456789');
    const part = await fetch(`${srv.baseUrl}/${hash}`, { headers: { Range: 'bytes=2-4' } });
    assert.equal(part.status, 206);
    assert.equal(part.headers.get('content-range'), 'bytes 2-4/10');
    assert.equal(await part.text(), '234');
    const missing = await fetch(`${srv.baseUrl}/${'d'.repeat(64)}`);
    assert.equal(missing.status, 404);
  } finally {
    await srv.close();
  }
});
