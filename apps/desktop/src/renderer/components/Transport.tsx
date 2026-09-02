import { useEffect, useState } from 'react';
import { framesToTimecode } from '@neon/core';
import { Magnet, NeonIcon, Pause, Play, Redo2, Scissors, SkipBack, SkipForward, Trash2, Undo2, Volume2, VolumeX, ZoomIn, ZoomOut, Maximize2 } from '@neon/icon-kit';
import { useEditor } from '../lib/context.ts';
import { kbdFor } from '../lib/kbd.ts';
import { useSelector, useStoreValue } from '../lib/store.ts';

function RecordButton() {
  const editor = useEditor();
  const recording = useSelector(editor.ui, (u) => u.recording);
  const [, tick] = useState(0);
  useEffect(() => {
    if (!recording) return;
    const t = setInterval(() => tick((n) => n + 1), 500);
    return () => clearInterval(t);
  }, [recording]);
  const seconds = recording ? Math.floor((Date.now() - recording.startedAt) / 1000) : 0;
  return (
    <>
      <button
        className={`btn icon record${recording ? ' armed' : ''}`}
        title={recording ? 'Stop recording (drops the take on the VO track)' : 'Record voice-over from the playhead (wear headphones or mute the preview)'}
        onClick={() => (recording ? editor.stopVoiceOver() : void editor.startVoiceOver())}
      >
        <span className="rec-dot" />
      </button>
      {recording ? <span className="rec-time">{Math.floor(seconds / 60)}:{String(seconds % 60).padStart(2, '0')}</span> : null}
    </>
  );
}

export function Transport() {
  const editor = useEditor();
  const kbd = kbdFor(editor.bridge.bootstrap.platform);
  const { frame, playing } = useStoreValue(editor.playhead);
  const { project, durationFrames } = useStoreValue(editor.project);
  const snapping = useSelector(editor.ui, (u) => u.snapping);
  const muted = useSelector(editor.ui, (u) => u.previewMuted);
  const selection = useSelector(editor.ui, (u) => u.selection);
  const canUndo = useSelector(editor.ui, (u) => u.canUndo);
  const canRedo = useSelector(editor.ui, (u) => u.canRedo);
  const fps = project.meta.fps;

  return (
    <div className="transport">
      <button className="btn icon ghost" title="Go to start (Home)" onClick={() => editor.seek(0)}><NeonIcon icon={SkipBack} size={16} /></button>
      <button className="btn icon magenta" title="Play / Pause (Space)" onClick={() => editor.togglePlay()}>
        <NeonIcon icon={playing ? Pause : Play} size={16} tone="magenta" glow={2} />
      </button>
      <button className="btn icon ghost" title="Go to end (End)" onClick={() => editor.seek(Math.max(0, durationFrames - 1))}><NeonIcon icon={SkipForward} size={16} /></button>
      <RecordButton />
      <span className="timecode">{framesToTimecode(frame, fps)}</span>
      <span className="timecode total mono">/ {framesToTimecode(durationFrames, fps)}</span>
      <span className="spacer" />
      <button className="btn icon ghost" title={`Undo (${kbd.mod('Z')})`} disabled={!canUndo} onClick={() => editor.undoEdit()}><NeonIcon icon={Undo2} size={15} tone={canUndo ? 'white' : 'muted'} /></button>
      <button className="btn icon ghost" title={`Redo (${kbd.shiftMod('Z')})`} disabled={!canRedo} onClick={() => editor.redoEdit()}><NeonIcon icon={Redo2} size={15} tone={canRedo ? 'white' : 'muted'} /></button>
      <button className="btn icon ghost" title="Split at playhead (S)" onClick={() => editor.splitAtPlayhead()}><NeonIcon icon={Scissors} size={15} tone="cyan" /></button>
      <button className="btn icon ghost" title={`Delete selection (${kbd.isMac ? '⌫' : 'Del'})`} disabled={selection.length === 0} onClick={() => editor.deleteSelection()}><NeonIcon icon={Trash2} size={15} tone="red" /></button>
      <span style={{ width: 8 }} />
      <button className={`btn icon ghost${snapping ? ' active' : ''}`} title="Snapping (N)" onClick={() => editor.ui.set({ snapping: !snapping })}><NeonIcon icon={Magnet} size={15} tone={snapping ? 'magenta' : 'muted'} /></button>
      <button className="btn icon ghost" title={muted ? 'Unmute preview' : 'Mute preview'} onClick={() => editor.ui.set({ previewMuted: !muted })}><NeonIcon icon={muted ? VolumeX : Volume2} size={15} tone={muted ? 'muted' : 'white'} /></button>
      <button className="btn icon ghost" title="Zoom out (-)" onClick={() => editor.zoomBy(0.8)}><NeonIcon icon={ZoomOut} size={15} /></button>
      <button className="btn icon ghost" title="Zoom in (+)" onClick={() => editor.zoomBy(1.25)}><NeonIcon icon={ZoomIn} size={15} /></button>
      <button className="btn icon ghost" title="Fit timeline" onClick={() => editor.fitTimeline(document.querySelector('.tl-lanes')?.clientWidth ?? 1000)}><NeonIcon icon={Maximize2} size={14} /></button>
    </div>
  );
}
