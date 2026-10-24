import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ThumbnailLayer } from '@neon/core';
import { describeThumbnail, resolveLayer, transformPatch } from '../src/thumbnail.ts';
import { youtubeUploadBody } from '../src/youtube.ts';

const layer = (id: string, name: string, order: number): ThumbnailLayer => ({ id, name, order, kind: 'component', componentName: 'TitleCard', props: {}, transform: { x: 0.5, y: 0.3, scale: 1 } });
const layers = [layer('thumb_aaa1', 'Title Card', 0), layer('thumb_bbb2', 'Badge', 1)];

test('only the transform fields passed are sent', () => {
  assert.deepEqual(transformPatch({ pos: '0.25,0.8' }), { x: 0.25, y: 0.8 });
  assert.deepEqual(transformPatch({ scale: '0.4', rotation: '-10' }), { scale: 0.4, rotation: -10 });
  assert.equal(transformPatch({}), undefined);
  assert.throws(() => transformPatch({ pos: '0.5' }), /--pos expects x,y/);
  assert.throws(() => transformPatch({ scale: 'big' }), /--scale expects a number/);
});

test('layers resolve by id, prefix, name or position', () => {
  assert.equal(resolveLayer('thumb_bbb2', layers).name, 'Badge');
  assert.equal(resolveLayer('thumb_a', layers).name, 'Title Card');
  assert.equal(resolveLayer('badge', layers).id, 'thumb_bbb2');
  assert.equal(resolveLayer('1', layers).id, 'thumb_bbb2');
  assert.throws(() => resolveLayer('thumb_', layers), /matches thumb_aaa1, thumb_bbb2/);
  assert.throws(() => resolveLayer('nope', layers), /No thumbnail layer matches "nope"/);
});

test('show lists the background and the stack', () => {
  assert.equal(describeThumbnail({ background: { kind: 'frame', frame: 0 }, layers: [] }, 30), 'Background: timeline frame at 00:00:00:00\nNo layers yet: neon-cli thumbnail add --component TitleCard --props \'{"title":"…"}\'');
  const text = describeThumbnail({ background: { kind: 'color', color: '#111' }, layers }, 30);
  assert.match(text, /^Background: colour #111\nLayers \(0 = bottom\):/);
  assert.match(text, /thumb_bbb2 +Badge +TitleCard +0\.50,0\.30 +1\.00 +0/);
});

test('youtube upload --thumbnail project asks the app to render the project thumbnail', () => {
  const body = youtubeUploadBody('a.mp4', { title: 'x', kids: false, thumbnail: 'project' }, { appPath: (p) => `/abs/${p}` });
  assert.deepEqual(body.metadata, { title: 'x', madeForKids: false, projectThumbnail: true });
});
