import { useState } from 'react';
import { Download, Maximize2, Minimize2, NeonIcon, NeonLogo, Radio, Upload, X } from '@neon/icon-kit';
import { useEditor } from '../lib/context.ts';
import { kbdFor } from '../lib/kbd.ts';
import { useSelector, useStoreValue } from '../lib/store.ts';

/** Appears when the main process found an update; one click downloads, installs and restarts. */
function UpdatePill() {
  const editor = useEditor();
  const update = useSelector(editor.ui, (u) => u.update);
  if (update.phase === 'downloading') return <span className="pill cyan">update {Math.round((update.progress ?? 0) * 100)}%</span>;
  if (update.phase === 'installing') return <span className="pill cyan">restarting…</span>;
  if (update.phase !== 'available') return null;
  return (
    <button className="pill magenta" onClick={() => void editor.applyUpdate()} title={`Version ${update.version} is ready — install and restart now`}>
      ⬆ Update {update.version}
    </button>
  );
}

/** Edit (preview, timeline, panels) or Script (the plan and its notes). The count is open notes. */
function ViewSwitch() {
  const editor = useEditor();
  const view = useSelector(editor.ui, (u) => u.view);
  const open = useStoreValue(editor.project).project.script.notes.filter((n) => !n.resolved).length;
  return (
    <div className="view-switch">
      <button className={view === 'edit' ? 'on' : ''} onClick={() => editor.ui.set({ view: 'edit' })}>
        Edit
      </button>
      <button className={view === 'script' ? 'on' : ''} onClick={() => editor.ui.set({ view: 'script' })} title={open ? `${open} open note${open === 1 ? '' : 's'}` : 'The script and its review notes'}>
        Script{open ? <span className="count">{open}</span> : null}
      </button>
    </div>
  );
}

export function TitleBar() {
  const editor = useEditor();
  const ui = useStoreValue(editor.ui);
  const [draft, setDraft] = useState<string | null>(null);
  const kbd = kbdFor(editor.bridge.bootstrap.platform);
  const isMac = kbd.isMac;

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
      <ViewSwitch />
      <span className={`save-state ${ui.saving}`}>{ui.saving === 'dirty' ? '● unsaved' : ui.saving === 'saved' ? 'autosaved' : ''}</span>
      {ui.projectPath ? <span className="hint mono" title={ui.projectPath}>{ui.projectPath.split('/').slice(-1)[0]}</span> : <span className="hint">scratch project — Save to choose a folder</span>}
      <div className="spacer" />
      {ui.room.role !== 'none' ? (
        <button className={`pill ${ui.room.role === 'host' ? 'magenta' : 'cyan'}`} onClick={() => editor.setPanel('peers')} title="Room">
          <NeonIcon icon={Radio} size={11} tone={ui.room.role === 'host' ? 'magenta' : 'cyan'} /> {ui.room.roomCode}
        </button>
      ) : null}
      <UpdatePill />
      <button className="btn sm" onClick={() => void editor.importMedia()} title={`Import media (${kbd.mod('I')})`}>
        <NeonIcon icon={Upload} size={14} tone="cyan" /> Import
      </button>
      <button className="btn sm magenta" onClick={() => editor.ui.set({ dialog: 'render' })} title={`Render (${kbd.mod('E')})`}>
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
