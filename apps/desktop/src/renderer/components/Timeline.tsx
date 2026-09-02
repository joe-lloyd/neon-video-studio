import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { CLIP_COLORS, framesToTimecode, snapFrame, sortClips, sortTracks, trackKindForClip, type Clip, type Track, type TrackKind } from '@neon/core';
import { Eye, EyeOff, Lock, NeonIcon, Plus, Trash2, Unlock, Volume2, VolumeX } from '@neon/icon-kit';
import { useEditor } from '../lib/context.ts';
import { kbdFor } from '../lib/kbd.ts';
import { useElementSize } from '../lib/hooks.ts';
import { useSelector, useStoreValue } from '../lib/store.ts';
import { useWaveform } from '../lib/waveforms.ts';
import { Waveform } from './Waveform.tsx';

const ROW_H = 52;
const SNAP_PX = 8;
const TRACK_COLOR: Record<TrackKind, string> = { video: CLIP_COLORS.video, audio: CLIP_COLORS.audio, overlay: CLIP_COLORS.component };

type Drag =
  | { kind: 'move'; id: string; ids: string[]; delta: number; originX: number; originStart: number; startFrame: number; trackId: string; duration: number; clipKind: Clip['kind'] }
  | { kind: 'trim'; id: string; edge: 'start' | 'end'; originX: number; frame: number; clipStart: number; clipEnd: number };

function tickIntervalFrames(pxPerFrame: number, fps: number): number {
  const seconds = [0.04, 0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600];
  for (const s of seconds) {
    const frames = Math.max(1, Math.round(s * fps));
    if (frames * pxPerFrame >= 90) return frames;
  }
  return 600 * fps;
}

export function Timeline() {
  const editor = useEditor();
  const { project, durationFrames } = useStoreValue(editor.project);
  const pxPerFrame = useSelector(editor.ui, (u) => u.pxPerFrame);
  const snapping = useSelector(editor.ui, (u) => u.snapping);
  const selection = useSelector(editor.ui, (u) => u.selection);
  const session = useSelector(editor.ui, (u) => u.session);
  const flash = useSelector(editor.ui, (u) => u.flash);
  const fps = project.meta.fps;
  const [lanesRef, lanesSize] = useElementSize<HTMLDivElement>();
  const headersRef = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const [snapLine, setSnapLine] = useState<number | null>(null);
  const [dropTrack, setDropTrack] = useState<string | null>(null);
  const [marquee, setMarquee] = useState<{ trackId: string; from: number; to: number } | null>(null);

  const tracks = useMemo(() => sortTracks(project.tracks), [project.tracks]);
  const totalFrames = Math.max(durationFrames + fps * 10, Math.ceil((lanesSize.width || 800) / pxPerFrame));
  const width = totalFrames * pxPerFrame;
  const interval = tickIntervalFrames(pxPerFrame, fps);

  const clipsByTrack = useMemo(() => {
    const m = new Map<string, Clip[]>();
    for (const c of project.clips) m.set(c.trackId, [...(m.get(c.trackId) ?? []), c]);
    return m;
  }, [project.clips]);

  const frameAt = useCallback(
    (clientX: number) => {
      const el = lanesRef.current;
      if (!el) return 0;
      const rect = el.getBoundingClientRect();
      return Math.max(0, Math.round((clientX - rect.left + el.scrollLeft) / pxPerFrame));
    },
    [pxPerFrame, lanesRef],
  );

  const trackAt = useCallback(
    (clientY: number): Track | undefined => {
      const el = lanesRef.current;
      if (!el) return undefined;
      const rect = el.getBoundingClientRect();
      const idx = Math.floor((clientY - rect.top + el.scrollTop) / ROW_H);
      return tracks[idx];
    },
    [tracks, lanesRef],
  );

  const snapCandidates = useMemo(() => {
    const set = new Set<number>([0, editor.playhead.get().frame]);
    for (const c of project.clips) {
      set.add(c.startFrame);
      set.add(c.startFrame + c.durationFrames);
    }
    return Array.from(set);
  }, [project.clips, editor]);

  // ---- scrubbing ---------------------------------------------------------------------
  const scrub = (e: ReactPointerEvent<HTMLElement>) => {
    editor.player?.pause();
    editor.seek(frameAt(e.clientX));
    const move = (ev: PointerEvent) => editor.seek(frameAt(ev.clientX));
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  // ---- clip drag / trim --------------------------------------------------------------
  /** Shift-click: extend the selection along the lane, from the last selected clip on it to this one. */
  const selectRange = (clip: Clip) => {
    const lane = sortClips(clipsByTrack.get(clip.trackId) ?? []);
    const anchorId = [...selection].reverse().find((id) => lane.some((c) => c.id === id));
    const anchor = anchorId ? lane.find((c) => c.id === anchorId) : undefined;
    if (!anchor) return editor.select([clip.id], true);
    const lo = Math.min(anchor.startFrame, clip.startFrame);
    const hi = Math.max(anchor.startFrame + anchor.durationFrames, clip.startFrame + clip.durationFrames);
    editor.select(lane.filter((c) => c.startFrame >= lo && c.startFrame + c.durationFrames <= hi).map((c) => c.id), true);
  };

  const beginMove = (e: ReactPointerEvent<HTMLDivElement>, clip: Clip) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    const track = tracks.find((t) => t.id === clip.trackId);
    if (track?.locked) return;
    // Modifier clicks only change the selection — no drag starts.
    if (e.shiftKey) return selectRange(clip);
    if (e.metaKey || e.ctrlKey) return editor.toggleSelect(clip.id);
    // Dragging one clip of a multi-selection moves the whole selection (clips on locked lanes stay).
    const lockedTracks = new Set(tracks.filter((t) => t.locked).map((t) => t.id));
    const ids = (selection.includes(clip.id) ? selection : [clip.id]).filter((id) => {
      const c = project.clips.find((x) => x.id === id);
      return c !== undefined && !lockedTracks.has(c.trackId);
    });
    if (!selection.includes(clip.id)) editor.select([clip.id]);
    const group = ids.length > 1;
    const groupMinStart = Math.min(...ids.map((id) => project.clips.find((c) => c.id === id)?.startFrame ?? clip.startFrame));
    // Window-level tracking (not element pointer capture): WKWebView drops capture when React
    // re-renders the clip mid-drag, which froze vertical moves between FX tracks.
    const state: Drag = { kind: 'move', id: clip.id, ids, delta: 0, originX: e.clientX, originStart: clip.startFrame, startFrame: clip.startFrame, trackId: clip.trackId, duration: clip.durationFrames, clipKind: clip.kind };
    setDrag(state);
    let latest = state;
    const move = (ev: PointerEvent) => {
      // A group moves rigidly: its leftmost clip never crosses frame 0.
      const delta = Math.max(-groupMinStart, Math.round((ev.clientX - state.originX) / pxPerFrame));
      let start = Math.max(0, state.originStart + delta);
      let line: number | null = null;
      if (snapping) {
        const others = snapCandidates.filter((f) => f !== clip.startFrame && f !== clip.startFrame + clip.durationFrames);
        const threshold = SNAP_PX / pxPerFrame;
        const snappedStart = snapFrame(start, others, threshold);
        const snappedEnd = snapFrame(start + state.duration, others, threshold);
        if (snappedStart !== start) {
          start = snappedStart;
          line = start;
        } else if (snappedEnd !== start + state.duration) {
          start = snappedEnd - state.duration;
          line = snappedEnd;
        }
      }
      start = Math.max(state.originStart - groupMinStart, start);
      const over = trackAt(ev.clientY);
      // Only a single clip changes lanes; a group keeps every clip on its own lane.
      const trackId = !group && over && over.kind === trackKindForClip(state.clipKind) && !over.locked ? over.id : latest.trackId;
      latest = { ...state, startFrame: start, trackId, delta: start - state.originStart };
      setDrag(latest);
      setSnapLine(line);
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      setDrag(null);
      setSnapLine(null);
      if (group) {
        if (latest.delta !== 0) editor.moveClips(ids, latest.delta);
      } else if (latest.startFrame !== clip.startFrame || latest.trackId !== clip.trackId) editor.moveClip(clip.id, latest.startFrame, latest.trackId);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  };

  const beginTrim = (e: ReactPointerEvent<HTMLDivElement>, clip: Clip, edge: 'start' | 'end') => {
    if (e.button !== 0) return;
    e.stopPropagation();
    const track = tracks.find((t) => t.id === clip.trackId);
    if (track?.locked) return;
    editor.select([clip.id]);
    const clipEnd = clip.startFrame + clip.durationFrames;
    const state: Drag = { kind: 'trim', id: clip.id, edge, originX: e.clientX, frame: edge === 'start' ? clip.startFrame : clipEnd, clipStart: clip.startFrame, clipEnd };
    setDrag(state);
    let latest = state;
    const move = (ev: PointerEvent) => {
      const delta = Math.round((ev.clientX - state.originX) / pxPerFrame);
      let frame = edge === 'start' ? Math.min(clipEnd - 1, Math.max(0, clip.startFrame + delta)) : Math.max(clip.startFrame + 1, clipEnd + delta);
      if (snapping) frame = snapFrame(frame, snapCandidates.filter((f) => f !== state.frame), SNAP_PX / pxPerFrame);
      if (edge === 'start') frame = Math.min(clipEnd - 1, frame);
      else frame = Math.max(clip.startFrame + 1, frame);
      latest = { ...state, frame };
      setDrag(latest);
      setSnapLine(frame);
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      setDrag(null);
      setSnapLine(null);
      if (latest.frame !== state.frame) editor.trimClip(clip.id, edge, latest.frame);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  };

  // ---- marquee: shift-drag on a lane selects the clips it sweeps over ---------------
  const beginMarquee = (e: ReactPointerEvent<HTMLElement>) => {
    const track = trackAt(e.clientY);
    if (!track) return;
    const base = selection;
    const from = frameAt(e.clientX);
    setMarquee({ trackId: track.id, from, to: from });
    const move = (ev: PointerEvent) => {
      const to = frameAt(ev.clientX);
      setMarquee({ trackId: track.id, from, to });
      const lo = Math.min(from, to);
      const hi = Math.max(from, to);
      const hit = (clipsByTrack.get(track.id) ?? []).filter((c) => c.startFrame < hi && c.startFrame + c.durationFrames > lo).map((c) => c.id);
      editor.select([...base, ...hit]);
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      setMarquee(null);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  };

  // ---- drops from panels -------------------------------------------------------------
  const onDrop = (e: React.DragEvent, track: Track) => {
    e.preventDefault();
    setDropTrack(null);
    const frame = frameAt(e.clientX);
    const assetId = e.dataTransfer.getData('application/x-neon-asset');
    const template = e.dataTransfer.getData('application/x-neon-template');
    if (assetId) {
      const asset = project.assets.find((a) => a.id === assetId);
      if (!asset) return;
      if (trackKindForClip(asset.kind) !== track.kind) return editor.toast('error', `${asset.kind} clips go on ${trackKindForClip(asset.kind)} tracks`);
      editor.insertAsset(assetId, frame, track.id);
    } else if (template) {
      if (track.kind !== 'overlay') return editor.toast('error', 'Templates go on FX (overlay) tracks');
      try {
        const clip = editor.doc.insertClip({ kind: 'component', componentName: template, startFrame: frame, trackId: track.id, placement: 'free' });
        editor.select([clip.id]);
      } catch (err) {
        editor.toast('error', (err as Error).message);
      }
    }
  };

  // ---- keep playhead in view while playing -------------------------------------------
  const playhead = useStoreValue(editor.playhead);
  useEffect(() => {
    const el = lanesRef.current;
    if (!el || !playhead.playing) return;
    const x = playhead.frame * pxPerFrame;
    if (x < el.scrollLeft || x > el.scrollLeft + el.clientWidth - 40) el.scrollLeft = Math.max(0, x - 60);
  }, [playhead, pxPerFrame, lanesRef]);

  const onWheel = (e: React.WheelEvent) => {
    // Trackpad pinches arrive as many ctrlKey+wheel events; scale by the actual delta so the
    // zoom follows the gesture instead of exploding, and anchor the frame under the cursor.
    if (e.altKey || e.metaKey || e.ctrlKey) {
      e.preventDefault();
      const factor = Math.exp(-Math.max(-30, Math.min(30, e.deltaY)) * 0.006);
      editor.zoomAt(factor, frameAt(e.clientX), lanesRef.current);
    }
  };

  const rulerInner = useRef<HTMLDivElement>(null);
  const syncScroll = () => {
    const el = lanesRef.current;
    if (!el) return;
    if (headersRef.current) headersRef.current.scrollTop = el.scrollTop;
    if (rulerInner.current) rulerInner.current.style.transform = `translateX(${-el.scrollLeft}px)`;
  };

  const ticks: { frame: number; major: boolean }[] = [];
  const minor = Math.max(1, Math.round(interval / 5));
  for (let f = 0; f <= totalFrames; f += minor) ticks.push({ frame: f, major: f % interval === 0 });

  return (
    <div className="timeline" onWheel={onWheel}>
      <div className="tl-corner">
        <button className="btn sm ghost" title="Add video track" onClick={() => editor.addTrack('video')}><NeonIcon icon={Plus} size={12} tone="magenta" />V</button>
        <button className="btn sm ghost" title="Add audio track" onClick={() => editor.addTrack('audio')}><NeonIcon icon={Plus} size={12} tone="cyan" />A</button>
        <button className="btn sm ghost" title="Add FX (overlay) track" onClick={() => editor.addTrack('overlay')}><NeonIcon icon={Plus} size={12} tone="green" />FX</button>
      </div>
      <div className="tl-ruler" onPointerDown={scrub}>
        <div className="tl-ruler-inner" ref={rulerInner} style={{ width }}>
          {ticks.map((t) => (
            <div key={t.frame}>
              <div className={`tick${t.major ? ' major' : ''}`} style={{ left: t.frame * pxPerFrame }} />
              {t.major ? <div className="tick-label" style={{ left: t.frame * pxPerFrame }}>{framesToTimecode(t.frame, fps, { showFrames: interval < fps })}</div> : null}
            </div>
          ))}
          <div className="playhead" style={{ left: playhead.frame * pxPerFrame }} />
          <div className="playhead-chip" style={{ left: playhead.frame * pxPerFrame }}>{framesToTimecode(playhead.frame, fps)}</div>
        </div>
      </div>
      <div className="tl-headers" ref={headersRef}>
        {tracks.map((t) => (
          <TrackHeader key={t.id} track={t} />
        ))}
      </div>
      <div className="tl-lanes" ref={lanesRef} onScroll={syncScroll} onPointerDown={(e) => { if (!(e.target === e.currentTarget || (e.target as HTMLElement).classList.contains('lane'))) return; if (e.shiftKey) return beginMarquee(e); editor.select([]); scrub(e); }}>
        <div className="tl-lanes-inner" style={{ width, height: tracks.length * ROW_H, ['--grid-px' as string]: `${interval * pxPerFrame}px` }}>
          {tracks.map((track) => (
            <div
              key={track.id}
              className={`lane${track.locked ? ' locked' : ''}${dropTrack === track.id ? ' drop-target' : ''}${drag?.kind === 'move' && drag.trackId === track.id ? ' drag-over' : ''}`}
              style={{ height: ROW_H }}
              onDragOver={(e) => {
                e.preventDefault();
                if (dropTrack !== track.id) setDropTrack(track.id);
              }}
              onDragLeave={() => setDropTrack((d) => (d === track.id ? null : d))}
              onDrop={(e) => onDrop(e, track)}
            >
              {(clipsByTrack.get(track.id) ?? [])
                .filter((c) => !(drag?.kind === 'move' && drag.id === c.id && drag.trackId !== track.id))
                .map((clip) => (
                  <ClipView key={clip.id} clip={clip} drag={drag} pxPerFrame={pxPerFrame} fps={fps} selected={selection.includes(clip.id)} flashing={flash[clip.id] !== undefined} onMove={beginMove} onTrim={beginTrim} />
                ))}
              {drag?.kind === 'move' && drag.trackId === track.id && !(clipsByTrack.get(track.id) ?? []).some((c) => c.id === drag.id) ? (
                <GhostClip drag={drag} pxPerFrame={pxPerFrame} clip={project.clips.find((c) => c.id === drag.id)!} fps={fps} />
              ) : null}
              {marquee?.trackId === track.id ? (
                <div className="marquee" style={{ left: Math.min(marquee.from, marquee.to) * pxPerFrame, width: Math.max(2, Math.abs(marquee.to - marquee.from) * pxPerFrame) }} />
              ) : null}
            </div>
          ))}
          {session?.peers
            .filter((p) => !p.isLocal)
            .map((p) => (
              <div key={p.clientId} className="peer-head" style={{ left: p.playheadFrame * pxPerFrame, background: p.color }}>
                <span className="tag" style={{ background: p.color }}>{p.name}</span>
              </div>
            ))}
          {project.clips.length === 0 && project.meta.id ? (
            <div className="tl-quickstart">
              <div className="card">
                <div className="step"><span className="num">1</span><span><b>Import media</b> <button className="btn sm cyan" onClick={() => void editor.importMedia(0)}>Import…</button></span></div>
                <div className="step"><span className="num">2</span><span>Drop it on <b>V1</b>, add <b>FX</b> templates from the side panel</span></div>
                <div className="step"><span className="num">3</span><span><b>Render</b> ({kbdFor(editor.bridge.bootstrap.platform).mod('E')}) — or drive everything with <span className="mono">neon-cli</span></span></div>
              </div>
            </div>
          ) : null}
          {snapLine !== null ? <div className="snap-line" style={{ left: snapLine * pxPerFrame }} /> : null}
          <div className="playhead" style={{ left: playhead.frame * pxPerFrame }} />
        </div>
      </div>
    </div>
  );
}

function TrackHeader({ track }: { track: Track }) {
  const editor = useEditor();
  return (
    <div className="track-header" style={{ height: ROW_H }}>
      <span className="kind" style={{ background: TRACK_COLOR[track.kind], boxShadow: `0 0 6px ${TRACK_COLOR[track.kind]}` }} />
      <span className="tname" title={track.id}>{track.name}</span>
      {track.kind !== 'overlay' ? (
        <button title={track.muted ? 'Unmute' : 'Mute'} className={track.muted ? 'on' : ''} onClick={() => editor.updateTrack(track.id, { muted: !track.muted })}>
          <NeonIcon icon={track.muted ? VolumeX : Volume2} size={13} tone={track.muted ? 'red' : 'muted'} />
        </button>
      ) : null}
      <button title={track.hidden ? 'Show' : 'Hide'} className={track.hidden ? 'on' : ''} onClick={() => editor.updateTrack(track.id, { hidden: !track.hidden })}>
        <NeonIcon icon={track.hidden ? EyeOff : Eye} size={13} tone={track.hidden ? 'amber' : 'muted'} />
      </button>
      <button title={track.locked ? 'Unlock' : 'Lock'} className={track.locked ? 'on' : ''} onClick={() => editor.updateTrack(track.id, { locked: !track.locked })}>
        <NeonIcon icon={track.locked ? Lock : Unlock} size={13} tone={track.locked ? 'amber' : 'muted'} />
      </button>
      <button title="Remove track (and its clips)" onClick={() => editor.removeTrack(track.id)}>
        <NeonIcon icon={Trash2} size={13} tone="muted" />
      </button>
    </div>
  );
}

function VolumeBar({ clip }: { clip: Clip & { kind: 'video' | 'audio' | 'image' } }) {
  const editor = useEditor();
  const [chip, setChip] = useState<{ x: number; y: number; volume: number } | null>(null);
  if (clip.kind === 'image') return null;
  // volume 0..2 maps bottom..top of the clip body (unity sits mid-height).
  const topPct = (1 - Math.min(2, Math.max(0, clip.volume)) / 2) * 100;
  return (
    <>
      <div
        className={`vol-line${chip ? ' active' : ''}`}
        style={{ top: `${topPct}%` }}
        title={`Volume ${(clip.volume * 100).toFixed(0)}% — drag to change`}
        onPointerDown={(e) => {
          e.stopPropagation();
          const lane = (e.currentTarget.closest('.clip') as HTMLElement).getBoundingClientRect();
          const apply = (clientY: number) => {
            const rel = Math.min(1, Math.max(0, (clientY - lane.top) / lane.height));
            const volume = Math.round((1 - rel) * 2 * 20) / 20;
            editor.updateClip(clip.id, { volume });
            return volume;
          };
          setChip({ x: e.clientX, y: e.clientY, volume: apply(e.clientY) });
          const move = (ev: PointerEvent) => setChip({ x: ev.clientX, y: ev.clientY, volume: apply(ev.clientY) });
          const up = () => {
            setChip(null);
            window.removeEventListener('pointermove', move);
            window.removeEventListener('pointerup', up);
          };
          window.addEventListener('pointermove', move);
          window.addEventListener('pointerup', up);
        }}
      />
      {chip ? <span className="vol-chip" style={{ left: chip.x + 12, top: chip.y - 24 }}>{Math.round(chip.volume * 100)}%{chip.volume === 0 ? ' (muted)' : ''}</span> : null}
    </>
  );
}

function ClipView({ clip, drag, pxPerFrame, fps, selected, flashing, onMove, onTrim }: {
  clip: Clip;
  drag: Drag | null;
  pxPerFrame: number;
  fps: number;
  selected: boolean;
  flashing: boolean;
  onMove: (e: ReactPointerEvent<HTMLDivElement>, clip: Clip) => void;
  onTrim: (e: ReactPointerEvent<HTMLDivElement>, clip: Clip, edge: 'start' | 'end') => void;
}) {
  let start = clip.startFrame;
  let end = clip.startFrame + clip.durationFrames;
  const inGroup = drag?.kind === 'move' && drag.ids.includes(clip.id);
  if (drag?.kind === 'move' && inGroup) {
    start = drag.id === clip.id ? drag.startFrame : clip.startFrame + drag.delta;
    end = start + clip.durationFrames;
  } else if (drag?.kind === 'trim' && drag.id === clip.id) {
    if (drag.edge === 'start') start = drag.frame;
    else end = drag.frame;
  }
  const color = clip.color ?? CLIP_COLORS[clip.kind];
  const editor = useEditor();
  const hasAudio = clip.kind === 'audio' || clip.kind === 'video';
  const peaks = useWaveform(`http://127.0.0.1:${editor.bridge.bootstrap.port}`, hasAudio ? clip.assetId : null);
  // Trimming the start edge slides the source window along with it (mirrors ProjectDoc.trimClip).
  const trimBefore = clip.kind !== 'component' ? clip.trimBefore + (drag?.id === clip.id && drag.kind === 'trim' && drag.edge === 'start' ? start - clip.startFrame : 0) : 0;
  const widthPx = Math.max(4, (end - start) * pxPerFrame);
  return (
    <div
      className={`clip kind-${clip.kind}${selected ? ' selected' : ''}${drag?.id === clip.id || inGroup ? ' dragging' : ''}${flashing ? ' flash' : ''}`}
      style={{ left: start * pxPerFrame, width: Math.max(4, (end - start) * pxPerFrame), ['--clip-color' as string]: color }}
      onPointerDown={(e) => onMove(e, clip)}
      onDoubleClick={(e) => {
        e.stopPropagation();
        const editorPanel = document.querySelector('.side-tabs button[data-panel="inspector"]') as HTMLButtonElement | null;
        editorPanel?.click();
      }}
      title={`${clip.name} · ${framesToTimecode(start, fps)} → ${framesToTimecode(end, fps)}`}
    >
      {hasAudio && peaks && peaks.length > 0 ? (
        <Waveform peaks={peaks} trimBefore={trimBefore} durationFrames={end - start} fps={fps} widthPx={widthPx} color={color} mode={clip.kind === 'audio' ? 'audio' : 'video'} />
      ) : hasAudio && peaks === null ? (
        <div className="wave" />
      ) : null}
      {clip.kind !== 'component' && clip.volumeKeyframes
        ? clip.volumeKeyframes.filter((k) => k.gain < 0.99).map((k, i) => <span key={i} className="vol-dot" style={{ left: k.frame * pxPerFrame }} />)
        : null}
      {clip.kind !== 'component' ? <VolumeBar clip={clip} /> : null}
      <span className="clip-name">{clip.name}</span>
      {clip.kind !== 'component' && clip.reframe ? <span className="clip-badge" title="auto-reframed">◱</span> : null}
      {clip.kind !== 'component' && clip.volumeKeyframes?.length ? <span className="clip-badge" title="volume automation">∿</span> : null}
      <span className="clip-len">{framesToTimecode(end - start, fps)}</span>
      <div className="handle l" onPointerDown={(e) => onTrim(e, clip, 'start')} />
      <div className="handle r" onPointerDown={(e) => onTrim(e, clip, 'end')} />
    </div>
  );
}

function GhostClip({ drag, pxPerFrame, clip, fps }: { drag: Extract<Drag, { kind: 'move' }>; pxPerFrame: number; clip: Clip; fps: number }) {
  const color = clip.color ?? CLIP_COLORS[clip.kind];
  return (
    <div className="clip dragging selected" style={{ left: drag.startFrame * pxPerFrame, width: Math.max(4, drag.duration * pxPerFrame), ['--clip-color' as string]: color }}>
      <span className="clip-name">{clip.name}</span>
      <span className="clip-len">{framesToTimecode(drag.duration, fps)}</span>
    </div>
  );
}
