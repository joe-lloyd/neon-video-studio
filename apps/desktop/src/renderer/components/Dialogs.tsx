import { useState } from 'react';
import { useEditor } from '../lib/context.ts';
import { kbdFor, type Kbd } from '../lib/kbd.ts';
import { useSelector } from '../lib/store.ts';
import { RenderControls, RenderJobs } from './SidePanels.tsx';

export function Dialogs() {
  const editor = useEditor();
  const dialog = useSelector(editor.ui, (u) => u.dialog);
  if (!dialog) return null;
  const close = () => editor.ui.set({ dialog: null });
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div className="panel modal">
        {dialog === 'render' ? (
          <>
            <h2>Render</h2>
            <RenderControls compact />
            <div className="panel-header" style={{ padding: '12px 0 6px' }}><span className="title">Jobs</span></div>
            <RenderJobs />
          </>
        ) : null}
        {dialog === 'room' ? <JoinRoomForm onDone={close} /> : null}
        {dialog === 'shortcuts' ? <Shortcuts /> : null}
        <div className="row" style={{ justifyContent: 'flex-end', marginTop: 14 }}>
          <button className="btn" onClick={close}>Close</button>
        </div>
      </div>
    </div>
  );
}

function JoinRoomForm({ onDone }: { onDone: () => void }) {
  const editor = useEditor();
  const [code, setCode] = useState('');
  const [hostUrl, setHostUrl] = useState('');
  const [password, setPassword] = useState('');
  return (
    <>
      <h2>Join room</h2>
      <div className="field"><label>Room code</label><input className="input mono" autoFocus value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} placeholder="K7PM-2XQD-9HRT" /></div>
      <div className="field"><label>Password (if set by the host)</label><input className="input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} /></div>
      <div className="field"><label>Host URL (optional)</label><input className="input mono" value={hostUrl} onChange={(e) => setHostUrl(e.target.value)} placeholder="ws://192.168.1.20:47611" /></div>
      <button className="btn cyan" disabled={!code.trim()} onClick={() => { void editor.joinRoom(code, password || undefined, hostUrl); onDone(); }}>Join</button>
    </>
  );
}

const shortcutRows = (k: Kbd): [string, string][] => [
  ['Space', 'Play / pause'],
  ['J / K / L', 'Back 1s / pause / forward 1s'],
  ['← / →', `Step one frame (${k.isMac ? '⇧' : 'Shift'} = one second)`],
  ['Home / End', 'Jump to start / end'],
  ['S', 'Split clip(s) under the playhead'],
  [k.isMac ? '⌫' : 'Del', 'Delete selection'],
  [`${k.mod('Z')} / ${k.shiftMod('Z')}`, 'Undo / redo (your own edits only)'],
  [k.mod('I'), 'Import media'],
  [k.mod('E'), 'Render'],
  [`${k.mod('S')} / ${k.shiftMod('S')}`, 'Save / Save As'],
  ['N', 'Toggle snapping'],
  ['+ / −', `Zoom timeline (${k.isMac ? '⌥' : 'Alt'}+wheel over timeline too)`],
  [k.mod('A'), 'Select all clips'],
  ['?', 'This list'],
];

function Shortcuts() {
  const editor = useEditor();
  const kbd = kbdFor(editor.bridge.bootstrap.platform);
  return (
    <>
      <h2>Keyboard shortcuts</h2>
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <tbody>
          {shortcutRows(kbd).map(([k, d]) => (
            <tr key={k}>
              <td style={{ padding: '4px 0', width: 130 }}><kbd>{k}</kbd></td>
              <td className="muted" style={{ padding: '4px 0' }}>{d}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}
