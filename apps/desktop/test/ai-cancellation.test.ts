import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ProjectDoc } from '@neon/core';
import { runOrThrow } from '@neon/ai';
import { AiManager } from '../src/main/ai-manager.ts';
import type { MainContext } from '../src/main/context.ts';

const wait = (ms: number) => new Promise(r => setTimeout(r, ms));
async function until(check: () => boolean) {
  const deadline = Date.now() + 8000;
  while (!check()) { assert.ok(Date.now() < deadline, 'job finished promptly'); await wait(20); }
}

test('cancelled filler analysis cannot cut the project and the queue continues', { timeout: 15_000 }, async () => {
  const doc = new ProjectDoc(); doc.ensureInitialized({ fps: 30 });
  const before = doc.toJSON();
  const manager = new AiManager({ store: { doc }, events: { emit() {}, activity() {} } } as unknown as MainContext);
  let ready = false, applied = false, queuedStarted = false;
  Reflect.set(manager, 'resolveTarget', async () => ({ asset: { id: 'test' }, clips: [] }));
  Reflect.set(manager, 'ensureTranscript', async () => {
    await runOrThrow(process.execPath, ['-e', 'console.log("ready"); setInterval(() => {}, 1000)'], { onStdout: () => { ready = true; } });
    return { words: [{ w: 'um', s: 0, e: 1 }] };
  });
  Reflect.set(doc, 'cutRanges', () => { applied = true; return { removedFrames: 30 }; });
  Reflect.set(manager, 'opEnhance', async () => { queuedStarted = true; return {}; });
  const job = manager.start('fillers', { clipId: 'test', apply: true });
  await until(() => ready);
  const queued = manager.start('enhance', { clipId: 'test' });
  manager.cancel(job.id);
  await until(() => job.status === 'cancelled' && queued.status === 'done');
  assert.equal(applied, false);
  assert.deepEqual(doc.toJSON(), before);
  assert.equal(queuedStarted, true);
  assert.equal(job.error, undefined);
});

test('cancelling a queued job never starts it', { timeout: 15_000 }, async () => {
  const manager = new AiManager({ events: { emit() {}, activity() {} } } as unknown as MainContext);
  let release!: () => void;
  const pending = new Promise<void>(r => { release = r; });
  const ran: string[] = [];
  Reflect.set(manager, 'opEnhance', async (_job: unknown, params: { name: string }) => { ran.push(params.name); await pending; return {}; });
  const active = manager.start('enhance', { name: 'active' });
  const queued = manager.start('enhance', { name: 'queued' });
  manager.cancel(queued.id);
  release();
  await until(() => active.status === 'done');
  assert.equal(queued.status, 'cancelled');
  assert.deepEqual(ran, ['active']);
});
