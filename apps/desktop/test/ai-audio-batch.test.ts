import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ProjectDoc, type AiJob } from '@neon/core';
import { audioClipGroups } from '../src/main/ai-audio-targets.ts';
import { AiManager } from '../src/main/ai-manager.ts';
import type { MainContext } from '../src/main/context.ts';

function fixture() {
  const doc = new ProjectDoc();
  doc.ensureInitialized({ fps: 30 });
  const a = 'a'.repeat(64), b = 'b'.repeat(64), enhanced = 'c'.repeat(64);
  for (const id of [a, b, enhanced]) doc.addAsset({ id, name: `${id[0]}.wav`, kind: 'audio', mime: 'audio/wav', size: 9000, durationFrames: 600, importedAt: '' });
  const vo = doc.addTrack('audio', 'VO'), other = doc.addTrack('audio', 'A1');
  const clips = [
    doc.insertClip({ kind: 'audio', trackId: vo.id, assetId: a, startFrame: 0, durationFrames: 60, trimBefore: 10 }),
    doc.insertClip({ kind: 'audio', trackId: vo.id, assetId: a, startFrame: 90, durationFrames: 45, trimBefore: 100 }),
    doc.insertClip({ kind: 'audio', trackId: vo.id, assetId: b, startFrame: 150, durationFrames: 90, trimBefore: 20 }),
    doc.insertClip({ kind: 'audio', trackId: other.id, assetId: a, startFrame: 0, durationFrames: 120 }),
  ];
  const ctx = { store: { doc }, assets: { resolveFile: async (id: string) => `/audio/${id}` },
    events: { emit() {} } } as unknown as MainContext;
  return { doc, clips, enhanced, manager: new AiManager(ctx) };
}

test('selected clips sharing a source are grouped once, without including unselected clips', () => {
  const { doc, clips } = fixture();
  const groups = audioClipGroups(doc.toJSON(), [clips[0]!.id, clips[1]!.id, clips[2]!.id, clips[0]!.id]);
  assert.deepEqual(groups.map(g => g.map(c => c.id)), [[clips[0]!.id, clips[1]!.id], [clips[2]!.id]]);
  assert.throws(() => audioClipGroups(doc.toJSON(), []), /non-empty/);
  assert.throws(() => audioClipGroups(doc.toJSON(), [clips[0]!.id, 'missing']), /not found/);
});

for (const operation of ['enhance', 'denoise'] as const) {
  test(`${operation} processes the whole selection and preserves timing and unselected uses of a source`, async () => {
    const { doc, clips, enhanced, manager } = fixture();
    const before = doc.toJSON();
    const processed: string[][] = [];
    const process = async (job: AiJob, params: Record<string, unknown>) => {
      const target = await Reflect.get(manager, 'resolveTarget').call(manager, params);
      processed.push(target.clips.map((c: { id: string }) => c.id));
      doc.replaceClipAsset(target.clips.map((c: { id: string }) => c.id), enhanced);
      return { clipsUpdated: target.clips.length, newAssetId: enhanced };
    };
    Reflect.set(manager, operation === 'enhance' ? 'opEnhance' : 'opDenoise', process);
    const result = await Reflect.get(manager, 'runOp').call(manager, { op: operation }, { clipIds: clips.slice(0, 3).map(c => c.id) });
    assert.deepEqual(processed, [[clips[0]!.id, clips[1]!.id], [clips[2]!.id]]);
    assert.equal(result.clipsUpdated, 3);
    assert.equal(result.assetsProcessed, 2);
    for (const clip of before.clips) {
      const updated = doc.getClip(clip.id)!;
      assert.deepEqual(updated, { ...clip, assetId: clips.slice(0, 3).some(c => c.id === clip.id) ? enhanced : clip.kind !== 'component' ? clip.assetId : undefined });
    }
  });
}

test('an invalid batch fails before processing any selected source', async () => {
  const { clips, manager } = fixture();
  let processed = 0;
  Reflect.set(manager, 'opEnhance', async () => { processed++; });
  await assert.rejects(Reflect.get(manager, 'runOp').call(manager, { op: 'enhance' }, { clipIds: [clips[0]!.id, 'missing'] }), /not found/);
  assert.equal(processed, 0);
});
