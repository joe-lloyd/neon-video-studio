import { mkdtemp, writeFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withAiCancellation } from '@neon/ai';
import { AssetManager } from '../src/main/assets.ts';
import type { ProjectStore } from '../src/main/project-store.ts';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ProjectDoc, StudioVoiceRequestSchema, StudioVoiceApplyRequestSchema, type StudioVoicePreview } from '@neon/core';
import { validateStudioTarget, applyStudioVoice, generateStudioVoice, generateStudioVoiceSelection } from '../src/main/studio-voice.ts';
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
  assert.equal(StudioVoiceRequestSchema.safeParse({}).success, false);
  assert.equal(StudioVoiceRequestSchema.safeParse({ clipIds: [] }).success, false);
  assert.equal(StudioVoiceRequestSchema.safeParse({ clipId: 'one', clipIds: ['two'] }).success, false);
  assert.deepEqual(StudioVoiceRequestSchema.parse({ clipIds: ['one', 'two'] }).clipIds, ['one', 'two']);
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


test('switching projects during audition import cannot add files or metadata to the new project', async () => {
  const first = new ProjectDoc(); first.ensureInitialized();
  const next = new ProjectDoc(); next.ensureInitialized();
  let current = first;
  const dir = await mkdtemp(join(tmpdir(), 'neon-import-guard-'));
  try {
    const source = join(dir, 'source.wav'); await writeFile(source, 'fixture');
    const manager = new AssetManager({ get doc() { return current; }, assetsDir: dir } as ProjectStore, 'test');
    const pending = manager.import(source, { expectedProjectId: first.toJSON().meta.id });
    current = next;
    await assert.rejects(pending, /project changed/);
    assert.equal(first.toJSON().assets.length, 0);
    assert.equal(next.toJSON().assets.length, 0);
    assert.deepEqual(await readdir(dir), ['source.wav']);
  } finally { await rm(dir, { recursive: true, force: true }); }
});


function selectionFixture() {
  const f = fixture();
  const source = f.doc.toJSON().assets[0]!;
  const secondAsset = { ...source, id: 'b'.repeat(64) }; f.doc.addAsset(secondAsset);
  const shared = f.doc.insertClip({ kind: 'audio', trackId: f.clip.trackId, assetId: source.id, startFrame: 110, durationFrames: 45, trimBefore: 100, placement: 'overlap' });
  const other = f.doc.insertClip({ kind: 'audio', trackId: f.clip.trackId, assetId: secondAsset.id, startFrame: 150, durationFrames: 70, placement: 'overlap' });
  const unselected = f.doc.insertClip({ kind: 'audio', trackId: f.clip.trackId, assetId: source.id, startFrame: 160, durationFrames: 60, placement: 'overlap' });
  f.doc.updateClip(shared.id, { speed: 1.25 });
  const calls: string[] = [];
  const generate: typeof generateStudioVoice = async (_ctx, clipId) => {
    const clip = f.doc.getClip(clipId)!;
    assert.ok(clip.kind === 'audio'); calls.push(clip.assetId);
    return { ...f.preview, clipId, sourceAssetId: clip.assetId, startFrame: clip.startFrame, durationFrames: clip.durationFrames, trimBefore: clip.trimBefore, speed: clip.speed ?? 1, dryAssetId: `dry-${clip.assetId}`, wetAssetId: `wet-${clip.assetId}` };
  };
  let imports = 0;
  const context = f.ctx as unknown as { assets: { resolveFile: (id: string) => Promise<string>; import: (file: string) => Promise<unknown> }; history: { push: () => Promise<unknown> } };
  context.assets.resolveFile = async id => `/audio/${id}`;
  context.assets.import = async () => {
    const asset = { ...source, id: String(++imports).padStart(64, 'c') };
    f.doc.addAsset(asset); return { asset };
  };
  Object.assign(f.ctx.store, { flush: async () => {} });
  context.history = { push: async () => ({}) };
  return { ...f, shared, other, unselected, calls, generate, ids: [f.clip.id, shared.id, other.id] };
}
const paths = { ffmpeg: 'unused', ffprobe: 'unused' };

test('Studio Voice restores shared sources once and applies the batch without altering unselected uses', async () => {
  const f = selectionFixture(); const before = f.doc.toJSON().clips;
  const preview = await generateStudioVoiceSelection(f.ctx, [...f.ids, f.ids[0]!], paths, () => {}, f.generate);
  assert.equal(f.calls.length, 2); assert.equal(preview.clips!.length, 3);
  assert.deepEqual(f.doc.toJSON().clips, before);
  assert.equal(preview.clips![0]!.wetAssetId, preview.clips![1]!.wetAssetId);
  let rendered = 0;
  const result = await applyStudioVoice(f.ctx, preview, 0.42, paths, () => {}, async (_dry, _wet, output, strength) => {
    rendered++; assert.equal(strength, 0.42);
    assert.deepEqual(f.doc.toJSON().clips, before, 'No clips change while blends are rendering');
    await writeFile(output, 'blend');
  });
  assert.equal(rendered, 2); assert.equal(result.clipsUpdated, 3); assert.equal(result.assetsProcessed, 2);
  const applied = new Map(result.appliedClips.map(clip => [clip.clipId, clip.newAssetId]));
  for (const clip of before) {
    assert.deepEqual(f.doc.getClip(clip.id), applied.has(clip.id) ? { ...clip, assetId: applied.get(clip.id) } : clip);
  }
});

test('Studio Voice rejects invalid selections before restoring any source', async () => {
  const f = selectionFixture();
  await assert.rejects(generateStudioVoiceSelection(f.ctx, [f.clip.id, 'missing'], paths, () => {}, f.generate), /not found/);
  assert.equal(f.calls.length, 0);
});

test('a failed later blend or stale batch target never partially applies Studio Voice', async () => {
  const f = selectionFixture();
  const preview = await generateStudioVoiceSelection(f.ctx, f.ids, paths, () => {}, f.generate);
  const before = f.doc.toJSON().clips; let rendered = 0;
  await assert.rejects(applyStudioVoice(f.ctx, preview, 0.75, paths, () => {}, async () => { if (++rendered === 2) throw new Error('Second source failed'); }), /Second source failed/);
  assert.deepEqual(f.doc.toJSON().clips, before);
  f.doc.updateClip(f.other.id, { trimBefore: 1 }); rendered = 0;
  await assert.rejects(applyStudioVoice(f.ctx, preview, 0.75, paths, () => {}, async () => { rendered++; }), /changed since/);
  assert.equal(rendered, 0);
});


test('cancelling a batch blend stops remaining sources and preserves the whole selection', async () => {
  const f = selectionFixture();
  const preview = await generateStudioVoiceSelection(f.ctx, f.ids, paths, () => {}, f.generate);
  const before = f.doc.toJSON().clips; const controller = new AbortController(); let rendered = 0;
  await assert.rejects(withAiCancellation(controller.signal, () => applyStudioVoice(f.ctx, preview, 0.75, paths, () => {}, async () => {
    rendered++; controller.abort(new Error('Batch cancelled'));
  })), /Batch cancelled/);
  assert.equal(rendered, 1);
  assert.deepEqual(f.doc.toJSON().clips, before);
});
