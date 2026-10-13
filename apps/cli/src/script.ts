/**
 * `neon-cli script …` and `neon-cli notes …`: read the script as an outline, and name its parts
 * the way a person reads them. Section 4 is "4", its second line "4.2", a note "#3" (its number in
 * `notes`), a moment on the timeline "@02:56".
 */
import { framesToTimecode, lineTimings, linesSeconds, parseTimecode, type Script, type ScriptLine, type ScriptNote, type ScriptNoteTarget, type ScriptSection } from '@neon/core';
import { ApiError } from './client.ts';

const STATUS_LABEL: Record<ScriptSection['status'], string> = { draft: 'draft', review: 'your turn', approved: 'approved' };

/** 02:51 for a moment on the timeline: no frames, no hours unless it runs that long. */
function moment(frame: number, fps: number): string {
  return framesToTimecode(frame, fps).replace(/:\d\d$/, '').replace(/^00:/, '');
}

function clock(seconds: number): string {
  const s = Math.round(seconds);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export function findSection(script: Script, ref: string): { section: ScriptSection; number: number } {
  if (/^\d+$/.test(ref)) {
    const section = script.sections[Number(ref) - 1];
    if (!section) throw new ApiError('NOT_FOUND', `No section ${ref}: the script has ${script.sections.length}`);
    return { section, number: Number(ref) };
  }
  const matches = script.sections.filter((s) => s.id === ref || s.id.startsWith(ref));
  if (matches.length !== 1) throw new ApiError('NOT_FOUND', matches.length ? `"${ref}" matches ${matches.length} sections` : `No section "${ref}" (use its number from script show)`);
  return { section: matches[0]!, number: script.sections.indexOf(matches[0]!) + 1 };
}

export function findLine(script: Script, ref: string): { line: ScriptLine; section: ScriptSection; number: string } {
  const dotted = /^(\d+)\.(\d+)$/.exec(ref);
  if (dotted) {
    const { section } = findSection(script, dotted[1]!);
    const line = section.lines[Number(dotted[2]) - 1];
    if (!line) throw new ApiError('NOT_FOUND', `No line ${ref}: section ${dotted[1]} has ${section.lines.length}`);
    return { line, section, number: ref };
  }
  for (const [i, section] of script.sections.entries()) {
    const j = section.lines.findIndex((l) => l.id === ref);
    if (j !== -1) return { line: section.lines[j]!, section, number: `${i + 1}.${j + 1}` };
  }
  const matches = script.sections.flatMap((s, i) => s.lines.flatMap((l, j) => (l.id.startsWith(ref) ? [{ line: l, section: s, number: `${i + 1}.${j + 1}` }] : [])));
  if (matches.length !== 1) throw new ApiError('NOT_FOUND', matches.length ? `"${ref}" matches ${matches.length} lines` : `No line "${ref}" (use its number from script show, like 4.2)`);
  return matches[0]!;
}

export function findNote(script: Script, ref: string): { note: ScriptNote; number: number } {
  const n = /^#?(\d+)$/.exec(ref);
  if (n) {
    const note = script.notes[Number(n[1]) - 1];
    if (!note) throw new ApiError('NOT_FOUND', `No note #${n[1]}: there are ${script.notes.length}`);
    return { note, number: Number(n[1]) };
  }
  const matches = script.notes.filter((x) => x.id === ref || x.id.startsWith(ref));
  if (matches.length !== 1) throw new ApiError('NOT_FOUND', matches.length ? `"${ref}" matches ${matches.length} notes` : `No note "${ref}" (use its number from notes, like #3)`);
  return { note: matches[0]!, number: script.notes.indexOf(matches[0]!) + 1 };
}

/** What a note is pinned to, from "4.2" (a line), "4" (a section) or "@02:56" (a moment on the timeline). */
export function noteTarget(script: Script, ref: string, fps: number): ScriptNoteTarget {
  if (ref.startsWith('@')) return { kind: 'frame', frame: parseTimecode(ref.slice(1), fps) };
  if (/^\d+$/.test(ref)) return { kind: 'section', sectionId: findSection(script, ref).section.id };
  return { kind: 'line', lineId: findLine(script, ref).line.id };
}

/** "line 4.2", "section 4 · The graph", "at 02:56", or "a deleted line" when the target is gone. */
export function targetLabel(script: Script, on: ScriptNoteTarget, fps: number): string {
  switch (on.kind) {
    case 'frame':
      return `at ${moment(on.frame, fps)}`;
    case 'section': {
      const i = script.sections.findIndex((s) => s.id === on.sectionId);
      return i === -1 ? 'a deleted section' : `section ${i + 1} · ${script.sections[i]!.title}`;
    }
    case 'line':
      try {
        return `line ${findLine(script, on.lineId).number}`;
      } catch {
        return 'a deleted line';
      }
    default: {
      const exhaustive: never = on;
      return String(exhaustive);
    }
  }
}

function openNotesOn(script: Script, matches: (on: ScriptNoteTarget) => boolean): number {
  return script.notes.filter((n) => !n.resolved && matches(n.on)).length;
}

/** The whole script as an outline: sections with status and running time, numbered lines, their shots and open notes. */
export function formatScript(name: string, script: Script, fps: number): string {
  if (script.sections.length === 0) return 'No script yet. Write one with neon-cli script set script.json';
  const timings = lineTimings(script, fps);
  const lines = script.sections.flatMap((s) => s.lines);
  const open = script.notes.filter((n) => !n.resolved).length;
  const out = [`${name} · ${script.sections.length} section${script.sections.length === 1 ? '' : 's'} · ${lines.length} lines · ~${clock(linesSeconds(lines, fps))} · ${open} open note${open === 1 ? '' : 's'}`];
  script.sections.forEach((section, i) => {
    const sectionNotes = openNotesOn(script, (on) => on.kind === 'section' && on.sectionId === section.id);
    out.push('', `${i + 1}. ${section.title}  [${STATUS_LABEL[section.status]}]  ~${clock(linesSeconds(section.lines, fps))}${sectionNotes ? `  (${sectionNotes} open note${sectionNotes === 1 ? '' : 's'})` : ''}`);
    if (section.intent) out.push(`   ${section.intent}`);
    section.lines.forEach((line, j) => {
      const t = timings.get(line.id)!;
      const at = `${t.estimated ? '~' : ' '}${moment(t.startFrame, fps)}`;
      const notes = openNotesOn(script, (on) => on.kind === 'line' && on.lineId === line.id);
      out.push(`   ${`${i + 1}.${j + 1}`.padEnd(6)}${at}  ${line.say}${notes ? `  (${notes} open note${notes === 1 ? '' : 's'})` : ''}`);
      if (line.show || line.stillAssetId) out.push(`${' '.repeat(16)}show: ${line.show || '—'}${line.stillAssetId ? ' · has a still' : ''}`);
    });
  });
  return out.join('\n');
}

/** Notes with their replies, open ones only unless `all`. */
export function formatNotes(script: Script, fps: number, all: boolean): string {
  const shown = script.notes.map((note, i) => ({ note, number: i + 1 })).filter(({ note }) => all || !note.resolved);
  if (shown.length === 0) return all ? 'No notes yet.' : 'No open notes. (notes --all shows resolved ones)';
  return shown
    .map(({ note, number }) => {
      const head = `#${number}  ${note.resolved ? 'resolved' : 'open'}  on ${targetLabel(script, note.on, fps)}`;
      const quoted = note.on.kind === 'line' ? quoteLine(script, note.on.lineId) : '';
      return [head + quoted, `    ${note.author}: ${note.text}`, ...note.replies.map((r) => `      ↳ ${r.author}: ${r.text}`)].join('\n');
    })
    .join('\n\n');
}

function quoteLine(script: Script, lineId: string): string {
  const line = script.sections.flatMap((s) => s.lines).find((l) => l.id === lineId);
  if (!line) return '';
  return ` · "${line.say.length > 60 ? `${line.say.slice(0, 57)}…` : line.say}"`;
}
