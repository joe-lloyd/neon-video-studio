import { useEffect, useRef, useState } from 'react';
import { cueIsTight, cueStateAt, framesToTimecode, type ScriptCue } from '@neon/core';
import { useEditor } from '../lib/context.ts';
import { useSelector, useStoreValue } from '../lib/store.ts';

/** Seconds of count-in shown before a line, while recording. */
const COUNT_IN = 3;

/**
 * The script as a prompter list: every cue in timeline order, the one under the playhead lit and
 * kept in view. Click a cue to jump to it; double-click to edit its words (Enter saves, Esc cancels).
 */
export function PrompterView() {
  const editor = useEditor();
  const { project } = useStoreValue(editor.project);
  const frame = useStoreValue(editor.playhead).frame;
  const recording = useSelector(editor.ui, (u) => u.recording);
  const fps = project.meta.fps;
  const cues = project.cues;
  const { current, next, framesToNext } = cueStateAt(cues, frame);
  const [editing, setEditing] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const focus = current !== -1 ? current : next;
  useEffect(() => {
    if (focus === -1) return;
    listRef.current?.querySelector(`[data-cue="${cues[focus]!.id}"]`)?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [focus, cues]);

  if (cues.length === 0) {
    return (
      <div className="panel-body">
        <div className="empty">
          <strong>No script yet.</strong>
          <br />
          Write one with <span className="mono">neon-cli script set cues.json</span>: lines pinned to when they should be said. Then read along here, or press record and follow the big prompter.
        </div>
      </div>
    );
  }

  const tight = cues.filter((c) => cueIsTight(c, fps)).length;
  const countIn = recording && current === -1 && framesToNext !== null && framesToNext <= COUNT_IN * fps ? Math.ceil(framesToNext / fps) : null;

  return (
    <div className="panel-body prompter-body" ref={listRef}>
      <p className="hint" style={{ marginBottom: 8 }}>
        {cues.length} lines{tight ? ` · ${tight} tight` : ''} · click = jump · double-click = edit
      </p>
      {cues.map((cue, i) => {
        const state = i === current ? ' now' : i === next && current === -1 ? ' next' : cue.startFrame + cue.durationFrames <= frame ? ' done' : '';
        return (
          <div key={cue.id}>
            {countIn !== null && i === next ? (
              <div className="prompter-count">
                <i /> next line in {countIn}
              </div>
            ) : null}
            <div className={`cue${state}`} data-cue={cue.id} onClick={() => editor.seek(cue.startFrame)} onDoubleClick={() => setEditing(cue.id)}>
              <div className="cue-meta">
                <span>{framesToTimecode(cue.startFrame, fps)}</span>
                <span className={cueIsTight(cue, fps) ? 'tight' : ''} title={cueIsTight(cue, fps) ? 'More words than this line has time for' : undefined}>
                  {(cue.durationFrames / fps).toFixed(1)} s{cueIsTight(cue, fps) ? ' · tight' : ''}
                </span>
              </div>
              {editing === cue.id ? <CueEditor cue={cue} onDone={() => setEditing(null)} /> : <div className="cue-text">{cue.text}</div>}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function CueEditor({ cue, onDone }: { cue: ScriptCue; onDone: () => void }) {
  const editor = useEditor();
  const [text, setText] = useState(cue.text);
  const save = () => {
    if (text.trim() !== cue.text) editor.doc.updateCue(cue.id, { text: text.trim() });
    onDone();
  };
  return (
    <textarea
      className="cue-edit"
      autoFocus
      value={text}
      rows={Math.max(2, Math.ceil(text.length / 34))}
      onClick={(e) => e.stopPropagation()}
      onChange={(e) => setText(e.target.value)}
      onBlur={save}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          save();
        } else if (e.key === 'Escape') onDone();
      }}
    />
  );
}

/**
 * The reading view while a voice-over records: covers the preview with the line to say now, the
 * next one, a bar for the time the line has left, and a count-in before each line.
 */
export function PrompterOverlay() {
  const editor = useEditor();
  const { project } = useStoreValue(editor.project);
  const frame = useStoreValue(editor.playhead).frame;
  const recording = useSelector(editor.ui, (u) => u.recording);
  const hidden = useSelector(editor.ui, (u) => u.prompterHidden);
  const cues = project.cues;
  if (!recording || hidden || cues.length === 0) return null;

  const fps = project.meta.fps;
  const { current, next, framesToNext } = cueStateAt(cues, frame);
  const now = current !== -1 ? cues[current]! : null;
  const upcoming = current !== -1 ? cues[current + 1] : next !== -1 ? cues[next] : undefined;
  const previous = current > 0 ? cues[current - 1] : next > 0 ? cues[next - 1] : undefined;
  const left = now ? 1 - (frame - now.startFrame) / now.durationFrames : 0;
  const countIn = !now && framesToNext !== null && framesToNext <= COUNT_IN * fps ? Math.ceil(framesToNext / fps) : null;

  return (
    <div className="prompter-overlay">
      <button className="prompter-hide" onClick={() => editor.ui.set({ prompterHidden: true })} title="Hide the prompter (the Script tab keeps following)">
        hide
      </button>
      {previous ? <div className="line done">{previous.text}</div> : null}
      {now ? (
        <>
          <div className="line now">{now.text}</div>
          <div className="bar">
            <i style={{ width: `${Math.max(0, Math.min(1, left)) * 100}%` }} />
          </div>
        </>
      ) : (
        <div className="line wait">{countIn !== null ? <span className="count">{countIn}</span> : 'pause'}</div>
      )}
      {upcoming ? <div className="line upcoming">{upcoming.text}</div> : null}
    </div>
  );
}
