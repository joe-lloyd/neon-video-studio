import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ProjectDoc, StudioVoiceRequestSchema, StudioVoiceApplyRequestSchema, type StudioVoicePreview } from '@neon/core';
import { validateStudioTarget, applyStudioVoice, generateStudioVoice } from '../src/main/studio-voice.ts';
import type { MainContext } from '../src/main/context.ts';

function fixture() {
  const doc = new ProjectDoc(); doc.ensureInitialized({ fps: 30 });
  const assetId = 'a'.repeat(64);
  doc.addAsset({ id: assetId, name: 'take.wav', kind: 'audio', mime: 'audio/wav', size: 9000, durationFrames: 600, importedAt: '' });
  const track = doc.addTrack('audio', 'VO');
  const clip = doc.insertClip({ kind: 'audio', trackId: track.id, assetId, startFrame: 45, durationFrames: 60, trimBefore: 10 });
  const preview: StudioVoicePreview = { fps: 30, projectId: doc.toJSON().meta.id, clipId: clip.id, sourceAssetId: assetId, dryAssetId: 'd'.repeat(64), wetAssetId: 'e'.repeat(64), startFrame: 45, durationFrames: 60, trimBefore: 10, speed: 1 };
  const ctx = { store: { doc }, assets: { resolveFile: async () => null } } as unknown as MainContext;
  return { doc, clip, preview, ctx };
}

test('Studio Voice validates native/API requests and blend bounds', () => {
  assert.equal(StudioVoiceApplyRequestSchema.parse({ previewJobId: 'preview' }).strength, 0.75);
  for (const strength of [-1, 2, NaN]) assert.equal(StudioVoiceApplyRequestSchema.safeParse({ previewJobId: 'preview', strength }).success, false);
  assert.equal(StudioVoiceRequestSchema.safeParse({ clipId: '' }).success, false);
});

test('Studio Voice permits reapplying its own blend, but rejects stale audio, edits and project switches', () => {
  const { doc, clip, preview } = fixture();
  assert.equal(validateStudioTarget(doc.toJSON(), preview).id, clip.id);
  for (const patch of [{ fps: 60 }, { projectId: 'another' }, { sourceAssetId: 'another' }, { trimBefore: 11 }, { startFrame: 46 }, { durationFrames: 61 }, { speed: 2 }]) {
    assert.throws(() => validateStudioTarget(doc.toJSON(), { ...preview, ...patch }), /changed since/);
  }
  doc.addAsset({ ...doc.toJSON().assets[0]!, id: 'b'.repeat(64) });
  doc.replaceClipAsset([clip.id], 'b'.repeat(64));
  assert.throws(() => validateStudioTarget(doc.toJSON(), preview), /changed since/);
  assert.equal(validateStudioTarget(doc.toJSON(), { ...preview, appliedAssetId: 'b'.repeat(64) }).id, clip.id);
});

test('failed preview/apply leave all clip properties untouched', async () => {
  const { doc, clip, preview, ctx } = fixture();
  const before = doc.toJSON();
  const paths = { ffmpeg: 'missing-ffmpeg', ffprobe: 'missing-ffprobe' };
  await assert.rejects(generateStudioVoice(ctx, clip.id, paths, () => {}), /unavailable/);
  await assert.rejects(applyStudioVoice(ctx, preview, 0.75, paths, () => {}), /unavailable/);
  await assert.rejects(applyStudioVoice(ctx, preview, 2, paths, () => {}), /between/);
  assert.deepEqual(doc.toJSON().clips, before.clips);
});
