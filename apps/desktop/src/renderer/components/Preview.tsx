import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Player, type PlayerRef } from '@remotion/player';
import { TimelineComposition, type TimelineProps } from '@neon/remotion-workspace/composition';
import { useEditor } from '../lib/context.ts';
import { CanvasEditor } from './CanvasEditor.tsx';
import { useElementSize } from '../lib/hooks.ts';
import { kbdFor } from '../lib/kbd.ts';
import { useStoreValue } from '../lib/store.ts';

export function Preview() {
  const editor = useEditor();
  const kbd = kbdFor(editor.bridge.bootstrap.platform);
  const { project, durationFrames, ready } = useStoreValue(editor.project);
  const previewMuted = useStoreValue(editor.ui).previewMuted;
  const { frame, playing } = useStoreValue(editor.playhead);
  const [safe, setSafe] = useState(false);
  const playerRef = useRef<PlayerRef>(null);
  // The Player mounts only after the stage has been measured, so track mounting explicitly and
  // (re)bind everything when it appears — a ref alone never re-triggers effects.
  const [playerMounted, setPlayerMounted] = useState(false);
  const bindPlayer = useCallback((instance: PlayerRef | null) => {
    playerRef.current = instance;
    setPlayerMounted(instance !== null);
  }, []);
  const [stageRef, stage] = useElementSize<HTMLDivElement>();

  const inputProps = useMemo<TimelineProps>(
    () => ({ project, assetBaseUrl: `http://127.0.0.1:${editor.bridge.bootstrap.port}/assets`, assetQuery: '', render: null }),
    [project, editor],
  );

  // Fit the composition into the stage while preserving aspect ratio.
  const aspect = project.meta.width / project.meta.height;
  const pad = 16;
  let w = Math.max(0, stage.width - pad);
  let h = w / aspect;
  if (h > stage.height - pad) {
    h = Math.max(0, stage.height - pad);
    w = h * aspect;
  }

  useEffect(() => {
    const player = playerRef.current;
    if (!player) return;
    editor.player = {
      seekTo: (f) => player.seekTo(f),
      play: () => player.play(),
      pause: () => player.pause(),
      toggle: () => player.toggle(),
      getCurrentFrame: () => player.getCurrentFrame(),
    };
    const onFrame = (e: { detail: { frame: number } }) => editor.seek(e.detail.frame, { fromPlayer: true });
    const onPlay = () => editor.setPlaying(true);
    const onPause = () => editor.setPlaying(false);
    const onEnded = () => editor.setPlaying(false);
    player.addEventListener('frameupdate', onFrame);
    player.addEventListener('play', onPlay);
    player.addEventListener('pause', onPause);
    player.addEventListener('ended', onEnded);
    return () => {
      player.removeEventListener('frameupdate', onFrame);
      player.removeEventListener('play', onPlay);
      player.removeEventListener('pause', onPause);
      player.removeEventListener('ended', onEnded);
      editor.player = null;
    };
  }, [editor, ready, playerMounted]);

  useEffect(() => {
    const player = playerRef.current;
    if (!player) return;
    if (previewMuted) player.mute();
    else player.unmute();
  }, [previewMuted, playerMounted]);

  // WKWebView does not fetch <video> data until a seek happens, so the very first frame stays
  // black until the user scrubs. Nudge the player once media is available or changes.
  const assetKey = project.assets.map((a) => a.id).join(',');
  useEffect(() => {
    const player = playerRef.current;
    if (!player || !ready || durationFrames === 0) return;
    const t = setTimeout(() => {
      const f = player.getCurrentFrame();
      player.seekTo(Math.min(durationFrames - 1, f + 1));
      player.seekTo(f);
    }, 350);
    return () => clearTimeout(t);
  }, [ready, assetKey, durationFrames, playerMounted]);

  const empty = durationFrames === 0;
  return (
    <div className={`preview-stage${safe ? ' safe' : ''}${playing ? ' playing' : ''}`} ref={stageRef}>
      <div className="preview-chip">
        <span>{project.meta.width}×{project.meta.height} · {project.meta.fps} fps</span>
        <span>f {frame}</span>
        <button className={safe ? 'on' : ''} onClick={() => setSafe((v) => !v)} title="Toggle title/action safe areas">safe</button>
      </div>
      {ready && w > 0 ? (
        <div className="player-wrap" style={{ width: w, height: h, position: 'relative' }}>
          <CanvasEditor width={w} height={h} />
          <Player
            ref={bindPlayer}
            component={TimelineComposition}
            inputProps={inputProps}
            durationInFrames={Math.max(1, durationFrames)}
            fps={project.meta.fps}
            compositionWidth={project.meta.width}
            compositionHeight={project.meta.height}
            style={{ width: '100%', height: '100%' }}
            controls={false}
            clickToPlay={false}
            doubleClickToFullscreen
            showVolumeControls={false}
            spaceKeyToPlayOrPause={false}
            numberOfSharedAudioTags={6}
            acknowledgeRemotionLicense
          />
        </div>
      ) : null}
      {empty ? (
        <div className="preview-overlay">
          <div style={{ textAlign: 'center', lineHeight: 2 }}>
            {ready ? (
              <>
                EMPTY TIMELINE
                <br />
                <span style={{ fontSize: 11, letterSpacing: '0.05em', textTransform: 'none' }}>Import media ({kbd.mod('I')}), drop a template from the FX tab, or drive it with neon-cli</span>
              </>
            ) : (
              'SYNCING PROJECT…'
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}
