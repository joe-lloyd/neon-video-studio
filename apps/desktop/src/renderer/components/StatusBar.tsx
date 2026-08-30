import { formatDuration } from '@neon/core';
import { useEditor } from '../lib/context.ts';
import { useStoreValue } from '../lib/store.ts';

export function StatusBar() {
  const editor = useEditor();
  const ui = useStoreValue(editor.ui);
  const { project, durationFrames } = useStoreValue(editor.project);
  const s = ui.session;
  const peers = s?.peers.filter((p) => !p.isLocal).length ?? 0;
  return (
    <footer className="statusbar">
      <span><span className={`dot ${s?.localConnected ? 'on' : 'warn'}`} />{s?.localSynced ? 'synced' : s?.localConnected ? 'syncing' : 'connecting'} · api :{editor.bridge.bootstrap.port}</span>
      <span>{project.meta.width}×{project.meta.height} @ {project.meta.fps}fps</span>
      <span>{formatDuration(durationFrames, project.meta.fps)} · {project.clips.length} clips · {project.assets.length} assets</span>
      {ui.room.role !== 'none' ? (
        <span><span className={`dot ${peers > 0 ? 'on' : 'warn'}`} />{ui.room.role} {ui.room.roomCode} · {peers} peer{peers === 1 ? '' : 's'} · rtc {s?.webrtcPeers ?? 0}{s?.lanConnected ? ' · lan' : ''}</span>
      ) : (
        <span><span className="dot off" />solo</span>
      )}
      {ui.lastActivity ? (
        <span className={`live-pulse ${ui.lastActivity.source}`} title={ui.lastActivity.action}>
          <span className="dot on" />
          {ui.lastActivity.source.toUpperCase()} · {ui.lastActivity.message}
        </span>
      ) : null}
      <span className="spacer" />
      <button className="link" onClick={() => editor.ui.set({ dialog: 'shortcuts' })}>shortcuts ?</button>
      <span>{ui.snapping ? 'snap on' : 'snap off'} · {ui.pxPerFrame.toFixed(2)} px/f</span>
      <span>v{editor.bridge.bootstrap.version} · {editor.bridge.mode}</span>
    </footer>
  );
}
