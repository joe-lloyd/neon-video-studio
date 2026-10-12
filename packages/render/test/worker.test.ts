import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateEntry, scaleFrameRange } from '../src/worker.ts';

test('generateEntry registers packs before handing the compositions to the render page', () => {
  const src = generateEntry({
    entryPoint: '/repo/apps/compositions/src/index.ts',
    packs: [
      { name: '[removed]-expressive', entry: '/home/u/.neon-video/packs/[removed]-expressive/index.tsx' },
      { name: 'other', entry: 'C:\\packs\\other\\index.tsx' },
    ],
  });
  assert.match(src, /import \{ registerRenderRoot \} from '@neon\/motion\/render-page';/);
  assert.match(src, /import \{ TimelineComposition, ContactSheet, registerRuntimeComponents \} from "\/repo\/apps\/compositions\/src\/index.ts";/);
  assert.match(src, /import \* as pack0 from "\/home\/u\/\.neon-video\/packs\/[removed]-expressive\/index\.tsx";/);
  // Windows paths are JSON-escaped, not mangled.
  assert.ok(src.includes('import * as pack1 from "C:\\\\packs\\\\other\\\\index.tsx";'));
  const register = src.indexOf('registerRuntimeComponents("[removed]-expressive"');
  const root = src.indexOf('registerRenderRoot({ "Timeline": TimelineComposition, "ContactSheet": ContactSheet })');
  assert.ok(register > 0 && root > register, 'packs register before the root mounts');
  assert.doesNotMatch(generateEntry({ entryPoint: '/x/index.ts' }), /pack0/);
});

test('scaleFrameRange maps project frames to output frames and clamps', () => {
  assert.equal(scaleFrameRange(null, 300, 1), null);
  assert.deepEqual(scaleFrameRange([30, 59], 300, 1), [30, 59]);
  // 30 fps project rendered at 60 fps.
  assert.deepEqual(scaleFrameRange([30, 59], 300, 2), [60, 118]);
  // Past the end, reversed and negative ranges clamp into the composition.
  assert.deepEqual(scaleFrameRange([290, 400], 300, 1), [290, 299]);
  assert.deepEqual(scaleFrameRange([50, 10], 300, 1), [50, 50]);
  assert.deepEqual(scaleFrameRange([-5, 3], 300, 1), [0, 3]);
});
