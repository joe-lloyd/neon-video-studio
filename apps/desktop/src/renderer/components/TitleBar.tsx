import { useState } from 'react';
import { Download, Maximize2, Minimize2, NeonIcon, NeonLogo, Radio, Upload, X } from '@neon/icon-kit';
import { useEditor } from '../lib/context.ts';
import { useStoreValue } from '../lib/store.ts';

export function TitleBar() {
  const editor = useEditor();
  const ui = useStoreValue(editor.ui);
  const [draft, setDraft] = useState<string | null>(null);
  const isMac = editor.bridge.bootstrap.platform === 'darwin';

  return (
    <header className={`titlebar${isMac ? '' : ' no-traffic-lights'}`}>
      <button className="btn ghost" style={{ padding: '2px 6px' }} title="Projects overview" onClick={() => editor.ui.set({ showStart: true })}>
        <NeonLogo size={20} withText />
      </button>
      <input
        className="project-name"
        value={draft ?? ui.projectName}
        onChange={(e) => setDraft(e.target.value)}
        onFocus={() => setDraft(ui.projectName)}
        onBlur={() => {
          if (draft !== null && draft !== ui.projectName) editor.renameProject(draft);
          setDraft(null);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
          if (e.key === 'Escape') {
            setDraft(null);
            (e.target as HTMLInputElement).blur();
          }
        }}
        spellCheck={false}
      />
      <span className={`save-state ${ui.saving}`}>{ui.saving === 'dirty' ? '● unsaved' : ui.saving === 'saved' ? 'autosaved' : ''}</span>
      {ui.projectPath ? <span className="hint mono" title={ui.projectPath}>{ui.projectPath.split('/').slice(-1)[0]}</span> : <span className="hint">scratch project — Save to choose a folder</span>}
      <div className="spacer" />
      {ui.room.role !== 'none' ? (
        <button className={`pill ${ui.room.role === 'host' ? 'magenta' : 'cyan'}`} onClick={() => editor.setPanel('peers')} title="Room">
          <NeonIcon icon={Radio} size={11} tone={ui.room.role === 'host' ? 'magenta' : 'cyan'} /> {ui.room.roomCode}
        </button>
      ) : null}
      <button className="btn sm" onClick={() => void editor.importMedia()} title="Import media (⌘I)">
        <NeonIcon icon={Upload} size={14} tone="cyan" /> Import
      </button>
      <button className="btn sm magenta" onClick={() => editor.ui.set({ dialog: 'render' })} title="Render (⌘E)">
        <NeonIcon icon={Download} size={14} tone="magenta" /> Render
      </button>
      {!isMac ? (
        <div className="window-controls">
          <button onClick={() => void editor.bridge.request('windowCommand', { command: 'minimize' })}><NeonIcon icon={Minimize2} size={12} /></button>
          <button onClick={() => void editor.bridge.request('windowCommand', { command: 'maximize' })}><NeonIcon icon={Maximize2} size={12} /></button>
          <button onClick={() => void editor.bridge.request('windowCommand', { command: 'close' })}><NeonIcon icon={X} size={12} tone="red" /></button>
        </div>
      ) : null}
    </header>
  );
}
