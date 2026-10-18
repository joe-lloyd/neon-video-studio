import { ORIGIN_API, type ImportAssetResponse } from '@neon/core';
import { decodePcm, energyVad, frameEnergies, which } from '@neon/ai';
import type { MainContext } from './context.ts';

/** Import first, then replace line takes in one edit. A failed recording keeps previous takes. */
export async function finishVoiceOver(ctx: MainContext, input: { startFrame: number; lineId?: string; trimBefore?: number }, origin: unknown = ORIGIN_API): Promise<ImportAssetResponse> {
  const { file, dispose } = await ctx.recorder.stop();
  try {
    const imported = await ctx.assets.import(file, { origin });
    return placeVoiceOver(ctx, { ...input, assetId: imported.asset.id }, origin);
  } finally {
    await dispose();
  }
}

export async function placeVoiceOver(ctx: MainContext, input: { assetId: string; startFrame: number; lineId?: string; trimBefore?: number }, origin: unknown = ORIGIN_API): Promise<ImportAssetResponse> {
    const asset = ctx.store.doc.getAsset(input.assetId);
    const file = await ctx.assets.resolveFile(input.assetId);
    if (!asset || !file) throw new Error('The recorded audio asset is missing');
    const pcm = await decodePcm((await which('ffmpeg')) ?? 'ffmpeg', file);
    const speech = energyVad(frameEnergies(pcm, 20)).speech;
    const fps = ctx.store.doc.fps;
    await ctx.history.push();
    const hasScript = ctx.store.doc.getScript().sections.some(s => s.lines.some(l => l.placed));
    const clips = ctx.store.doc.placeVoiceOver({ ...input,
      ...(hasScript ? { speechRanges: speech.map(s => ({ start: Math.max(0, Math.floor((s.start - .1) * fps)), end: Math.ceil((s.end + .15) * fps) })) } : {}),
    }, origin);
    ctx.waveforms.warm(asset.id);
    await ctx.store.flush();
    const status = await ctx.history.push();
    ctx.rpc?.send.historyChanged({ status });
    ctx.events.activity('ui', 'vo.done', `Saved ${clips.length} voice-over line${clips.length === 1 ? '' : 's'}`, { clipIds: clips.map(c => c.id), assetIds: [asset.id] });
    return { asset, clip: clips[0], deduplicated: false };
}
