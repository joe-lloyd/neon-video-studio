import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import {
  framesToTimecode,
  lineTimings,
  linesSeconds,
  type LineTiming,
  type Script,
  type ScriptLine,
  type ScriptNote,
  type ScriptNoteTarget,
  type ScriptSection,
  type ScriptStatus,
} from '@neon/core';
import { useEditor } from '../lib/context.ts';
import { useSelector, useStoreValue } from '../lib/store.ts';

const STATUS: { value: ScriptStatus; label: string; title: string }[] = [
  { value: 'draft', label: 'draft', title: 'Being written' },
  { value: 'review', label: 'your turn', title: 'Waiting on the person to read it' },
  { value: 'approved', label: 'approved', title: 'Signed off' },
];

/** 02:51 for a moment on the timeline: no frames, no hours unless it runs that long. */
function moment(frame: number, fps: number): string {
  return framesToTimecode(frame, fps).replace(/:\d\d$/, '').replace(/^00:/, '');
}

function clock(seconds: number): string {
  const s = Math.round(seconds);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** Put the cursor in a line's words once React has drawn it. */
function focusLine(id: string) {
  requestAnimationFrame(() => document.querySelector<HTMLTextAreaElement>(`[data-script-id="${id}"] .say textarea`)?.focus());
}

const isOn = (note: ScriptNote, on: ScriptNoteTarget['kind'], id: string) =>
  (on === 'line' && note.on.kind === 'line' && note.on.lineId === id) || (on === 'section' && note.on.kind === 'section' && note.on.sectionId === id);

/**
 * The script as a full-width page: what is said on the left, what is on screen on the right,
 * review notes in a margin. Sections carry a status so both sides know whose turn it is. The agent
 * edits the same document through `neon-cli script` and `neon-cli notes`.
 */
export function ScriptWorkspace() {
  const editor = useEditor();
  const { project } = useStoreValue(editor.project);
  const { script, meta } = project;
  const fps = meta.fps;
  const timings = useMemo(() => lineTimings(script, fps), [script, fps]);
  const [focus, setFocus] = useState<string | null>(null);
  const docRef = useRef<HTMLDivElement>(null);
  const allLines = script.sections.flatMap((s) => s.lines);
  const open = script.notes.filter((n) => !n.resolved).length;
  const waiting = script.sections.filter((s) => s.status === 'review').length;

  const reveal = (id: string) => {
    setFocus(id);
    docRef.current?.querySelector(`[data-script-id="${id}"]`)?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  };

  return (
    <div className="script-ws">
      <div className="script-ws-bar">
        <span>
          {script.sections.length} section{script.sections.length === 1 ? '' : 's'} · {allLines.length} lines · ~{clock(linesSeconds(allLines, fps))}
        </span>
        <span className="spacer" />
        {waiting ? <span className="status-pill review">{waiting} waiting on you</span> : null}
        <span className="muted">
          {open} open note{open === 1 ? '' : 's'}
        </span>
        <button className="btn sm" onClick={() => editor.doc.addSection({ title: 'New section' })}>
          + Section
        </button>
      </div>
      <div className="script-ws-body">
        <div className="script-doc" ref={docRef}>
          {script.sections.length === 0 ? <EmptyScript /> : null}
          {script.sections.map((section, i) => (
            <SectionBlock key={section.id} section={section} number={i + 1} script={script} timings={timings} fps={fps} focus={focus} setFocus={setFocus} />
          ))}
        </div>
        <NotesMargin script={script} timings={timings} fps={fps} reveal={reveal} />
      </div>
    </div>
  );
}

function EmptyScript() {
  const editor = useEditor();
  return (
    <div className="empty" style={{ marginTop: 40 }}>
      <strong>No script yet.</strong>
      <br />
      Ask the agent for an outline (it writes here with <span className="mono">neon-cli script set</span>), or{' '}
      <button className="link" onClick={() => editor.doc.addSection({ title: 'Cold open' })}>
        start a section
      </button>
      .
    </div>
  );
}

function SectionBlock(props: { section: ScriptSection; number: number; script: Script; timings: Map<string, LineTiming>; fps: number; focus: string | null; setFocus: (id: string | null) => void }) {
  const { section, number, script, timings, fps, focus, setFocus } = props;
  const editor = useEditor();
  const notes = script.notes.filter((n) => !n.resolved && isOn(n, 'section', section.id)).length;
  return (
    <section className={`script-section ${focus === section.id ? 'focus' : ''}`} data-script-id={section.id}>
      <div className="script-section-head">
        <span className="num">{number}.</span>
        <EditableText className="title" value={section.title} placeholder="Section title" onCommit={(title) => editor.doc.updateSection(section.id, { title })} />
        <span className="est mono">~{clock(linesSeconds(section.lines, fps))}</span>
        <div className="status-switch">
          {STATUS.map((s) => (
            <button key={s.value} className={section.status === s.value ? `on ${s.value}` : ''} title={s.title} onClick={() => editor.doc.updateSection(section.id, { status: s.value })}>
              {s.label}
            </button>
          ))}
        </div>
        <button className="icon-btn" title="Note on this section" onClick={() => editor.ui.set({ noteDraft: { kind: 'section', sectionId: section.id } })}>
          note{notes ? ` · ${notes}` : ''}
        </button>
        <button className="icon-btn danger" title="Delete the section and its lines (undo brings it back)" onClick={() => editor.doc.removeSection(section.id)}>
          ×
        </button>
      </div>
      <EditableText className="intent" value={section.intent} placeholder="What this section has to get across" onCommit={(intent) => editor.doc.updateSection(section.id, { intent })} />
      {section.lines.map((line, j) => (
        <LineRow key={line.id} line={line} number={`${number}.${j + 1}`} section={section} script={script} timing={timings.get(line.id)!} fps={fps} focused={focus === line.id} setFocus={setFocus} />
      ))}
      <button className="add-line" onClick={() => focusLine(editor.doc.addLine({ sectionId: section.id, say: '' }).id)}>
        + line
      </button>
    </section>
  );
}

function LineRow(props: { line: ScriptLine; number: string; section: ScriptSection; script: Script; timing: LineTiming; fps: number; focused: boolean; setFocus: (id: string | null) => void }) {
  const { line, number, section, script, timing, fps, focused, setFocus } = props;
  const editor = useEditor();
  const notes = script.notes.filter((n) => !n.resolved && isOn(n, 'line', line.id)).length;
  const index = section.lines.indexOf(line);
  const sectionIndex = script.sections.indexOf(section);

  // Up and down cross into the neighbouring section at its edge.
  const move = (by: -1 | 1) => {
    const neighbour = section.lines[index + by];
    if (neighbour) {
      editor.doc.moveLine(line.id, { sectionId: section.id, after: by === 1 ? neighbour.id : (section.lines[index - 2]?.id ?? null) });
      return;
    }
    const other = script.sections[sectionIndex + by];
    if (other) editor.doc.moveLine(line.id, { sectionId: other.id, after: by === 1 ? null : (other.lines.at(-1)?.id ?? null) });
  };
  const jump = () => {
    if (timing.estimated) return;
    editor.seek(timing.startFrame);
    editor.ui.set({ view: 'edit' });
  };
  const onSayKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      e.currentTarget.blur();
      focusLine(editor.doc.addLine({ sectionId: section.id, say: '', after: line.id }).id);
    } else if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
      e.preventDefault();
      move(e.key === 'ArrowUp' ? -1 : 1);
    }
  };

  return (
    <div className={`script-line${focused ? ' focus' : ''}`} data-script-id={line.id} onFocus={() => setFocus(line.id)}>
      <div className="tc mono">
        <span className="n">
          {number}
          {notes ? <span className="note-dot" title={`${notes} open note${notes === 1 ? '' : 's'}`} /> : null}
        </span>
        <button className={timing.estimated ? 'est' : 'placed'} onClick={jump} title={timing.estimated ? 'Estimated: not recorded yet' : 'Jump to it on the timeline'}>
          {timing.estimated ? '~' : ''}
          {moment(timing.startFrame, fps)}
        </button>
      </div>
      <div className="say">
        <EditableText value={line.say} placeholder="What you say" onCommit={(say) => editor.doc.updateLine(line.id, { say })} onKeyDown={onSayKey} />
      </div>
      <div className="show">
        {line.stillAssetId ? <img className="still" src={editor.assetUrl(line.stillAssetId)} alt="" draggable={false} /> : null}
        <EditableText value={line.show} placeholder="What's on screen" onCommit={(show) => editor.doc.updateLine(line.id, { show })} />
      </div>
      <div className="line-actions">
        <button className="icon-btn" title="Note on this line" onClick={() => editor.ui.set({ noteDraft: { kind: 'line', lineId: line.id } })}>
          note
        </button>
        <button className="icon-btn" title="Move up (Alt+↑)" onClick={() => move(-1)}>
          ↑
        </button>
        <button className="icon-btn" title="Move down (Alt+↓)" onClick={() => move(1)}>
          ↓
        </button>
        <button className="icon-btn danger" title="Delete the line (undo brings it back)" onClick={() => editor.doc.removeLine(line.id)}>
          ×
        </button>
      </div>
    </div>
  );
}

/**
 * Text that edits in place. Shows the document's value until focused, keeps a local draft while
 * typing (so an agent's edit elsewhere doesn't fight the cursor), and saves on blur.
 */
function EditableText(props: { value: string; placeholder: string; onCommit: (value: string) => void; className?: string; onKeyDown?: (e: KeyboardEvent<HTMLTextAreaElement>) => void }) {
  const { value, placeholder, onCommit, className, onKeyDown } = props;
  const [draft, setDraft] = useState<string | null>(null);
  const ref = useRef<HTMLTextAreaElement>(null);
  const shown = draft ?? value;
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = '0px';
    el.style.height = `${el.scrollHeight}px`;
  }, [shown]);
  return (
    <textarea
      ref={ref}
      className={`editable ${className ?? ''}`}
      rows={1}
      value={shown}
      placeholder={placeholder}
      spellCheck
      onFocus={() => setDraft(value)}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => {
        if (draft !== null && draft.trim() !== value) onCommit(draft.trim());
        setDraft(null);
      }}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Escape') {
          const el = e.currentTarget;
          setDraft(value);
          requestAnimationFrame(() => el.blur());
          return;
        }
        if (onKeyDown) onKeyDown(e);
        else if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          e.currentTarget.blur();
        }
      }}
    />
  );
}

/** Where a note sits in the script, so the margin reads top to bottom with the page. */
function notePosition(script: Script, timings: Map<string, LineTiming>, on: ScriptNoteTarget): number {
  const lines = script.sections.flatMap((s) => s.lines);
  switch (on.kind) {
    case 'section': {
      const first = script.sections.find((s) => s.id === on.sectionId)?.lines[0];
      return first ? lines.indexOf(first) - 0.5 : Number.MAX_SAFE_INTEGER;
    }
    case 'line': {
      const i = lines.findIndex((l) => l.id === on.lineId);
      return i === -1 ? Number.MAX_SAFE_INTEGER : i;
    }
    case 'frame': {
      const i = lines.findIndex((l) => {
        const t = timings.get(l.id)!;
        return !t.estimated && on.frame >= t.startFrame && on.frame < t.startFrame + t.durationFrames;
      });
      return i === -1 ? Number.MAX_SAFE_INTEGER - 1 : i + 0.25;
    }
    default: {
      const exhaustive: never = on;
      return exhaustive;
    }
  }
}

function NotesMargin({ script, timings, fps, reveal }: { script: Script; timings: Map<string, LineTiming>; fps: number; reveal: (id: string) => void }) {
  const editor = useEditor();
  const draft = useSelector(editor.ui, (u) => u.noteDraft);
  const [all, setAll] = useState(false);
  const numbered = script.notes.map((note, i) => ({ note, number: i + 1 }));
  const shown = numbered.filter(({ note }) => all || !note.resolved).sort((a, b) => notePosition(script, timings, a.note.on) - notePosition(script, timings, b.note.on));
  const open = script.notes.filter((n) => !n.resolved).length;
  return (
    <aside className="script-notes">
      <div className="script-mode">
        <button className={all ? '' : 'on'} onClick={() => setAll(false)}>
          Open · {open}
        </button>
        <button className={all ? 'on' : ''} onClick={() => setAll(true)}>
          All · {script.notes.length}
        </button>
      </div>
      {draft ? <NoteComposer target={draft} label={targetLabel(script, draft, fps)} /> : null}
      {shown.length === 0 && !draft ? (
        <p className="hint" style={{ padding: '10px 4px' }}>
          {all ? 'No notes yet.' : 'No open notes.'} Hover a line and press <b>note</b> to pin one where the problem is. The agent reads them with <span className="mono">neon-cli notes</span> and replies here.
        </p>
      ) : null}
      {shown.map(({ note, number }) => (
        <NoteThread key={note.id} note={note} number={number} label={targetLabel(script, note.on, fps)} onOpenTarget={() => openTarget(note.on)} />
      ))}
    </aside>
  );

  function openTarget(on: ScriptNoteTarget) {
    switch (on.kind) {
      case 'line':
        reveal(on.lineId);
        return;
      case 'section':
        reveal(on.sectionId);
        return;
      case 'frame':
        editor.seek(on.frame);
        editor.ui.set({ view: 'edit' });
        return;
      default: {
        const exhaustive: never = on;
        return exhaustive;
      }
    }
  }
}

function targetLabel(script: Script, on: ScriptNoteTarget, fps: number): string {
  switch (on.kind) {
    case 'frame':
      return `at ${moment(on.frame, fps)}`;
    case 'section': {
      const i = script.sections.findIndex((s) => s.id === on.sectionId);
      return i === -1 ? 'a deleted section' : `${i + 1}. ${script.sections[i]!.title}`;
    }
    case 'line': {
      for (const [i, s] of script.sections.entries()) {
        const j = s.lines.findIndex((l) => l.id === on.lineId);
        if (j !== -1) {
          const say = s.lines[j]!.say;
          return `${i + 1}.${j + 1} · ${say.length > 48 ? `${say.slice(0, 46)}…` : say || '(empty line)'}`;
        }
      }
      return 'a deleted line';
    }
    default: {
      const exhaustive: never = on;
      return exhaustive;
    }
  }
}

function NoteComposer({ target, label }: { target: ScriptNoteTarget; label: string }) {
  const editor = useEditor();
  const [text, setText] = useState('');
  const save = () => {
    if (text.trim()) editor.doc.addNote({ on: target, text: text.trim(), author: 'person' });
    editor.ui.set({ noteDraft: null });
  };
  return (
    <div className="note-thread composing">
      <div className="note-on">new note on {label}</div>
      <textarea
        className="editable boxed"
        autoFocus
        rows={3}
        value={text}
        placeholder="What's wrong, or what you want instead"
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) save();
          if (e.key === 'Escape') editor.ui.set({ noteDraft: null });
        }}
      />
      <div className="row" style={{ gap: 6, marginTop: 6 }}>
        <button className="btn sm magenta" disabled={!text.trim()} onClick={save}>
          Add note
        </button>
        <button className="btn sm ghost" onClick={() => editor.ui.set({ noteDraft: null })}>
          Cancel
        </button>
      </div>
    </div>
  );
}

const WHO: Record<ScriptNote['author'], string> = { person: 'You', agent: 'Agent' };

function NoteThread({ note, number, label, onOpenTarget }: { note: ScriptNote; number: number; label: string; onOpenTarget: () => void }) {
  const editor = useEditor();
  const [reply, setReply] = useState('');
  const send = () => {
    if (reply.trim()) editor.doc.replyToNote(note.id, { text: reply.trim(), author: 'person' });
    setReply('');
  };
  return (
    <div className={`note-thread${note.resolved ? ' resolved' : ''}`}>
      <button className="note-on" onClick={onOpenTarget} title="Show it">
        #{number} · {label}
      </button>
      <div className="note-text">
        <span className={`who ${note.author}`}>{WHO[note.author]}</span> {note.text}
      </div>
      {note.replies.map((r, i) => (
        <div key={i} className="note-reply">
          <span className={`who ${r.author}`}>{WHO[r.author]}</span> {r.text}
        </div>
      ))}
      {note.resolved ? null : (
        <textarea
          className="editable boxed reply"
          rows={1}
          value={reply}
          placeholder="Reply"
          onChange={(e) => setReply(e.target.value)}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
        />
      )}
      <div className="note-actions">
        <button className="icon-btn" onClick={() => editor.doc.setNoteResolved(note.id, !note.resolved)}>
          {note.resolved ? 'reopen' : 'resolve'}
        </button>
        <button className="icon-btn danger" title="Delete the note" onClick={() => editor.doc.removeNote(note.id)}>
          delete
        </button>
      </div>
    </div>
  );
}
