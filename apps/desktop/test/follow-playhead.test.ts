import assert from 'node:assert/strict';
import { test } from 'node:test';
import { followScroll } from '../src/renderer/lib/follow-playhead.ts';

const view = { scrollLeft: 1000, width: 1000 }; // shows x 1000..2000; the middle 60% is 1200..1800

test('a jump off screen recentres the playhead', () => {
  assert.equal(followScroll({ ...view, x: 5000, playing: false }), 4500);
  assert.equal(followScroll({ ...view, x: 300, playing: false }), 0);
});

test('a jump near the edge of the view recentres it', () => {
  assert.equal(followScroll({ ...view, x: 1900, playing: false }), 1400);
});

test('a small step inside the middle of the view leaves it alone', () => {
  assert.equal(followScroll({ ...view, x: 1500, playing: false }), null);
  assert.equal(followScroll({ ...view, x: 1210, playing: false }), null);
});

test('playback pages as before: only when the playhead leaves the view', () => {
  assert.equal(followScroll({ ...view, x: 1900, playing: true }), null);
  assert.equal(followScroll({ ...view, x: 1970, playing: true }), 1910);
});
