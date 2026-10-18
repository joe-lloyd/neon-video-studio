/** Optional integration check: requires installed local model + ffmpeg. Never opens a user project.
 * Run with node scripts/test-studio-voice.ts <5-second-voice.wav> (or bundle for Bun).
 */
import assert from 'node:assert/strict';
import { mkdtemp, readFile, copyFile, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { ProjectDoc } from '../packages/core/src/index.ts';
import { probe, restoreStudioVoice, withAiCancellation, runOrThrow } from '../packages/ai/src/index.ts';
import { generateStudioVoice, generateStudioVoiceSelection, applyStudioVoice } from '../apps/desktop/src/main/studio-voice.ts';
import type { MainContext } from '../apps/desktop/src/main/context.ts';

const input = process.argv[2];
if (!input) throw new Error('Pass a short 44.1 kHz mono speech WAV');
const tools = join(homedir(), '.neon-video', 'tools');
const paths = { ffmpeg: join(tools, process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'), ffprobe: join(tools, process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe') };
const dir = await mkdtemp(join(tmpdir(), 'neon-studio-check-'));
try {
  const doc = new ProjectDoc(); doc.ensureInitialized({ fps: 30 });
  const files = new Map<string, string>();
  async function importAsset(file: string) {
    const bytes = await readFile(file);
    const id = createHash('sha256').update(bytes).digest('hex');
    const destination = join(dir, `${id}.wav`); await copyFile(file, destination); files.set(id, destination);
    const info = await probe(paths.ffprobe, destination);
    const asset = { id, name: id + '.wav', kind: 'audio' as const, mime: 'audio/wav', size: bytes.length, importedAt: '', durationFrames: Math.round(info.durationSeconds*30) };
    if (!doc.getAsset(id)) doc.addAsset(asset);
    return { asset: doc.getAsset(id)! };
  }
  const { asset } = await importAsset(input);
  const track = doc.addTrack('audio', 'VO');
  const clip = doc.insertClip({ kind: 'audio', assetId: asset.id, trackId: track.id, startFrame: 45, durationFrames: 60, trimBefore: 15, placement: 'overlap' });
  doc.insertClip({ kind: 'audio', assetId: asset.id, trackId: track.id, startFrame: 50, durationFrames: 30, placement: 'overlap' });
  doc.updateClip(clip.id, { speed: 1.25 });
  const expectedClip = doc.getClip(clip.id)!;
  const originalClips = doc.toJSON().clips;
  let checkpoints = 0;
  const ctx = { store: { doc, flush: async () => {} }, assets: { resolveFile: async (id: string) => files.get(id) ?? null, import: importAsset }, history: { push: async () => { checkpoints++; return {}; } } } as unknown as MainContext;
  const preview = await generateStudioVoice(ctx, clip.id, paths, (p, m) => console.log(Math.round(p*100), m));
  assert.deepEqual(doc.toJSON().clips, originalClips, 'Preview must not alter timeline');
  const sourceDuration = (await probe(paths.ffprobe, input)).durationSeconds;
  for (const id of [preview.dryAssetId, preview.wetAssetId]) {
    assert.ok(Math.abs((await probe(paths.ffprobe, files.get(id)!)).durationSeconds-sourceDuration) < 1/44100);
  }
  for (const strength of [0, 0.75, 1]) {
    const result = await applyStudioVoice(ctx, preview, strength, paths, () => {});
    assert.deepEqual(doc.getClip(clip.id), { ...expectedClip, assetId: result.newAssetId });
    assert.deepEqual(doc.toJSON().clips[1], originalClips[1], 'Unselected use of the source must not change');
    assert.ok(Math.abs((await probe(paths.ffprobe, files.get(result.newAssetId)!)).durationSeconds-sourceDuration) < 1/44100);
    preview.appliedAssetId = result.newAssetId;
  }
  assert.equal(checkpoints, 6);
  // Three selected clips, two source recordings, plus an unselected overlapping use.
  doc.replaceClipAsset([clip.id], asset.id);
  const secondInput = join(dir, 'second-source.wav');
  await runOrThrow(paths.ffmpeg, ['-y', '-v', 'error', '-i', input, '-af', 'volume=0.5', secondInput]);
  const second = await importAsset(secondInput);
  const shared = doc.insertClip({kind:'audio',assetId:asset.id,trackId:track.id,startFrame:120,durationFrames:30,trimBefore:30,placement:'overlap'});
  const other = doc.insertClip({kind:'audio',assetId:second.asset.id,trackId:track.id,startFrame:160,durationFrames:45,trimBefore:5,placement:'overlap'});
  const batchBefore = doc.toJSON().clips;
  let restoredSources = 0;
  const batch = await generateStudioVoiceSelection(ctx, [clip.id,shared.id,other.id], paths, (p,m)=>console.log(Math.round(p*100),m), async (...args)=>{restoredSources++;return generateStudioVoice(...args);});
  assert.equal(restoredSources,2); assert.equal(batch.clips!.length,3);
  assert.deepEqual(doc.toJSON().clips,batchBefore);
  const batchResult = await applyStudioVoice(ctx,batch,0.6,paths,()=>{});
  assert.equal(batchResult.assetsProcessed,2);assert.equal(batchResult.clipsUpdated,3);
  const applied = new Map(batchResult.appliedClips.map(c=>[c.clipId,c.newAssetId]));
  for(const c of batchBefore)assert.deepEqual(doc.getClip(c.id),applied.has(c.id)?{...c,assetId:applied.get(c.id)}:c);
  console.log('PASS: three selected clips, two GPU restorations, shared source reuse, batch Apply, unselected overlapping audio unchanged.');

  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(new Error('Test cancellation')), 250);
  try { await assert.rejects(withAiCancellation(abort.signal, () => restoreStudioVoice(input, join(dir, 'cancelled.wav'))), /Test cancellation/); }
  finally { clearTimeout(timer); }
  console.log('PASS: real GPU preview, exact duration, 0/75/100% apply, timing/trim/speed, unselected clips, cancellation.');
} finally { await rm(dir, { recursive: true, force: true }); }
