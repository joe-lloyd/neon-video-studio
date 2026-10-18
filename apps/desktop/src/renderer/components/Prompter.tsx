import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { cueIsTight, cueStateAt, framesToTimecode, scriptCues, type ScriptCue } from '@neon/core';
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
  const selected = useSelector(editor.ui, (u) => u.voiceOverLineId);
  const fps = project.meta.fps;
  const cues = useMemo(() => scriptCues(project.script), [project.script]);
  const { current, next, framesToNext } = cueStateAt(cues, frame);
  const [editing, setEditing] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const positioned = useRef(false);
  const focus = current !== -1 ? current : next;
  useLayoutEffect(() => {
    if (focus === -1) return;
    listRef.current?.querySelector(`[data-cue="${cues[focus]!.id}"]`)?.scrollIntoView({ block: 'center', behavior: positioned.current ? 'smooth' : 'instant' });
    positioned.current = true;
  }, [focus, cues]);

  if (cues.length === 0) {
    return (
      <div className="panel-body">
        <div className="empty">
          <strong>Nothing to read yet.</strong>
          <br />
          Lines show up here once they are placed on the timeline. Plan them in the{' '}
          <button className="link" onClick={() => editor.ui.set({ view: 'script' })}>
            Script view
          </button>
          , then read along here, or press record and follow the big prompter.
        </div>
      </div>
    );
  }

  const tight = cues.filter((c) => cueIsTight(c, fps)).length;
  const countIn = recording && current === -1 && framesToNext !== null && framesToNext <= COUNT_IN * fps ? Math.ceil(framesToNext / fps) : null;
  const voTracks = new Set(project.tracks.filter(t => t.name === 'VO' && t.kind === 'audio').map(t => t.id));
  const unsplit = project.clips.some(c => c.kind === 'audio' && voTracks.has(c.trackId) && !c.scriptLineId);

  return (
    <div className="panel-body prompter-body" ref={listRef}>
      <p className="hint" style={{ marginBottom: 8 }}>
        {cues.length} lines{tight ? ` · ${tight} tight` : ''} · click = select · double-click = edit
      </p>
      <div className="row" style={{ flexWrap: 'wrap', gap: 6 }}>
        <button className="btn sm ghost" disabled={!!recording} onClick={() => { editor.ui.set({ voiceOverLineId: null }); void editor.startVoiceOver(); }}>Record from playhead</button>
        {unsplit ? <button className="btn sm ghost" disabled={!!recording} onClick={() => editor.splitExistingVoiceOver()}>Split existing takes</button> : null}
      </div>
      {cues.map((cue, i) => {
        const state = i === current ? ' now' : i === next && current === -1 ? ' next' : cue.startFrame + cue.durationFrames <= frame ? ' done' : '';
        return (
          <div key={cue.id}>
            {countIn !== null && i === next ? (
              <div className="prompter-count">
                <i /> next line in {countIn}
              </div>
            ) : null}
            <div className={`cue${state}${selected === cue.id ? ' selected' : ''}`} data-cue={cue.id} onClick={() => editor.selectVoiceOverLine(cue.id)} onDoubleClick={() => { if (!recording) setEditing(cue.id); }}>
              <div className="cue-meta">
                <span>{framesToTimecode(cue.startFrame, fps)}</span>
                <span className={cueIsTight(cue, fps) ? 'tight' : ''} title={cueIsTight(cue, fps) ? 'More words than this line has time for' : undefined}>
                  {(cue.durationFrames / fps).toFixed(1)} s{cueIsTight(cue, fps) ? ' · tight' : ''}
                </span>
              </div>
              {editing === cue.id ? <CueEditor cue={cue} onDone={() => setEditing(null)} /> : <div className="cue-text">{cue.text}</div>}
              <button className="btn sm ghost cue-record" disabled={!!recording} onClick={e => { e.stopPropagation(); editor.selectVoiceOverLine(cue.id); void editor.startVoiceOver(cue.id); }}>
                <span className="rec-dot" /> {project.clips.some(c => c.kind === 'audio' && c.scriptLineId === cue.id) ? 'Re-record line' : 'Record line'}
              </button>
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
    if (text.trim() !== cue.text) editor.doc.updateLine(cue.id, { say: text.trim() });
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
  const cues = useMemo(() => scriptCues(project.script), [project.script]);
  if (!recording || hidden || cues.length === 0) return null;

  const fps = project.meta.fps;
  const { current, next, framesToNext } = cueStateAt(cues, frame);
  // Keep the target in the same reading slot through count-in, mic startup and saving.
  // In continuous mode show the next line during gaps, so its arrival doesn't move the text.
  const targetIndex = cues.findIndex(c => c.id === recording.lineId);
  const readingIndex = targetIndex !== -1 ? targetIndex : current !== -1 ? current : next;
  const reading = cues[readingIndex];
  const upcoming = readingIndex !== -1 ? cues[readingIndex + 1] : undefined;
  const active = reading && frame >= reading.startFrame && frame < reading.startFrame + reading.durationFrames;
  const left = active ? 1 - (frame - reading.startFrame) / reading.durationFrames : 0;
  const countIn = current === -1 && framesToNext !== null && framesToNext <= COUNT_IN * fps ? Math.ceil(framesToNext / fps) : null;
  const status = recording.phase === 'countdown' ? String(recording.remaining)
    : recording.phase === 'starting' ? 'Opening microphone…'
    : recording.phase === 'finishing' ? 'Saving take…'
    : active ? 'Read now' : countIn !== null ? String(countIn) : 'pause';

  return (
    <div className="prompter-overlay">
      <button className="prompter-hide" onClick={() => editor.ui.set({ prompterHidden: true })} title="Hide the prompter (the Script tab keeps following)">
        hide
      </button>
      <div className="prompter-status" role="status" aria-live="polite">{status}</div>
      <div className="prompter-reading">
        <div key={reading?.id ?? 'end'} className="line now">{reading?.text ?? 'End of script'}</div>
      </div>
      <div className="bar">
        <i style={{ width: `${Math.max(0, Math.min(1, left)) * 100}%` }} />
      </div>
      <div className="prompter-upcoming">
        {upcoming ? <div key={upcoming.id} className="line upcoming">{upcoming.text}</div> : null}
      </div>
      <button className="btn ghost" disabled={recording.phase === 'finishing'} onClick={() => editor.stopVoiceOver()}>
        {recording.phase === 'recording' ? 'Stop and save' : recording.phase === 'finishing' ? 'Saving…' : 'Cancel'}
      </button>
    </div>
  );
}
