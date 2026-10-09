/**
 * Captions from word-level transcripts. Transcripts stay in SOURCE seconds per asset; these pure
 * functions place the words on the current timeline (through every cut, split and speed change via
 * timing.ts), group them into readable cues and serialise them as SRT/WebVTT. The Captions template,
 * the CLI exports and anything else that shows subtitles all go through here.
 */
import { volumeAt } from './ops.ts';
import { sourceSecondsToLocal, speedOf, timelineFrameAt } from './timing.ts';
import type { Asset, MediaClip, Project, Transcript } from './types.ts';

/** A spoken word placed on the timeline: [start, end) in timeline frames at project fps. */
export interface TimelineWord {
  text: string;
  start: number;
  end: number;
}

/** One subtitle: [start, end) in timeline frames, and the words it shows. */
export interface CaptionCue {
  start: number;
  end: number;
  text: string;
  words: TimelineWord[];
}

export interface TimelineWordsOptions {
  /** Track ids or names (case-insensitive) to caption. Absent or empty = every audio and video track. */
  tracks?: readonly string[];
  /** Keep words marked as fillers ("um", "uh"). Default false. */
  keepFillers?: boolean;
}

export interface CaptionPagesOptions {
  /** Most words on one cue. Default 6. */
  maxWords?: number;
  /** Most characters on one cue, spaces included. Default 7 × maxWords (42 for six words). */
  maxChars?: number;
  /** A pause longer than this starts a new cue; a cue also lingers at most this long after its last word. */
  maxGapFrames: number;
}

/** Audio above this rate is muted by the composition, so its words are not heard. */
const MAX_AUDIBLE_SPEED = 2;

/**
 * Transcript for an asset, following `derivedFrom` both ways: a denoised copy shares its original's
 * timing. Breadth-first, so the nearest relative's transcript wins when several exist.
 */
function transcriptLookup(assets: readonly Asset[], transcripts: readonly Transcript[]): (assetId: string) => Transcript | undefined {
  const byAsset = new Map(transcripts.map((t) => [t.assetId, t]));
  const neighbours = new Map<string, string[]>();
  const link = (a: string, b: string) => neighbours.set(a, [...(neighbours.get(a) ?? []), b]);
  for (const a of assets) {
    if (!a.derivedFrom) continue;
    link(a.id, a.derivedFrom);
    link(a.derivedFrom, a.id);
  }
  return (assetId) => {
    const seen = new Set([assetId]);
    const queue = [assetId];
    for (let id = queue.shift(); id !== undefined; id = queue.shift()) {
      const found = byAsset.get(id);
      if (found) return found;
      for (const n of neighbours.get(id) ?? []) {
        if (seen.has(n)) continue;
        seen.add(n);
        queue.push(n);
      }
    }
    return undefined;
  };
}

/**
 * Every transcribed word heard on the timeline, sorted by start. A word belongs to the clip that
 * plays its midpoint, so words cut away vanish and words at a cut edge are clipped to it. Only
 * audible words count: clips on hidden or muted tracks, clips at volume 0 (a video whose audio was
 * detached), clips above 2× (silent) and words muted by volume automation ("mute words") are skipped.
 */
export function timelineWords(project: Project, opts: TimelineWordsOptions = {}): TimelineWord[] {
  const fps = project.meta.fps;
  const wanted = opts.tracks?.map((t) => t.toLowerCase()).filter(Boolean) ?? [];
  const tracks = project.tracks.filter(
    (t) => !t.hidden && !t.muted && (wanted.length ? wanted.includes(t.id.toLowerCase()) || wanted.includes(t.name.toLowerCase()) : t.kind !== 'overlay'),
  );
  const trackIds = new Set(tracks.map((t) => t.id));
  const transcriptFor = transcriptLookup(project.assets, project.transcripts);
  const clips = project.clips.filter(
    (c): c is MediaClip => (c.kind === 'video' || c.kind === 'audio') && trackIds.has(c.trackId) && c.volume > 0 && speedOf(c) <= MAX_AUDIBLE_SPEED,
  );

  const placed = new Map<string, TimelineWord>();
  for (const clip of clips) {
    const transcript = transcriptFor(clip.assetId);
    if (!transcript) continue;
    transcript.words.forEach((word, index) => {
      if (word.filler && !opts.keepFillers) return;
      const text = word.w.trim();
      if (!text) return;
      const mid = timelineFrameAt(clip, ((word.s + word.e) / 2) * fps);
      if (mid === null) return;
      if (volumeAt(clip.volumeKeyframes, mid - clip.startFrame) < 0.05) return;
      const local = sourceSecondsToLocal(clip, word.s, word.e, fps) ?? { start: mid - clip.startFrame, end: mid - clip.startFrame + 1 };
      const start = clip.startFrame + local.start;
      // Two clips of one take playing the same word at the same moment (e.g. stacked video and audio): keep one.
      const key = `${transcript.assetId}:${index}:${start}`;
      if (!placed.has(key)) placed.set(key, { text, start, end: clip.startFrame + local.end });
    });
  }
  return [...placed.values()].sort((a, b) => a.start - b.start || a.end - b.end);
}

const SENTENCE_END = /[.!?…]["'”’)\]]*$/;
const CLAUSE_END = /[,;:—–]["'”’)\]]*$/;

/**
 * Group words into cues a viewer can read: a new cue starts after a pause longer than
 * `maxGapFrames`, after a sentence ends, after a clause once the cue is half full, and before the
 * cue would pass `maxWords` or `maxChars`. Each cue stays up until the next one starts, or at most
 * `maxGapFrames` after its last word.
 */
export function captionPages(words: readonly TimelineWord[], opts: CaptionPagesOptions): CaptionCue[] {
  const maxWords = Math.max(1, opts.maxWords ?? 6);
  const maxChars = Math.max(1, opts.maxChars ?? maxWords * 7);
  const groups: TimelineWord[][] = [];
  let current: TimelineWord[] = [];
  let chars = 0;
  for (const word of words) {
    const prev = current[current.length - 1];
    const breakHere =
      prev !== undefined &&
      (word.start - prev.end > opts.maxGapFrames ||
        SENTENCE_END.test(prev.text) ||
        (CLAUSE_END.test(prev.text) && current.length * 2 >= maxWords) ||
        current.length >= maxWords ||
        chars + 1 + word.text.length > maxChars);
    if (breakHere) {
      groups.push(current);
      current = [];
      chars = 0;
    }
    chars += (current.length ? 1 : 0) + word.text.length;
    current.push(word);
  }
  if (current.length) groups.push(current);

  return groups.map((group, i) => {
    const first = group[0]!;
    const last = group[group.length - 1]!;
    const next = groups[i + 1]?.[0];
    const linger = last.end + opts.maxGapFrames;
    return { start: first.start, end: Math.max(last.end, next ? Math.min(next.start, linger) : linger), text: group.map((w) => w.text).join(' '), words: group };
  });
}

/** A pause this long (seconds) ends a cue; a cue lingers at most this long after its last word. */
export const CAPTION_PAUSE_SECONDS = 0.6;

/** The project's captions with the standard pause rule — what the Captions template and the CLI exports show. */
export function projectCaptions(project: Project, opts: TimelineWordsOptions & Omit<CaptionPagesOptions, 'maxGapFrames'> = {}): CaptionCue[] {
  return captionPages(timelineWords(project, opts), { ...opts, maxGapFrames: Math.round(project.meta.fps * CAPTION_PAUSE_SECONDS) });
}

/** "A1, V1" → ["A1", "V1"]: the comma-separated track list used by the template prop and the CLI. */
export function parseTrackList(list: string | undefined): string[] {
  return (list ?? '').split(',').map((t) => t.trim()).filter(Boolean);
}

/** The cue showing at a timeline frame, if any. */
export function cueAt(cues: readonly CaptionCue[], frame: number): CaptionCue | undefined {
  return cues.find((c) => frame >= c.start && frame < c.end);
}

function clockTime(frame: number, fps: number, separator: ',' | '.'): string {
  const ms = Math.max(0, Math.round((frame / fps) * 1000));
  const pad = (n: number, width = 2) => String(n).padStart(width, '0');
  return `${pad(Math.floor(ms / 3_600_000))}:${pad(Math.floor(ms / 60_000) % 60)}:${pad(Math.floor(ms / 1000) % 60)}${separator}${pad(ms % 1000, 3)}`;
}

/** SubRip subtitles. */
export function toSrt(cues: readonly CaptionCue[], fps: number): string {
  return cues.map((c, i) => `${i + 1}\n${clockTime(c.start, fps, ',')} --> ${clockTime(c.end, fps, ',')}\n${c.text}\n`).join('\n');
}

/** WebVTT subtitles. */
export function toVtt(cues: readonly CaptionCue[], fps: number): string {
  return `WEBVTT\n\n${cues.map((c) => `${clockTime(c.start, fps, '.')} --> ${clockTime(c.end, fps, '.')}\n${c.text}\n`).join('\n')}`;
}
