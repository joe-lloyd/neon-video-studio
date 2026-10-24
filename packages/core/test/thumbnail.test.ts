import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ProjectDoc, createUndoManager, ORIGIN_LOCAL } from '../src/doc.ts';
import { ProjectSchema } from '../src/schemas.ts';
import { newLayerTransform, thumbnailProject } from '../src/thumbnail.ts';
import type { Asset } from '../src/types.ts';

const image: Asset = { id: 'c'.repeat(64), name: 'logo.png', kind: 'image', mime: 'image/png', size: 1, durationFrames: 150, importedAt: '2026-01-01T00:00:00.000Z' };
const video: Asset = { ...image, id: 'd'.repeat(64), name: 'take.mp4', kind: 'video', mime: 'video/mp4', durationFrames: 300 };

function fresh(): ProjectDoc {
  const pd = new ProjectDoc();
  pd.ensureInitialized({ name: 'Thumb test', fps: 30, width: 1920, height: 1080 });
  pd.addAsset(image);
  pd.addAsset(video);
  return pd;
}

test('layers stack in the order they are added, props are validated and defaulted, images must be images', () => {
  const pd = fresh();
  const title = pd.addThumbnailLayer({ kind: 'component', componentName: 'TitleCard', props: { title: 'Neon in 60s' }, transform: newLayerTransform({ y: 0.3 }) });
  const logo = pd.addThumbnailLayer({ kind: 'image', assetId: image.id, transform: newLayerTransform({ x: 0.85, y: 0.8, scale: 0.2 }) });
  assert.deepEqual(pd.getThumbnail().layers.map((l) => [l.name, l.order]), [['Title Card', 0], ['logo.png', 1]]);
  assert.equal(title.kind === 'component' && title.props.title, 'Neon in 60s');
  assert.deepEqual(logo.transform, { x: 0.85, y: 0.8, scale: 0.2 });
  assert.throws(() => pd.addThumbnailLayer({ kind: 'image', assetId: video.id, transform: newLayerTransform(undefined) }), /take\.mp4” is video; thumbnail layers take images/);
  assert.throws(() => pd.addThumbnailLayer({ kind: 'component', componentName: 'Nope', props: {}, transform: newLayerTransform(undefined) }), /Unknown component "Nope"/);

  pd.updateThumbnailLayer(title.id, { props: { subtitle: 'A video editor' }, transform: { scale: 1.2 } });
  const updated = pd.getThumbnail().layers[0]!;
  assert.equal(updated.kind === 'component' && updated.props.title, 'Neon in 60s', 'props merge');
  assert.equal(updated.kind === 'component' && updated.props.subtitle, 'A video editor');
  assert.deepEqual(updated.transform, { x: 0.5, y: 0.3, scale: 1.2 });
  assert.throws(() => pd.updateThumbnailLayer(logo.id, { props: { a: 1 } }), /Only component layers have props/);

  pd.moveThumbnailLayer(logo.id, 0);
  assert.deepEqual(pd.getThumbnail().layers.map((l) => l.name), ['logo.png', 'Title Card']);
  pd.removeThumbnailLayers([logo.id]);
  assert.deepEqual(pd.getThumbnail().layers.map((l) => l.name), ['Title Card']);
});

test('the thumbnail survives save/load and history snapshots, and local edits undo', () => {
  const pd = fresh();
  const undo = createUndoManager(pd, [ORIGIN_LOCAL]);
  pd.setThumbnailBackground({ kind: 'color', color: '#101020' });
  pd.addThumbnailLayer({ kind: 'component', componentName: 'TitleCard', props: { title: 'Saved' }, transform: newLayerTransform(undefined) });
  const saved = ProjectSchema.parse(JSON.parse(JSON.stringify(pd.toJSON())));
  assert.deepEqual(ProjectDoc.fromJSON(saved).getThumbnail(), pd.getThumbnail());

  const other = fresh();
  other.applySnapshot(saved);
  assert.deepEqual(other.getThumbnail(), pd.getThumbnail());

  undo.stopCapturing();
  pd.addThumbnailLayer({ kind: 'component', componentName: 'TitleCard', props: { title: 'Oops' }, transform: newLayerTransform(undefined) });
  undo.undo();
  assert.deepEqual(pd.getThumbnail().layers.map((l) => l.kind === 'component' && l.props.title), ['Saved']);
});

test('a file from before thumbnails loads with an empty one', () => {
  const pd = fresh();
  const { thumbnail: _t, ...legacy } = pd.toJSON();
  assert.deepEqual(ProjectDoc.fromJSON(ProjectSchema.parse(legacy)).getThumbnail(), { background: { kind: 'frame', frame: 0 }, layers: [] });
});

test('thumbnailProject: a frame background keeps the timeline at that frame under every layer, at 1280x720', () => {
  const pd = fresh();
  pd.insertClip({ kind: 'video', assetId: video.id, startFrame: 0 });
  const layer = pd.addThumbnailLayer({ kind: 'component', componentName: 'TitleCard', props: { title: 'Top' }, transform: newLayerTransform(undefined) });
  pd.setThumbnailBackground({ kind: 'frame', frame: 9000 });
  const { project, frame } = thumbnailProject(pd.toJSON());
  // Background clamped to the last timeline frame (299); everything shifted 3 s (90 frames) so the
  // layer is drawn 90 frames into a 181-frame clip, after its entrance and before its exit.
  assert.equal(frame, 389);
  assert.deepEqual([project.meta.width, project.meta.height], [1280, 720]);
  assert.equal(project.clips.length, 2);
  const videoClip = project.clips.find((c) => c.id !== layer.id)!;
  assert.equal(videoClip.startFrame, 90, 'the timeline keeps its picture at the drawn frame');
  const thumbClip = project.clips.find((c) => c.id === layer.id)!;
  assert.deepEqual([thumbClip.startFrame, thumbClip.durationFrames, thumbClip.kind], [299, 181, 'component']);
  assert.equal(frame - thumbClip.startFrame, 90);
  const thumbTrack = project.tracks.find((t) => t.id === thumbClip.trackId)!;
  assert.ok(project.tracks.every((t) => t === thumbTrack || t.order < thumbTrack.order), 'layer tracks draw above the timeline');
});

test('thumbnailProject: a colour background drops the timeline and paints the colour', () => {
  const pd = fresh();
  pd.insertClip({ kind: 'video', assetId: video.id, startFrame: 0 });
  pd.addThumbnailLayer({ kind: 'image', assetId: image.id, transform: newLayerTransform(undefined) });
  pd.setThumbnailBackground({ kind: 'color', color: 'rebeccapurple' });
  const { project, frame } = thumbnailProject(pd.toJSON());
  assert.equal(frame, 90);
  assert.equal(project.meta.background, 'rebeccapurple');
  assert.deepEqual(project.clips.map((c) => c.kind), ['image']);
  assert.equal(project.tracks.length, 1);
});
