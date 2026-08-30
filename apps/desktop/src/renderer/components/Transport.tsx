import { framesToTimecode } from '@neon/core';
import { Magnet, NeonIcon, Pause, Play, Redo2, Scissors, SkipBack, SkipForward, Trash2, Undo2, Volume2, VolumeX, ZoomIn, ZoomOut, Maximize2 } from '@neon/icon-kit';
import { useEditor } from '../lib/context.ts';
import { useSelector, useStoreValue } from '../lib/store.ts';

export function Transport() {
  const editor = useEditor();
  const { frame, playing } = useStoreValue(editor.playhead);
  const { project, durationFrames } = useStoreValue(editor.project);
  const snapping = useSelector(editor.ui, (u) => u.snapping);
  const muted = useSelector(editor.ui, (u) => u.previewMuted);
  const selection = useSelector(editor.ui, (u) => u.selection);
  const fps = project.meta.fps;

  return (
    <div className="transport">
      <button className="btn icon ghost" title="Go to start (Home)" onClick={() => editor.seek(0)}><NeonIcon icon={SkipBack} size={16} /></button>
      <button className="btn icon magenta" title="Play / Pause (Space)" onClick={() => editor.togglePlay()}>
        <NeonIcon icon={playing ? Pause : Play} size={16} tone="magenta" glow={2} />
      </button>
      <button className="btn icon ghost" title="Go to end (End)" onClick={() => editor.seek(Math.max(0, durationFrames - 1))}><NeonIcon icon={SkipForward} size={16} /></button>
      <span className="timecode">{framesToTimecode(frame, fps)}</span>
      <span className="timecode total mono">/ {framesToTimecode(durationFrames, fps)}</span>
      <span className="spacer" />
      <button className="btn icon ghost" title="Undo (⌘Z)" onClick={() => editor.undoEdit()}><NeonIcon icon={Undo2} size={15} /></button>
      <button className="btn icon ghost" title="Redo (⇧⌘Z)" onClick={() => editor.redoEdit()}><NeonIcon icon={Redo2} size={15} /></button>
      <button className="btn icon ghost" title="Split at playhead (S)" onClick={() => editor.splitAtPlayhead()}><NeonIcon icon={Scissors} size={15} tone="cyan" /></button>
      <button className="btn icon ghost" title="Delete selection (⌫)" disabled={selection.length === 0} onClick={() => editor.deleteSelection()}><NeonIcon icon={Trash2} size={15} tone="red" /></button>
      <span style={{ width: 8 }} />
      <button className={`btn icon ghost${snapping ? ' active' : ''}`} title="Snapping (N)" onClick={() => editor.ui.set({ snapping: !snapping })}><NeonIcon icon={Magnet} size={15} tone={snapping ? 'magenta' : 'muted'} /></button>
      <button className="btn icon ghost" title={muted ? 'Unmute preview' : 'Mute preview'} onClick={() => editor.ui.set({ previewMuted: !muted })}><NeonIcon icon={muted ? VolumeX : Volume2} size={15} tone={muted ? 'muted' : 'white'} /></button>
      <button className="btn icon ghost" title="Zoom out (-)" onClick={() => editor.zoomBy(0.8)}><NeonIcon icon={ZoomOut} size={15} /></button>
      <button className="btn icon ghost" title="Zoom in (+)" onClick={() => editor.zoomBy(1.25)}><NeonIcon icon={ZoomIn} size={15} /></button>
      <button className="btn icon ghost" title="Fit timeline" onClick={() => editor.fitTimeline(document.querySelector('.tl-lanes')?.clientWidth ?? 1000)}><NeonIcon icon={Maximize2} size={14} /></button>
    </div>
  );
}
