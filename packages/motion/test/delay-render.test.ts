import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cancelRender, continueRender, delayRender, pendingDelayRenders, waitForRenderIdle } from '../src/delay-render.ts';

test('waitForRenderIdle resolves once every handle is released', async () => {
  const a = delayRender('a');
  const b = delayRender('b');
  assert.deepEqual(pendingDelayRenders(), ['a', 'b']);
  let done = false;
  const wait = waitForRenderIdle().then(() => {
    done = true;
  });
  continueRender(a);
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(done, false);
  continueRender(b);
  continueRender(b); // double release is harmless
  await wait;
  assert.equal(done, true);
});

test('waitForRenderIdle rejects on timeout and on cancelRender', async () => {
  const h = delayRender('slow', { timeoutInMilliseconds: 30 });
  await assert.rejects(waitForRenderIdle(), /slow/);
  continueRender(h);
  const h2 = delayRender('will fail');
  const wait = waitForRenderIdle();
  cancelRender(new Error('boom'));
  await assert.rejects(wait, /boom/);
  continueRender(h2);
});
