/**
 * B-roll suggestions: find concepts in the transcript and match them to the project's media library.
 * Offline heuristic (keyword overlap) always works; Claude (optional) picks semantically better matches.
 */
import Anthropic from '@anthropic-ai/sdk';
import type { Asset, TranscriptWord } from '@neon/core';

const STOPWORDS = new Set(
  'a an the and or but so if then than that this these those there here is are was were be been being am do does did doing have has had having i me my we our you your he she it its they them their what which who whom when where why how all any both each few more most other some such no nor not only own same too very can will just should now would could also about above after again against because before below between during from into of off on once out over under until up with without like um uh yeah okay ok well really actually basically literally kind sort thing things something anything everything going gonna get got make made know think want need say said says see seen look looking way ways lot lots much many one two three first second new old good bad big small'.split(' '),
);

export interface Concept {
  index: number;
  startS: number;
  endS: number;
  text: string;
  keywords: string[];
}

export interface BrollSuggestion {
  conceptIndex: number;
  startS: number;
  endS: number;
  keyword: string;
  assetId: string;
  assetName: string;
  score: number;
  reason: string;
  source: 'heuristic' | 'claude';
}

/** Split words into sentences (by punctuation) and pull out candidate keywords. */
export function extractConcepts(words: TranscriptWord[]): Concept[] {
  const sentences: TranscriptWord[][] = [];
  let current: TranscriptWord[] = [];
  for (const w of words) {
    if (w.filler) continue;
    current.push(w);
    if (/[.!?]$/.test(w.w) || current.length >= 25) {
      sentences.push(current);
      current = [];
    }
  }
  if (current.length) sentences.push(current);
  return sentences.map((s, index) => {
    const tokens = s.map((w) => w.w.toLowerCase().replace(/[^\p{L}\p{N}-]/gu, '')).filter((t) => t.length >= 4 && !STOPWORDS.has(t));
    const freq = new Map<string, number>();
    for (const t of tokens) freq.set(t, (freq.get(t) ?? 0) + 1);
    const keywords = [...freq.entries()]
      .sort((a, b) => b[1] - a[1] || b[0].length - a[0].length)
      .map(([t]) => t)
      .slice(0, 6);
    return { index, startS: s[0]!.s, endS: s[s.length - 1]!.e, text: s.map((w) => w.w).join(' '), keywords };
  });
}

function assetTokens(asset: Asset): string[] {
  return asset.name
    .replace(/\.[a-z0-9]+$/i, '')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length >= 3);
}

function stem(t: string): string {
  return t.replace(/(ing|ers|er|ed|es|s)$/u, '');
}

/** Keyword-overlap matcher; scores 0..1. */
export function matchAssetsHeuristic(concepts: Concept[], assets: Asset[], opts: { excludeAssetIds?: Set<string> } = {}): BrollSuggestion[] {
  const out: BrollSuggestion[] = [];
  const library = assets.filter((a) => (a.kind === 'video' || a.kind === 'image') && !opts.excludeAssetIds?.has(a.id)).map((a) => ({ asset: a, tokens: assetTokens(a).map(stem) }));
  for (const c of concepts) {
    let best: BrollSuggestion | null = null;
    for (const kw of c.keywords) {
      const sk = stem(kw);
      for (const { asset, tokens } of library) {
        const exact = tokens.includes(sk);
        const partial = !exact && tokens.some((t) => t.length >= 4 && (t.includes(sk) || sk.includes(t)));
        if (!exact && !partial) continue;
        const score = exact ? 0.9 : 0.6;
        if (!best || score > best.score) {
          best = { conceptIndex: c.index, startS: c.startS, endS: c.endS, keyword: kw, assetId: asset.id, assetName: asset.name, score, reason: `"${kw}" matches file name`, source: 'heuristic' };
        }
      }
    }
    if (best) out.push(best);
  }
  return out;
}

/**
 * Ask Claude to map transcript sentences to library assets. Only used when credentials exist;
 * any failure falls back to the heuristic result silently (reported in the job log).
 */
export async function matchAssetsWithClaude(
  concepts: Concept[],
  assets: Asset[],
  opts: { model?: string; excludeAssetIds?: Set<string>; onLog?: (line: string) => void } = {},
): Promise<BrollSuggestion[]> {
  const library = assets.filter((a) => (a.kind === 'video' || a.kind === 'image') && !opts.excludeAssetIds?.has(a.id));
  if (library.length === 0 || concepts.length === 0) return [];
  const client = new Anthropic();
  const prompt = [
    'You place B-roll in a talking-head video. Below is the voice-over transcript split into numbered sentences, and the media library (file names).',
    'For each sentence where a library item would visually support what is said, output one match. Skip sentences with no good match. Prefer precision over coverage.',
    'Respond with ONLY a JSON array: [{"sentence": <number>, "asset": "<exact file name>", "reason": "<short>"}]',
    '',
    'SENTENCES:',
    ...concepts.map((c) => `${c.index}: ${c.text}`),
    '',
    'LIBRARY:',
    ...library.map((a) => `- ${a.name} (${a.kind})`),
  ].join('\n');
  const response = await client.messages.create({
    model: opts.model ?? 'claude-opus-5',
    max_tokens: 4000,
    messages: [{ role: 'user', content: prompt }],
  });
  if (response.stop_reason === 'refusal') {
    opts.onLog?.('Claude declined the request; using heuristic matches');
    return [];
  }
  const text = response.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  const jsonStart = text.indexOf('[');
  const jsonEnd = text.lastIndexOf(']');
  if (jsonStart < 0 || jsonEnd < 0) return [];
  const parsed = JSON.parse(text.slice(jsonStart, jsonEnd + 1)) as { sentence: number; asset: string; reason?: string }[];
  const out: BrollSuggestion[] = [];
  for (const m of parsed) {
    const c = concepts[m.sentence];
    const asset = library.find((a) => a.name === m.asset) ?? library.find((a) => a.name.toLowerCase() === String(m.asset).toLowerCase());
    if (!c || !asset) continue;
    out.push({ conceptIndex: c.index, startS: c.startS, endS: c.endS, keyword: c.keywords[0] ?? '', assetId: asset.id, assetName: asset.name, score: 0.95, reason: m.reason ?? 'Claude match', source: 'claude' });
  }
  return out;
}
