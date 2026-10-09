import { useEffect, useRef, useState } from 'react';
import { framesToTimecode, type CaptureDevices } from '@neon/core';
import { Loader2, Magnet, Monitor, NeonIcon, Square, Pause, Play, Redo2, Scissors, SkipBack, SkipForward, Trash2, Undo2, Volume2, VolumeX, ZoomIn, ZoomOut, Maximize2 } from '@neon/icon-kit';
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

function clock(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

const DISPLAY_KEY = 'neon:captureDisplay';
const MIC_KEY = 'neon:captureMic';

/** Display + mic picker; remembers the last choice. */
function CapturePopover({ onClose }: { onClose: () => void }) {
  const editor = useEditor();
  const [devices, setDevices] = useState<CaptureDevices | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [display, setDisplay] = useState(() => Number(localStorage.getItem(DISPLAY_KEY) ?? 0));
  // '' = no microphone; null = not chosen yet (use the default once devices load).
  const [mic, setMic] = useState<string | null>(() => localStorage.getItem(MIC_KEY));

  useEffect(() => {
    let live = true;
    editor.bridge
      .request('captureDevices', {})
      .then((d) => {
        if (!live) return;
        setDevices(d);
        setDisplay((n) => (d.displays.some((s) => s.index === n) ? n : (d.displays[0]?.index ?? 0)));
        setMic((m) => (m === '' || (m !== null && d.mics.includes(m)) ? m : (d.defaultMic ?? '')));
      })
      .catch((err: Error) => live && setError(err.message));
    return () => {
      live = false;
    };
  }, [editor]);

  const start = () => {
    localStorage.setItem(DISPLAY_KEY, String(display));
    localStorage.setItem(MIC_KEY, mic ?? '');
    onClose();
    void editor.startScreenCapture({ display, mic: mic ? mic : false });
  };
  const ready = devices !== null && devices.displays.length > 0;

  return (
    <div className="capture-pop panel" role="dialog" aria-label="Record screen">
      <h4>Record screen</h4>
      {error ? <p className="err">{error}</p> : null}
      {devices && devices.displays.length === 0 ? <p className="err">No screens are visible to the recorder. On macOS, allow Screen Recording for Neon Video Studio in System Settings → Privacy &amp; Security, then reopen the app.</p> : null}
      {!devices && !error ? (
        <p className="hint row"><NeonIcon icon={Loader2} size={13} className="spin" /> Looking for displays and microphones…</p>
      ) : null}
      {ready ? (
        <>
          <div className="field">
            <label htmlFor="capture-display">Display</label>
            <select id="capture-display" className="select" value={display} onChange={(e) => setDisplay(Number(e.target.value))}>
              {devices.displays.map((d) => (
                <option key={d.index} value={d.index}>
                  {`Display ${d.index + 1}${d.primary ? ' (main)' : ''}${d.bounds ? ` · ${d.bounds.width}×${d.bounds.height}` : ''}`}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="capture-mic">Microphone</label>
            <select id="capture-mic" className="select" value={mic ?? ''} onChange={(e) => setMic(e.target.value)}>
              <option value="">No microphone</option>
              {devices.mics.map((m) => (
                <option key={m} value={m}>{m}</option>
              ))}
            </select>
          </div>
          <p className="hint">Starts after a 3-second countdown. The take is added to the end of V1.</p>
        </>
      ) : null}
      <div className="row between">
        <button className="btn sm ghost" onClick={onClose}>Cancel</button>
        <button className="btn sm magenta" disabled={!ready} onClick={start}><span className="rec-dot" /> Start recording</button>
      </div>
    </div>
  );
}

function ScreenCaptureButton() {
  const editor = useEditor();
  const capture = useSelector(editor.ui, (u) => u.screenCapture);
  const voiceOver = useSelector(editor.ui, (u) => u.recording);
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const [, tick] = useState(0);

  useEffect(() => void editor.syncScreenCapture(), [editor]);
  useEffect(() => {
    if (capture.phase !== 'recording') return;
    const t = setInterval(() => tick((n) => n + 1), 500);
    return () => clearInterval(t);
  }, [capture.phase]);
  useEffect(() => {
    if (!open && capture.phase !== 'countdown') return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      setOpen(false);
      void editor.cancelScreenCapture();
    };
    const onDown = (e: MouseEvent) => {
      if (open && wrap.current && !wrap.current.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('mousedown', onDown);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('mousedown', onDown);
    };
  }, [open, capture.phase, editor]);

  switch (capture.phase) {
    case 'idle':
      return (
        <div className="capture-wrap" ref={wrap}>
          <button className={`btn icon ghost${open ? ' active' : ''}`} title="Record screen" disabled={voiceOver !== null} aria-expanded={open} onClick={() => setOpen(!open)}>
            <NeonIcon icon={Monitor} size={15} tone="cyan" />
          </button>
          {open ? <CapturePopover onClose={() => setOpen(false)} /> : null}
        </div>
      );
    case 'countdown':
      return (
        <>
          <button className="btn icon record armed" title="Cancel (Esc)" onClick={() => void editor.cancelScreenCapture()}>
            <NeonIcon icon={Monitor} size={15} tone="red" />
          </button>
          <div className="capture-countdown" aria-live="assertive">
            <span key={capture.remaining}>{capture.remaining}</span>
            <small>Recording the screen · Esc to cancel</small>
          </div>
        </>
      );
    case 'starting':
    case 'finishing':
      return (
        <button className="btn icon record" disabled title={capture.phase === 'starting' ? 'Starting the screen recording…' : 'Saving the recording…'}>
          <NeonIcon icon={Loader2} size={15} tone="red" className="spin" />
        </button>
      );
    case 'recording':
      return (
        <>
          <button className="btn icon record armed" title="Stop screen recording (adds the take to V1)" onClick={() => void editor.stopScreenCapture()}>
            <NeonIcon icon={Square} size={12} tone="red" fill="currentColor" />
          </button>
          <span className="rec-time" title="Screen recording">{clock(Date.now() - capture.startedAt)}</span>
        </>
      );
    default: {
      const exhaustive: never = capture;
      return exhaustive;
    }
  }
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
      <ScreenCaptureButton />
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
