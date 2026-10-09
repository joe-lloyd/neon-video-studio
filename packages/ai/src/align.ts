/**
 * Word timing repair. whisper.cpp's token clocks can run a few hundred milliseconds off the audio,
 * which is enough to cut half an "um" and leave the rest. Its DTW pass (`--dtw`) gives one reliable
 * anchor per word; the real pauses in the audio give the boundaries. Each word ends where the
 * longest pause between its anchor and the next word's anchor begins — or halfway, in continuous speech.
 */
import type { TranscriptWord } from '@neon/core';
import type { Segment } from './pcm.ts';

/** A word straight from whisper, with its DTW anchor time (seconds) when the build provides one. */
export type AnchoredWord = TranscriptWord & { t?: number };

const MIN_PAUSE = 0.03;
const TAIL = 0.5;

function strip(words: AnchoredWord[]): TranscriptWord[] {
  return words.map(({ t: _t, ...w }) => w);
}

export function alignWordsToSpeech(words: AnchoredWord[], pauses: readonly Segment[], durationSeconds: number): TranscriptWord[] {
  const anchored = words.filter((w) => w.t !== undefined).length;
  if (words.length === 0 || anchored < words.length * 0.8) return strip(words);
  // Anchors must not run backwards; words without one borrow the middle of their whisper span.
  const anchors: number[] = [];
  for (const w of words) anchors.push(Math.max(anchors[anchors.length - 1] ?? 0, w.t ?? (w.s + w.e) / 2));
  const sorted = [...pauses].sort((a, b) => a.start - b.start);
  const out = strip(words);
  for (let i = 0; i < out.length; i++) {
    const a = anchors[i]!;
    if (i === 0) {
      const before = sorted.filter((p) => p.end <= a).pop();
      out[0]!.s = before ? before.end : Math.max(0, Math.min(out[0]!.s, a - 0.1));
    }
    const next = anchors[i + 1];
    if (next === undefined) {
      const after = sorted.find((p) => p.start >= a);
      out[i]!.e = after ? after.start : Math.min(durationSeconds, a + TAIL);
      continue;
    }
    let best: Segment | null = null;
    for (const p of sorted) {
      const start = Math.max(p.start, a);
      const end = Math.min(p.end, next);
      if (end - start >= MIN_PAUSE && (!best || end - start > best.end - best.start)) best = { start, end };
    }
    const boundary = best ?? { start: (a + next) / 2, end: (a + next) / 2 };
    out[i]!.e = boundary.start;
    out[i + 1]!.s = boundary.end;
  }
  for (const w of out) if (w.e <= w.s) w.e = w.s + 0.02;
  return out;
}
