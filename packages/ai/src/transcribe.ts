/** Speech-to-text with word timestamps via whisper.cpp (`whisper-cli`). Results are cached per asset hash. */
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import type { Transcript, TranscriptWord } from '@neon/core';
import { runOrThrow } from './exec.ts';
import { transcriptsDir } from './tools.ts';

interface WhisperToken {
  text: string;
  offsets: { from: number; to: number };
  p?: number;
}
interface WhisperJson {
  transcription?: { text: string; offsets: { from: number; to: number }; tokens?: WhisperToken[] }[];
  result?: { language?: string };
}

/**
 * whisper.cpp sometimes emits identical timestamps for every word near the end of a padded
 * 30 s window. Detect runs of non-increasing starts and spread them evenly up to the next
 * anchor (or the real audio duration).
 */
export function repairTimestamps(words: TranscriptWord[], audioDurationSeconds?: number): TranscriptWord[] {
  // Anchors are words with a real duration and a strictly increasing start; everything between
  // two anchors is spread evenly across the gap.
  const anchors: number[] = [];
  let lastS = -1;
  for (let i = 0; i < words.length; i++) {
    const w = words[i]!;
    if (w.e - w.s >= 0.015 && w.s > lastS + 1e-3) {
      anchors.push(i);
      lastS = w.s;
    }
  }
  const spread = (from: number, to: number, t0: number, t1: number) => {
    const n = to - from + 1;
    if (n <= 0) return;
    const span = Math.max(t1 - t0, 0.05 * n);
    for (let k = 0; k < n; k++) {
      const a = t0 + (k / n) * span;
      const b = t0 + ((k + 1) / n) * span;
      words[from + k]!.s = a;
      words[from + k]!.e = Math.max(a + 0.02, b);
    }
  };
  if (anchors.length === 0) {
    if (words.length) spread(0, words.length - 1, words[0]?.s ?? 0, audioDurationSeconds ?? words.length * 0.3);
  } else {
    for (let a = 0; a <= anchors.length; a++) {
      const prevAnchor = anchors[a - 1];
      const nextAnchor = anchors[a];
      const from = prevAnchor === undefined ? 0 : prevAnchor + 1;
      const to = (nextAnchor ?? words.length) - 1;
      if (to < from) continue;
      const t0 = prevAnchor === undefined ? Math.max(0, (words[nextAnchor!]?.s ?? 0) - 0.3 * (to - from + 1)) : words[prevAnchor]!.e;
      const t1 = nextAnchor === undefined ? Math.max(t0, audioDurationSeconds ?? t0 + 0.3 * (to - from + 1)) : words[nextAnchor]!.s;
      spread(from, to, t0, t1);
    }
  }
  if (audioDurationSeconds) {
    for (const w of words) {
      w.s = Math.min(w.s, audioDurationSeconds);
      w.e = Math.min(Math.max(w.e, w.s + 0.01), audioDurationSeconds + 0.5);
    }
  }
  return words;
}

/** Merge whisper sub-word tokens into words with start/end seconds. */
export function wordsFromWhisperJson(json: WhisperJson, audioDurationSeconds?: number): TranscriptWord[] {
  const words: TranscriptWord[] = [];
  for (const seg of json.transcription ?? []) {
    const usable = (seg.tokens ?? []).filter((t) => !t.text.startsWith('[_') && !/^<\|.*\|>$/.test(t.text.trim()) && t.text.trim() !== '');
    const degenerate = usable.length > 1 && usable.every((t) => t.offsets.from === usable[0]!.offsets.from);
    if (!seg.tokens || seg.tokens.length === 0 || degenerate) {
      // No token detail: fall back to distributing the segment text evenly.
      const parts = seg.text.trim().split(/\s+/).filter(Boolean);
      const span = (seg.offsets.to - seg.offsets.from) / 1000 / Math.max(1, parts.length);
      parts.forEach((w, i) => words.push({ w, s: seg.offsets.from / 1000 + i * span, e: seg.offsets.from / 1000 + (i + 1) * span }));
      continue;
    }
    let current: TranscriptWord | null = null;
    const segStartIndex = words.length;
    for (const tok of seg.tokens) {
      if (tok.text.startsWith('[_') || /^<\|.*\|>$/.test(tok.text.trim()) || tok.text.trim() === '') continue;
      const startsWord = tok.text.startsWith(' ') || current === null;
      const text = tok.text.trim();
      if (startsWord && /^[\p{L}\p{N}']/u.test(text)) {
        if (current) words.push(current);
        current = { w: text, s: tok.offsets.from / 1000, e: tok.offsets.to / 1000, p: tok.p };
      } else if (current) {
        current.w += text;
        current.e = Math.max(current.e, tok.offsets.to / 1000);
        if (tok.p !== undefined) current.p = Math.min(current.p ?? 1, tok.p);
      } else {
        current = { w: text, s: tok.offsets.from / 1000, e: tok.offsets.to / 1000, p: tok.p };
      }
    }
    if (current) words.push(current);
    // Token clocks collapse in padded windows; the segment offsets stay trustworthy. If this
    // segment's words cover less than half its span, redistribute them evenly across it.
    const segWords = words.slice(segStartIndex);
    const segFrom = seg.offsets.from / 1000;
    const segTo = seg.offsets.to / 1000;
    if (segWords.length > 1 && segTo - segFrom > 0.5) {
      const covered = segWords[segWords.length - 1]!.e - segWords[0]!.s;
      if (covered < 0.5 * (segTo - segFrom)) {
        const weights = segWords.map((w) => Math.max(2, w.w.replace(/[^\p{L}\p{N}]/gu, '').length + 1));
        const total = weights.reduce((a, b) => a + b, 0);
        let t = segFrom;
        for (let k = 0; k < segWords.length; k++) {
          const dur = ((segTo - segFrom) * weights[k]!) / total;
          segWords[k]!.s = t;
          segWords[k]!.e = t + dur * 0.85;
          t += dur;
        }
      }
    }
  }
  // Guard against zero-length words (whisper sometimes gives identical from/to).
  for (let i = 0; i < words.length; i++) {
    const w = words[i]!;
    if (w.e <= w.s) w.e = Math.min(words[i + 1]?.s ?? w.s + 0.2, w.s + 0.2);
  }
  return repairTimestamps(words, audioDurationSeconds);
}

export interface TranscribeOptions {
  ffmpeg: string;
  whisper: string;
  model: string;
  language?: string;
  assetId: string;
  force?: boolean;
  onLog?: (line: string) => void;
}

export async function transcribe(file: string, opts: TranscribeOptions): Promise<Transcript> {
  await mkdir(transcriptsDir(), { recursive: true });
  const engine = `whisper.cpp:${basename(opts.model)}`;
  const cacheKey = createHash('sha1').update(`${opts.assetId}:${engine}:${opts.language ?? 'auto'}`).digest('hex').slice(0, 16);
  const cachePath = join(transcriptsDir(), `${opts.assetId.slice(0, 16)}-${cacheKey}.json`);
  if (!opts.force) {
    try {
      const cached = JSON.parse(await readFile(cachePath, 'utf8')) as Transcript;
      if (Array.isArray(cached.words)) return cached;
    } catch {
      /* miss */
    }
  }
  const dir = await mkdtemp(join(tmpdir(), 'neon-whisper-'));
  try {
    const wav = join(dir, 'audio.wav');
    await runOrThrow(opts.ffmpeg, ['-v', 'error', '-y', '-i', file, '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', wav]);
    const outBase = join(dir, 'out');
    const args = ['-m', opts.model, '-f', wav, '-ojf', '-of', outBase, '-np'];
    if (opts.language) args.push('-l', opts.language);
    // The prebuilt Linux whisper-cli ships its .so files next to the binary without an rpath.
    const env = process.platform === 'linux' ? { LD_LIBRARY_PATH: dirname(opts.whisper) } : undefined;
    await runOrThrow(opts.whisper, args, { onStderr: opts.onLog, onStdout: opts.onLog, env });
    const json = JSON.parse(await readFile(`${outBase}.json`, 'utf8')) as WhisperJson;
    const { stat } = await import('node:fs/promises');
    const wavBytes = (await stat(wav)).size;
    const audioDurationSeconds = Math.max(0, (wavBytes - 44) / 32000); // 16-bit mono 16 kHz
    const transcript: Transcript = {
      assetId: opts.assetId,
      engine,
      language: json.result?.language ?? opts.language ?? 'en',
      createdAt: new Date().toISOString(),
      words: wordsFromWhisperJson(json, audioDurationSeconds),
    };
    await writeFile(cachePath, JSON.stringify(transcript));
    return transcript;
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

export function transcriptText(words: TranscriptWord[]): string {
  return words.map((w) => w.w).join(' ');
}
