import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ORIGIN_API, type StudioVoicePreview, type Project } from '@neon/core';
import { probe, runOrThrow, restoreStudioVoice, throwIfCancelled, type ToolPaths } from '@neon/ai';
import type { MainContext } from './context.ts';

type Progress = (fraction: number, message: string) => void;

export function validateStudioTarget(project: Project, preview: StudioVoicePreview) {
  const clip = project.clips.find(c => c.id === preview.clipId);
  if (project.meta.id !== preview.projectId || project.meta.fps !== preview.fps || !clip || clip.kind !== 'audio' ||
      ![preview.sourceAssetId, preview.appliedAssetId].includes(clip.assetId) ||
      clip.startFrame !== preview.startFrame || clip.durationFrames !== preview.durationFrames ||
      clip.trimBefore !== preview.trimBefore || (clip.speed ?? 1) !== preview.speed) {
    throw new Error('This clip changed since the preview. Generate a new Studio Voice preview.');
  }
  return clip;
}

function guardProject(ctx: MainContext, projectId: string) {
  throwIfCancelled();
  if (ctx.store.doc.toJSON().meta.id !== projectId) throw new Error('The open project changed. Studio Voice stopped.');
}

async function importAudio(ctx: MainContext, file: string, preview: Pick<StudioVoicePreview, 'projectId' | 'sourceAssetId'>, processing: string) {
  guardProject(ctx, preview.projectId);
  const result = await ctx.assets.import(file, { origin: ORIGIN_API });
  guardProject(ctx, preview.projectId);
  const doc = ctx.store.doc;
  const source = doc.getAsset(preview.sourceAssetId);
  if (result.asset.id === preview.sourceAssetId) return result.asset.id;
  doc.updateAsset(result.asset.id, { derivedFrom: preview.sourceAssetId, processing: [...(source?.processing ?? []), processing] }, ORIGIN_API);
  const transcript = doc.getTranscript(preview.sourceAssetId);
  if (transcript) doc.setTranscript({ ...transcript, assetId: result.asset.id }, ORIGIN_API);
  return result.asset.id;
}

/** Preview generation imports audition files but never changes any timeline clips. */
export async function generateStudioVoice(ctx: MainContext, clipId: string, paths: ToolPaths, progress: Progress, restore = restoreStudioVoice): Promise<StudioVoicePreview> {
  const project = ctx.store.doc.toJSON();
  const clip = project.clips.find(c => c.id === clipId);
  if (!clip || clip.kind !== 'audio') throw new Error('Select one audio clip for Studio Voice. Detach video audio first.');
  const file = await ctx.assets.resolveFile(clip.assetId);
  if (!file) throw new Error('Source audio is unavailable');
  const snapshot = { fps: project.meta.fps, projectId: project.meta.id, clipId, sourceAssetId: clip.assetId, startFrame: clip.startFrame, durationFrames: clip.durationFrames, trimBefore: clip.trimBefore, speed: clip.speed ?? 1 };
  const dir = await mkdtemp(join(tmpdir(), 'neon-studio-'));
  try {
    progress(0.02, 'Preparing source recording for local restoration…');
    const input = join(dir, 'input.wav');
    const raw = join(dir, 'restored.wav');
    await runOrThrow(paths.ffmpeg, ['-y', '-v', 'error', '-i', file, '-vn', '-ac', '1', '-ar', '44100', '-c:a', 'pcm_s24le', input]);
    const info = await probe(paths.ffprobe, input);
    if (!info.hasAudio || !(info.durationSeconds > 0)) throw new Error('Source has no audio');
    const samples = Math.round(info.durationSeconds * 44100);
    await restore(input, raw, (p, m) => progress(0.05 + p * 0.78, m));
    const restored = await probe(paths.ffprobe, raw);
    if (Math.abs(restored.durationSeconds - info.durationSeconds) > 0.1) throw new Error('Restoration changed source timing unexpectedly');
    const dry = join(dir, 'Studio Voice Original.wav');
    const wet = join(dir, 'Studio Voice Restored.wav');
    progress(0.85, 'Matching audition loudness…');
    for (const [source, output] of [[input, dry], [raw, wet]]) {
      await runOrThrow(paths.ffmpeg, ['-y', '-v', 'error', '-i', source!, '-af', `loudnorm=I=-16:TP=-1.5:LRA=11,aresample=44100,apad,atrim=end_sample=${samples}`, '-c:a', 'pcm_s24le', output!]);
    }
    guardProject(ctx, snapshot.projectId);
    validateStudioTarget(ctx.store.doc.toJSON(), { ...snapshot, dryAssetId: '', wetAssetId: '' });
    const dryAssetId = await importAudio(ctx, dry, snapshot, 'studio-voice:original-levelmatched');
    const wetAssetId = await importAudio(ctx, wet, snapshot, 'studio-voice:voicefixer-local');
    return { ...snapshot, dryAssetId, wetAssetId };
  } finally { await rm(dir, { recursive: true, force: true }); }
}

export async function applyStudioVoice(ctx: MainContext, preview: StudioVoicePreview, strength: number, paths: ToolPaths, progress: Progress) {
  if (!Number.isFinite(strength) || strength < 0 || strength > 1) throw new Error('Studio Voice strength must be between 0 and 1');
  validateStudioTarget(ctx.store.doc.toJSON(), preview);
  const dry = await ctx.assets.resolveFile(preview.dryAssetId);
  const wet = await ctx.assets.resolveFile(preview.wetAssetId);
  if (!dry || !wet) throw new Error('Audition files are unavailable. Generate a new preview.');
  const dir = await mkdtemp(join(tmpdir(), 'neon-studio-mix-'));
  try {
    progress(0.1, 'Rendering Studio Voice blend…');
    const output = join(dir, `Studio Voice ${Math.round(strength * 100)} percent.wav`);
    await runOrThrow(paths.ffmpeg, ['-y', '-v', 'error', '-i', dry, '-i', wet, '-filter_complex', `[0:a]volume=${1-strength}[dry];[1:a]volume=${strength}[wet];[dry][wet]amix=inputs=2:normalize=0:duration=first[out]`, '-map', '[out]', '-c:a', 'pcm_s24le', output]);
    guardProject(ctx, preview.projectId);
    validateStudioTarget(ctx.store.doc.toJSON(), preview);
    await ctx.history.push();
    const newAssetId = await importAudio(ctx, output, preview, `studio-voice:blend:${strength}`);
    guardProject(ctx, preview.projectId);
    validateStudioTarget(ctx.store.doc.toJSON(), preview);
    ctx.store.doc.replaceClipAsset([preview.clipId], newAssetId, ORIGIN_API);
    await ctx.store.flush();
    const status = await ctx.history.push();
    ctx.rpc?.send.historyChanged({ status });
    return { newAssetId, clipId: preview.clipId, strength };
  } finally { await rm(dir, { recursive: true, force: true }); }
}
