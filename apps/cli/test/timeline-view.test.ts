import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Project } from '@neon/core';
import { formatTimeline, timelineView } from '../src/timeline-view.ts';

const project: Project = {
  meta: { id: 'p', name: 'Demo', fps: 30, width: 1280, height: 720, background: '#000', createdAt: '', updatedAt: '', schemaVersion: 1 },
  tracks: [
    { id: 'fx', name: 'FX1', kind: 'overlay', order: 2, muted: false, locked: false, hidden: true },
    { id: 'v1', name: 'V1', kind: 'video', order: 0, muted: false, locked: true, hidden: false },
  ],
  clips: [
    { id: 'c_title', trackId: 'fx', kind: 'component', name: 'Title', startFrame: 30, durationFrames: 60, componentName: 'TextOverlay', props: { text: 'Hi' }, animateIn: { type: 'pop', durationFrames: 12 } },
    {
      id: 'c_take', trackId: 'v1', kind: 'video', name: 'take', startFrame: 0, durationFrames: 15, assetId: 'a'.repeat(64), trimBefore: 30,
      volume: 0.5, fit: 'cover', fadeIn: 0, fadeOut: 6, speed: 2, zooms: [{ start: 30, end: 60, cx: 0.25, cy: 0.25, zoom: 2 }],
    },
  ],
  assets: [{ id: 'a'.repeat(64), name: 'take.mp4', kind: 'video', mime: 'video/mp4', size: 1, importedAt: '' }],
  transcripts: [],
};

test('timelineView orders tracks, fills gaps and maps zooms to timeline frames', () => {
  const view = timelineView(project, 90);
  assert.deepEqual(view.tracks.map((t) => t.name), ['V1', 'FX1']);
  const take = view.tracks[0]!.items[0];
  assert.ok(take?.type === 'clip' && take.kind === 'video');
  assert.deepEqual({ asset: take.asset, speed: take.speed, zooms: take.zooms }, { asset: 'take.mp4', speed: 2, zooms: [{ start: 0, end: 15, zoom: 2, cx: 0.25, cy: 0.25 }] });
  assert.deepEqual(view.tracks[1]!.items.map((i) => [i.type, i.start, i.end]), [['gap', 0, 30], ['clip', 30, 90]]);
});

test('formatTimeline prints one block per track', () => {
  assert.equal(
    formatTimeline(timelineView(project, 90)),
    [
      '“Demo” 1280×720 @ 30fps · 00:00:03:00 (3s) · 2 tracks · 2 clips',
      '',
      'V1 · video · locked · v1',
      '  00:00:00:00–00:00:00:15  (0.5s)  take  [video take.mp4]  trim 1s · 2× · zoom 2× @0.25,0.25 00:00:00:00–00:00:00:15 · vol 0.5 · fade out 6f  c_take',
      '',
      'FX1 · overlay · hidden · fx',
      '  00:00:00:00–00:00:01:00  (1s)  · gap',
      '  00:00:01:00–00:00:03:00  (2s)  Title  [TextOverlay {"text":"Hi"}]  in pop:12  c_title',
    ].join('\n'),
  );
});
