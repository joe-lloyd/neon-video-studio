/**
 * AI feature orchestration. Every operation is a job (sequential queue) that reads the project,
 * runs the local engines from @neon/ai and writes results back through ProjectDoc so the UI,
 * CLI and peers all see them. Heavy lifting happens in child processes (ffmpeg, whisper-cli,
 * neon-vision); this file only maps between source seconds and timeline frames.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, extname, join } from 'node:path';
import {
  ORIGIN_API,
  mergeRanges,
  newId,
  sourceSecondsToTimeline,
  type AiCapabilities,
  type AiJob,
  type AiOperation,
  type Asset,
  type FrameRange,
  type MediaClip,
  type Transcript,
} from '@neon/core';
import {
  DEFAULT_FILLERS,
  SETUP_HINTS,
  analyseBreaths,
  analyseSilences,
  breathKeyframes,
  chooseDenoiseEngine,
  chromaMatte,
  denoise,
  detectTools,
  extractConcepts,
  fillerRanges,
  markFillers,
  matchAssetsHeuristic,
  matchAssetsWithClaude,
  parseAspect,
  personMatte,
  probe,
  reframeFromTrack,
  trackFaces,
  transcribe,
  transcriptText,
  type BrollSuggestion,
  type Segment,
  type ToolPaths,
} from '@neon/ai';
import type { MainContext } from './context.ts';

type Params = Record<string, unknown>;

interface Target {
  asset: Asset;
  file: string;
  clips: MediaClip[];
}

const MAX_LOG = 40;

export class AiManager {
  private readonly jobs = new Map<string, AiJob>();
  private queue: { job: AiJob; params: Params }[] = [];
  private active = false;
  private tools: { paths: ToolPaths; capabilities: AiCapabilities } | null = null;
  private readonly ctx: MainContext;

  constructor(ctx: MainContext) {
    this.ctx = ctx;
  }

  async capabilities(refresh = false): Promise<AiCapabilities & { hints: typeof SETUP_HINTS }> {
    if (!this.tools || refresh) this.tools = await detectTools();
    return { ...this.tools.capabilities, hints: SETUP_HINTS };
  }

  private async paths(): Promise<ToolPaths> {
    if (!this.tools) this.tools = await detectTools();
    return this.tools.paths;
  }

  list(): AiJob[] {
    return [...this.jobs.values()].sort((a, b) => b.startedAt.localeCompare(a.startedAt)).slice(0, 30);
  }

  get(id: string): AiJob | undefined {
    return this.jobs.get(id);
  }

  cancel(id: string): AiJob | undefined {
    const job = this.jobs.get(id);
    if (!job) return undefined;
    if (job.status === 'queued') {
      this.queue = this.queue.filter((q) => q.job.id !== id);
      this.update(job, { status: 'cancelled', finishedAt: new Date().toISOString() });
    } else if (job.status === 'running') {
      job.log.push('cancel requested — will stop after the current step');
      (job as AiJob & { cancelRequested?: boolean }).cancelRequested = true;
    }
    return job;
  }

  start(op: AiOperation, params: Params): AiJob {
    const job: AiJob = {
      id: newId('ai'),
      op,
      status: 'queued',
      progress: 0,
      message: 'Queued',
      clipId: typeof params.clipId === 'string' ? params.clipId : undefined,
      assetId: typeof params.assetId === 'string' ? params.assetId : undefined,
      startedAt: new Date().toISOString(),
      log: [],
    };
    this.jobs.set(job.id, job);
    this.queue.push({ job, params });
    this.update(job, {});
    void this.pump();
    return job;
  }

  private update(job: AiJob, patch: Partial<AiJob>): void {
    Object.assign(job, patch);
    const snapshot: AiJob = { ...job, log: [...job.log] };
    this.ctx.rpc?.send.aiUpdate({ job: snapshot });
    this.ctx.events.emit({ type: 'ai', job: snapshot });
  }

  private progress(job: AiJob, progress: number, message?: string): void {
    this.update(job, { progress: Math.max(job.progress, Math.min(0.99, progress)), ...(message ? { message } : {}) });
  }

  private log(job: AiJob, line: string): void {
    job.log.push(line);
    if (job.log.length > MAX_LOG) job.log.splice(0, job.log.length - MAX_LOG);
  }

  private async pump(): Promise<void> {
    if (this.active) return;
    const next = this.queue.shift();
    if (!next) return;
    this.active = true;
    const { job, params } = next;
    this.update(job, { status: 'running', message: 'Starting…' });
    try {
      const result = await this.runOp(job, params);
      this.update(job, { status: 'done', progress: 1, message: summarize(job.op, result), result, finishedAt: new Date().toISOString() });
      this.ctx.events.activity('ai', `ai.${job.op}`, summarize(job.op, result), { clipIds: job.clipId ? [job.clipId] : undefined, assetIds: job.assetId ? [job.assetId] : undefined, jobId: job.id });
    } catch (err) {
      const message = (err as Error).message;
      this.update(job, { status: 'failed', error: message, message: `Failed: ${message}`, finishedAt: new Date().toISOString() });
      this.ctx.events.activity('ai', `ai.${job.op}.failed`, `${job.op} failed: ${message}`, { jobId: job.id });
    } finally {
      this.active = false;
      void this.pump();
    }
  }

  // ---- helpers ---------------------------------------------------------------------------

  private async resolveTarget(params: Params): Promise<Target> {
    const doc = this.ctx.store.doc;
    const project = doc.toJSON();
    let asset: Asset | undefined;
    let clips: MediaClip[] = [];
    if (typeof params.clipId === 'string') {
      const clip = project.clips.find((c) => c.id === params.clipId);
      if (!clip) throw new Error(`Clip ${params.clipId} not found`);
      if (clip.kind === 'component') throw new Error('AI audio/video features need a media clip, not a template');
      asset = project.assets.find((a) => a.id === clip.assetId);
      clips = [clip];
    } else if (typeof params.assetId === 'string') {
      const ref = params.assetId;
      asset = project.assets.find((a) => a.id === ref) ?? project.assets.find((a) => a.id.startsWith(ref)) ?? project.assets.find((a) => a.name === ref);
      if (asset) clips = project.clips.filter((c): c is MediaClip => c.kind !== 'component' && c.assetId === asset!.id);
    } else {
      throw new Error('Specify clipId or assetId');
    }
    if (!asset) throw new Error('Asset not found in project');
    if (typeof params.clipId !== 'string') {
      // Include clips that show a derivative of this asset (denoised / matted copies) and,
      // when the reference IS a derivative, clips of its source — the family shares timing.
      const family = new Set<string>([asset.id]);
      let changed = true;
      while (changed) {
        changed = false;
        for (const a of project.assets) {
          if (a.derivedFrom && family.has(a.derivedFrom) && !family.has(a.id)) {
            family.add(a.id);
            changed = true;
          }
          if (a.derivedFrom && family.has(a.id) && !family.has(a.derivedFrom)) {
            family.add(a.derivedFrom);
            changed = true;
          }
        }
      }
      clips = project.clips.filter((c): c is MediaClip => c.kind !== 'component' && family.has(c.assetId));
    }
    const file = await this.ctx.assets.resolveFile(asset.id);
    if (!file) throw new Error(`Media file for ${asset.name} is not available locally`);
    return { asset, file, clips };
  }

  /** Map source-second segments onto the timeline through the clips that show this asset. */
  private timelineRanges(segments: Segment[], clips: MediaClip[]): FrameRange[] {
    const fps = this.ctx.store.doc.fps;
    const out: FrameRange[] = [];
    for (const clip of clips) {
      for (const seg of segments) {
        const r = sourceSecondsToTimeline(clip, seg.start, seg.end, fps);
        if (r) out.push(r);
      }
    }
    return mergeRanges(out, 1);
  }

  private async ensureTranscript(job: AiJob, target: Target, force = false): Promise<Transcript> {
    const doc = this.ctx.store.doc;
    const existing = doc.getTranscript(target.asset.id);
    if (existing && !force) return existing;
    const paths = await this.paths();
    if (!paths.whisper || !paths.whisperModel) {
      throw new Error(`Speech recognition is not installed. ${SETUP_HINTS.whisper}`);
    }
    this.progress(job, 0.1, `Transcribing ${target.asset.name} (whisper.cpp)…`);
    const transcript = await transcribe(target.file, {
      ffmpeg: paths.ffmpeg,
      whisper: paths.whisper,
      model: paths.whisperModel,
      assetId: target.asset.id,
      force,
      onLog: (line) => this.log(job, line),
    });
    markFillers(transcript.words);
    doc.setTranscript(transcript, ORIGIN_API);
    return transcript;
  }

  private async importDerived(job: AiJob, source: Asset, file: string, processing: string[], extra: Partial<Asset> = {}): Promise<Asset> {
    this.progress(job, 0.95, 'Importing result into the project');
    const result = await this.ctx.assets.import(file, { origin: ORIGIN_API });
    this.ctx.store.doc.updateAsset(result.asset.id, { derivedFrom: source.id, processing: [...(source.processing ?? []), ...processing], ...extra }, ORIGIN_API);
    // Audio timing is unchanged by these operations, so the transcript carries over.
    const transcript = this.ctx.store.doc.getTranscript(source.id);
    if (transcript && !this.ctx.store.doc.getTranscript(result.asset.id)) {
      this.ctx.store.doc.setTranscript({ ...transcript, assetId: result.asset.id }, ORIGIN_API);
    }
    return this.ctx.store.doc.getAsset(result.asset.id) ?? result.asset;
  }

  // ---- operations ------------------------------------------------------------------------

  private async runOp(job: AiJob, params: Params): Promise<unknown> {
    switch (job.op) {
      case 'transcribe':
        return this.opTranscribe(job, params);
      case 'fillers':
        return this.opFillers(job, params);
      case 'silence':
        return this.opSilence(job, params);
      case 'breaths':
        return this.opBreaths(job, params);
      case 'denoise':
        return this.opDenoise(job, params);
      case 'matte':
        return this.opMatte(job, params);
      case 'reframe':
        return this.opReframe(job, params);
      case 'broll':
        return this.opBroll(job, params);
      case 'clean':
        return this.opClean(job, params);
      case 'transcript-cut':
        return this.opTranscriptCut(job, params);
      default:
        throw new Error(`Unknown AI operation ${String(job.op)}`);
    }
  }

  private async opTranscribe(job: AiJob, params: Params) {
    const target = await this.resolveTarget(params);
    const transcript = await this.ensureTranscript(job, target, Boolean(params.force));
    return { assetId: target.asset.id, words: transcript.words.length, fillers: transcript.words.filter((w) => w.filler).length, text: transcriptText(transcript.words), engine: transcript.engine };
  }

  private async opFillers(job: AiJob, params: Params) {
    const target = await this.resolveTarget(params);
    const transcript = await this.ensureTranscript(job, target);
    const list = Array.isArray(params.words) && params.words.length ? (params.words as string[]) : DEFAULT_FILLERS;
    this.progress(job, 0.7, 'Finding disfluencies');
    const words = transcript.words.map((w) => ({ ...w }));
    const flagged = markFillers(words, list);
    this.ctx.store.doc.setTranscript({ ...transcript, words }, ORIGIN_API);
    const segments = fillerRanges(words, Number(params.padMs ?? 40));
    const ranges = this.timelineRanges(segments, target.clips);
    let removedFrames = 0;
    if (params.apply && ranges.length) {
      this.progress(job, 0.9, `Cutting ${ranges.length} range(s) from the timeline`);
      removedFrames = this.ctx.store.doc.cutRanges(ranges, { ripple: true, crossfadeFrames: 2 }, ORIGIN_API).removedFrames;
    }
    return { fillers: flagged.length, words: flagged.map((i) => words[i]!.w), segments, ranges, removedFrames, applied: Boolean(params.apply) };
  }

  private async opSilence(job: AiJob, params: Params) {
    const target = await this.resolveTarget(params);
    const paths = await this.paths();
    this.progress(job, 0.2, 'Analysing audio energy');
    const plan = await analyseSilences(paths.ffmpeg, target.file, {
      thresholdDb: params.thresholdDb === undefined ? undefined : Number(params.thresholdDb),
      minSilenceMs: Number(params.minSilenceMs ?? 400),
      keepMs: Number(params.keepMs ?? 150),
    });
    const ranges = this.timelineRanges(plan.cuts, target.clips);
    let removedFrames = 0;
    if (params.apply && ranges.length) {
      this.progress(job, 0.9, `Trimming ${ranges.length} pause(s)`);
      removedFrames = this.ctx.store.doc.cutRanges(ranges, { ripple: true, crossfadeFrames: 2 }, ORIGIN_API).removedFrames;
    }
    return { silences: plan.silences.length, cuts: plan.cuts, ranges, removedFrames, noiseFloorDb: plan.noiseFloorDb, thresholdDb: plan.thresholdDb, applied: Boolean(params.apply) };
  }

  private async opBreaths(job: AiJob, params: Params) {
    const target = await this.resolveTarget(params);
    const paths = await this.paths();
    this.progress(job, 0.2, 'Listening for breaths and mouth noise');
    const analysis = await analyseBreaths(paths.ffmpeg, target.file);
    const fps = this.ctx.store.doc.fps;
    const reductionDb = Number(params.reductionDb ?? 15);
    let applied = 0;
    if (params.apply !== false) {
      for (const clip of target.clips) {
        const kfs = breathKeyframes(analysis.breaths, clip, fps, reductionDb);
        this.ctx.store.doc.updateClip(clip.id, { volumeKeyframes: kfs.length > 2 ? kfs : null }, ORIGIN_API);
        applied++;
      }
    }
    return { breaths: analysis.breaths.length, segments: analysis.breaths, reductionDb, clipsUpdated: applied, noiseFloorDb: analysis.noiseFloorDb };
  }

  private async opDenoise(job: AiJob, params: Params) {
    const target = await this.resolveTarget(params);
    const paths = await this.paths();
    const info = await probe(paths.ffprobe, target.file);
    if (!info.hasAudio) throw new Error(`${target.asset.name} has no audio track`);
    const engine = chooseDenoiseEngine(paths, (params.engine as 'auto' | 'rnnoise' | 'afftdn' | 'deepfilter') ?? 'auto');
    const dir = await mkdtemp(join(tmpdir(), 'neon-denoise-'));
    try {
      const stem = basename(target.asset.name).replace(/\.[^.]+$/, '');
      const out = join(dir, `${stem}-denoised${info.hasVideo ? (extname(target.asset.name).toLowerCase() === '.mov' ? '.mov' : '.mp4') : '.m4a'}`);
      this.progress(job, 0.1, `Denoising with ${engine}…`);
      const r = await denoise(target.file, out, {
        paths,
        engine,
        strength: Number(params.strength ?? 0.7),
        hasVideo: info.hasVideo,
        durationSeconds: info.durationSeconds,
        onProgress: (p) => this.progress(job, 0.1 + p * 0.8),
      });
      const asset = await this.importDerived(job, target.asset, out, [`denoise:${r.engine}`]);
      if (target.clips.length) this.ctx.store.doc.replaceClipAsset(target.clips.map((c) => c.id), asset.id, ORIGIN_API);
      return { engine: r.engine, filter: r.filter, newAssetId: asset.id, clipsUpdated: target.clips.length };
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  private async opMatte(job: AiJob, params: Params) {
    const target = await this.resolveTarget(params);
    const paths = await this.paths();
    if (target.asset.kind !== 'video') throw new Error('Background removal works on video clips');
    const mode = (params.mode as 'person' | 'chroma') ?? 'person';
    const dir = await mkdtemp(join(tmpdir(), 'neon-matte-'));
    try {
      const out = join(dir, `${basename(target.asset.name).replace(/\.[^.]+$/, '')}-${mode === 'person' ? 'matte' : 'keyed'}.mov`);
      const r =
        mode === 'chroma'
          ? await chromaMatte(target.file, out, { paths, color: String(params.color ?? '0x00FF00'), similarity: Number(params.similarity ?? 0.3), blend: Number(params.blend ?? 0.1), onProgress: (p) => this.progress(job, 0.1 + p * 0.8, 'Keying') })
          : await personMatte(target.file, out, { paths, quality: (params.quality as 'fast' | 'balanced' | 'accurate') ?? 'balanced', onProgress: (p, m) => this.progress(job, 0.05 + p * 0.88, m) });
      const asset = await this.importDerived(job, target.asset, out, [`matte:${mode}`], { hasAlpha: true });
      if (target.clips.length) this.ctx.store.doc.replaceClipAsset(target.clips.map((c) => c.id), asset.id, ORIGIN_API);
      return { mode: r.mode, frames: r.frames, newAssetId: asset.id, clipsUpdated: target.clips.length };
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  private async opReframe(job: AiJob, params: Params) {
    const target = await this.resolveTarget(params);
    const paths = await this.paths();
    if (target.asset.kind !== 'video') throw new Error('Auto-reframe works on video clips');
    const aspect = parseAspect(String(params.aspect ?? '9:16'));
    const result = await trackFaces(target.file, { paths, sampleFps: Number(params.sampleFps ?? 5), onProgress: (p, m) => this.progress(job, p * 0.9, m) });
    const fps = this.ctx.store.doc.fps;
    const mode = result.detectedRatio > 0.2 ? 'face-track' : 'center';
    for (const clip of target.clips) {
      this.ctx.store.doc.updateClip(clip.id, { reframe: reframeFromTrack(result.track, clip, fps, aspect, mode), fit: 'cover' }, ORIGIN_API);
    }
    let resized: { width: number; height: number } | null = null;
    if (params.resizeProject) {
      const meta = this.ctx.store.doc.getMeta();
      const height = Math.max(meta.width, meta.height);
      const width = Math.round((height * aspect) / 2) * 2;
      resized = { width, height };
      this.ctx.store.doc.updateMeta(resized, ORIGIN_API);
    }
    return { mode, detectedRatio: result.detectedRatio, samples: result.track.length, aspect, clipsUpdated: target.clips.length, resized };
  }

  private async opBroll(job: AiJob, params: Params) {
    const doc = this.ctx.store.doc;
    const project = doc.toJSON();
    const fps = doc.fps;
    let transcripts = project.transcripts;
    if (typeof params.assetId === 'string') {
      const target = await this.resolveTarget(params);
      transcripts = [await this.ensureTranscript(job, target)];
    } else if (transcripts.length === 0) {
      // Transcribe every speaking clip's asset that has audio.
      for (const asset of project.assets.filter((a) => a.kind !== 'image')) {
        const file = await this.ctx.assets.resolveFile(asset.id);
        if (!file) continue;
        const clips = project.clips.filter((c): c is MediaClip => c.kind !== 'component' && c.assetId === asset.id);
        if (clips.length === 0) continue;
        await this.ensureTranscript(job, { asset, file, clips });
      }
      transcripts = doc.toJSON().transcripts;
    }
    if (transcripts.length === 0) throw new Error('No transcript available — import a clip with speech first');
    this.progress(job, 0.6, 'Extracting concepts');
    const speakingAssets = new Set(transcripts.map((t) => t.assetId));
    const suggestions: BrollSuggestion[] = [];
    const caps = await this.capabilities();
    for (const transcript of transcripts) {
      const concepts = extractConcepts(transcript.words);
      let matches = matchAssetsHeuristic(concepts, project.assets, { excludeAssetIds: speakingAssets });
      if (params.useClaude !== false && caps.claude.available) {
        try {
          this.progress(job, 0.7, 'Asking Claude to pick B-roll');
          const smart = await matchAssetsWithClaude(concepts, project.assets, { excludeAssetIds: speakingAssets, onLog: (l) => this.log(job, l) });
          if (smart.length) {
            const covered = new Set(smart.map((s) => s.conceptIndex));
            matches = [...smart, ...matches.filter((m) => !covered.has(m.conceptIndex))];
          }
        } catch (err) {
          this.log(job, `Claude unavailable (${(err as Error).message}); using heuristic matches`);
        }
      }
      // Map concept times onto the timeline through the clips that play this asset.
      const clips = project.clips.filter((c): c is MediaClip => c.kind !== 'component' && c.assetId === transcript.assetId);
      for (const m of matches.slice(0, Number(params.maxSuggestions ?? 12))) {
        const ranges = this.timelineRanges([{ start: m.startS, end: m.endS }], clips);
        if (ranges.length === 0) continue;
        suggestions.push({ ...m, startS: ranges[0]!.start / fps, endS: ranges[0]!.end / fps });
      }
    }
    let placed = 0;
    if (params.apply && suggestions.length) {
      this.progress(job, 0.9, `Placing ${suggestions.length} B-roll clip(s)`);
      const durationFrames = Math.round(Number(params.durationSeconds ?? 3) * fps);
      const videoTrack = doc.toJSON().tracks.find((t) => t.name === 'B-ROLL') ?? doc.addTrack('video', 'B-ROLL', ORIGIN_API);
      const overlayTrack = doc.toJSON().tracks.find((t) => t.name === 'B-ROLL IMG') ?? doc.addTrack('overlay', 'B-ROLL IMG', ORIGIN_API);
      for (const s of suggestions) {
        const asset = project.assets.find((a) => a.id === s.assetId);
        if (!asset) continue;
        const startFrame = Math.round(s.startS * fps);
        const length = Math.max(fps, Math.min(durationFrames, Math.round((s.endS - s.startS) * fps)));
        doc.insertClip(
          { kind: asset.kind, assetId: asset.id, startFrame, durationFrames: length, trackId: asset.kind === 'image' ? overlayTrack.id : videoTrack.id, placement: 'free', name: `B-roll: ${s.keyword || asset.name}` },
          ORIGIN_API,
        );
        placed++;
      }
    }
    return { suggestions, placed, applied: Boolean(params.apply), claude: caps.claude.available && params.useClaude !== false };
  }

  private async opClean(job: AiJob, params: Params) {
    const steps: string[] = [];
    const out: Record<string, unknown> = {};
    if (params.fillers !== false) {
      this.progress(job, 0.05, 'Step 1/4 · fillers');
      out.fillers = await this.opFillers(job, { ...params, apply: true });
      steps.push('fillers');
    }
    if (params.silences !== false) {
      this.progress(job, 0.35, 'Step 2/4 · silences');
      out.silence = await this.opSilence(job, { ...params, apply: true });
      steps.push('silences');
    }
    if (params.breaths !== false) {
      this.progress(job, 0.6, 'Step 3/4 · breaths');
      out.breaths = await this.opBreaths(job, { ...params, apply: true });
      steps.push('breaths');
    }
    if (params.denoise) {
      this.progress(job, 0.8, 'Step 4/4 · denoise');
      out.denoise = await this.opDenoise(job, params);
      steps.push('denoise');
    }
    return { steps, ...out };
  }

  private async opTranscriptCut(job: AiJob, params: Params) {
    const target = await this.resolveTarget({ assetId: params.assetId });
    const transcript = this.ctx.store.doc.getTranscript(target.asset.id);
    if (!transcript) throw new Error('No transcript for this asset');
    const from = Math.max(0, Number(params.fromWord));
    const to = Math.min(transcript.words.length - 1, Number(params.toWord));
    if (!(from <= to)) throw new Error('Invalid word range');
    const startS = Math.max(transcript.words[from - 1]?.e ?? 0, transcript.words[from]!.s - 0.03);
    const endS = Math.min(transcript.words[to + 1]?.s ?? Number.POSITIVE_INFINITY, transcript.words[to]!.e + 0.03);
    const ranges = this.timelineRanges([{ start: startS, end: endS }], target.clips);
    this.progress(job, 0.5, 'Cutting words from the timeline');
    const r = this.ctx.store.doc.cutRanges(ranges, { ripple: true, crossfadeFrames: 2 }, ORIGIN_API);
    return { words: transcript.words.slice(from, to + 1).map((w) => w.w).join(' '), ranges, ...r };
  }
}

function summarize(op: AiOperation, result: unknown): string {
  const r = (result ?? {}) as Record<string, unknown>;
  switch (op) {
    case 'transcribe':
      return `Transcribed ${String(r.words)} words (${String(r.fillers)} fillers)`;
    case 'fillers':
      return r.applied ? `Removed ${String(r.fillers)} filler word(s), ${String(r.removedFrames)} frames` : `Found ${String(r.fillers)} filler word(s) in ${(r.ranges as unknown[])?.length ?? 0} range(s)`;
    case 'silence':
      return r.applied ? `Trimmed ${(r.cuts as unknown[])?.length ?? 0} pause(s), ${String(r.removedFrames)} frames` : `Found ${(r.cuts as unknown[])?.length ?? 0} pause(s) to trim`;
    case 'breaths':
      return `Attenuated ${String(r.breaths)} breath/mouth-noise event(s) by ${String(r.reductionDb)} dB`;
    case 'denoise':
      return `Denoised with ${String(r.engine)} → new asset ${String(r.newAssetId).slice(0, 8)}…`;
    case 'matte':
      return `Background removed (${String(r.mode)}) → alpha asset ${String(r.newAssetId).slice(0, 8)}…`;
    case 'reframe':
      return `Auto-reframe (${String(r.mode)}, faces in ${Math.round(Number(r.detectedRatio ?? 0) * 100)}% of samples)`;
    case 'broll':
      return r.applied ? `Placed ${String(r.placed)} B-roll clip(s)` : `${(r.suggestions as unknown[])?.length ?? 0} B-roll suggestion(s)`;
    case 'clean':
      return `Voice clean-up done (${(r.steps as string[])?.join(', ')})`;
    case 'transcript-cut':
      return `Cut “${String(r.words).slice(0, 40)}” (${String(r.removedFrames)} frames)`;
    default:
      return 'done';
  }
}
