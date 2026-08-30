import type { TranscriptWord } from '@neon/core';
import type { Segment } from './pcm.ts';

/** Default disfluencies. "like" is only treated as a filler when Whisper punctuated it as an aside ("…, like, …"). */
export const DEFAULT_FILLERS = ['um', 'umm', 'uh', 'uhm', 'uhh', 'er', 'erm', 'ah', 'ahh', 'hmm', 'mm', 'mhm', 'you know', 'i mean', 'like'];

function norm(w: string): string {
  return w.toLowerCase().replace(/[^\p{L}\p{N}']/gu, '');
}

function isAside(words: TranscriptWord[], i: number): boolean {
  // "like" surrounded by commas/pauses: ", like," or sentence-start "Like," etc.
  const w = words[i]!.w;
  const prev = words[i - 1]?.w ?? '';
  const endsWithComma = /[,;:]$/.test(w);
  const prevEndsWithPunct = /[,.;:!?]$/.test(prev) || i === 0;
  return endsWithComma && prevEndsWithPunct;
}

/** Flag filler words/phrases in place and return the indices that were flagged. */
export function markFillers(words: TranscriptWord[], fillers: string[] = DEFAULT_FILLERS): number[] {
  const flagged: number[] = [];
  const phrases = fillers.filter((f) => f.includes(' ')).map((f) => f.split(' ').map(norm));
  const singles = new Set(fillers.filter((f) => !f.includes(' ')).map(norm));
  for (let i = 0; i < words.length; i++) {
    words[i]!.filler = false;
  }
  for (let i = 0; i < words.length; i++) {
    const n = norm(words[i]!.w);
    let hit = false;
    for (const phrase of phrases) {
      if (phrase.every((p, k) => norm(words[i + k]?.w ?? '') === p)) {
        for (let k = 0; k < phrase.length; k++) {
          words[i + k]!.filler = true;
          flagged.push(i + k);
        }
        i += phrase.length - 1;
        hit = true;
        break;
      }
    }
    if (hit) continue;
    if (singles.has(n)) {
      if (n === 'like' && !isAside(words, i)) continue;
      words[i]!.filler = true;
      flagged.push(i);
    }
  }
  return flagged;
}

/** Second ranges to remove, padded and merged when neighbouring. */
export function fillerRanges(words: TranscriptWord[], padMs = 40): Segment[] {
  const pad = padMs / 1000;
  const ranges: Segment[] = [];
  for (let i = 0; i < words.length; i++) {
    const w = words[i]!;
    if (!w.filler) continue;
    const prevEnd = words[i - 1]?.e ?? 0;
    const nextStart = words[i + 1]?.s ?? Number.POSITIVE_INFINITY;
    // Never eat into neighbouring words; take up to `pad` of the surrounding gaps.
    const start = Math.max(prevEnd, w.s - pad);
    const end = Math.min(nextStart, w.e + pad);
    if (end > start) ranges.push({ start, end });
  }
  const merged: Segment[] = [];
  for (const r of ranges.sort((a, b) => a.start - b.start)) {
    const last = merged[merged.length - 1];
    if (last && r.start <= last.end + 0.05) last.end = Math.max(last.end, r.end);
    else merged.push({ ...r });
  }
  return merged;
}
