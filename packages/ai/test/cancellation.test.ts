import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runOrThrow, withAiCancellation } from '../src/exec.ts';
import { decodePcm } from '../src/pcm.ts';

test('cancellation stops an active engine and prevents the next processing step', { timeout: 10_000 }, async () => {
  const controller = new AbortController();
  let nextStep = false;
  const started = Date.now();
  await assert.rejects(withAiCancellation(controller.signal, async () => {
    await runOrThrow(process.execPath, ['-e', 'process.on("SIGTERM", () => {}); process.stdout.write("ready\\n"); setInterval(() => {}, 1000)'], {
      onStdout: () => controller.abort(),
    });
    nextStep = true;
  }), { name: 'AbortError' });
  assert.equal(nextStep, false);
  assert.ok(Date.now() - started < 8000, 'cancel waits for process exit, not the full engine run');
});

test('cancellation is isolated to its job and an already aborted job never spawns', async () => {
  const controller = new AbortController();
  controller.abort();
  const [cancelled, completed] = await Promise.allSettled([
    withAiCancellation(controller.signal, () => runOrThrow('not-a-real-neon-engine', [])),
    runOrThrow(process.execPath, ['-e', 'console.log("unaffected")']),
  ]);
  assert.equal(cancelled.status, 'rejected');
  if (cancelled.status === 'rejected') assert.equal(cancelled.reason.name, 'AbortError');
  assert.equal(completed.status, 'fulfilled');
  if (completed.status === 'fulfilled') assert.equal(completed.value.stdout.trim(), 'unaffected');
});

test('PCM analysis observes cancellation too', { timeout: 10_000 }, async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(withAiCancellation(controller.signal, () => decodePcm('not-a-real-neon-ffmpeg', 'unused')), { name: 'AbortError' });
});
