import { useState } from 'react';
import { framesToTimecode } from '@neon/core';
import { useEditor } from '../lib/context.ts';
import { useStoreValue } from '../lib/store.ts';

/**
 * Review the cut where you watch it: pause, press note, say what's wrong at this moment. The note
 * lands in the Script view's margin and on the timeline ruler, and follows ripple cuts.
 */
export function FrameNoteButton() {
  const editor = useEditor();
  const [at, setAt] = useState<number | null>(null);
  const [text, setText] = useState('');
  const fps = useStoreValue(editor.project).project.meta.fps;
  const close = () => {
    setAt(null);
    setText('');
  };
  const save = () => {
    if (at !== null && text.trim()) editor.doc.addNote({ on: { kind: 'frame', frame: at }, text: text.trim(), author: 'person' });
    close();
  };
  return (
    <>
      <button
        className={at !== null ? 'on' : ''}
        title="Note at the playhead: pin what's wrong to this moment"
        onClick={() => {
          editor.player?.pause();
          setAt(editor.playhead.get().frame);
        }}
      >
        note
      </button>
      {at !== null ? (
        <div className="frame-note" onPointerDown={(e) => e.stopPropagation()}>
          <span className="mono">{framesToTimecode(at, fps).replace(/:\d\d$/, '')}</span>
          <input
            autoFocus
            value={text}
            placeholder="What's wrong here? Enter saves, Esc cancels"
            onChange={(e) => setText(e.target.value)}
            onBlur={close}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === 'Enter') save();
              if (e.key === 'Escape') close();
            }}
          />
        </div>
      ) : null}
    </>
  );
}

/** Open notes pinned to moments, as markers on the timeline ruler. Click one to go there. */
export function NoteMarkers({ pxPerFrame }: { pxPerFrame: number }) {
  const editor = useEditor();
  const notes = useStoreValue(editor.project).project.script.notes;
  return (
    <>
      {notes.map((note) =>
        note.on.kind === 'frame' && !note.resolved ? (
          <button
            key={note.id}
            className="note-marker"
            style={{ left: note.on.frame * pxPerFrame }}
            title={note.text}
            onPointerDown={(e) => {
              e.stopPropagation();
              if (note.on.kind === 'frame') editor.seek(note.on.frame);
            }}
            onDoubleClick={() => editor.ui.set({ view: 'script' })}
          />
        ) : null,
      )}
    </>
  );
}
