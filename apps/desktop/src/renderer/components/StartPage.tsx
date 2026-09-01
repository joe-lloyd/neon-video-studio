import { useEffect, useState } from 'react';
import { FolderOpen, NeonIcon, NeonLogo, Plus, X } from '@neon/icon-kit';
import { useEditor } from '../lib/context.ts';
import { useSelector } from '../lib/store.ts';


const SIZES = [
  { label: '1080p (16:9)', width: 1920, height: 1080 },
  { label: 'Vertical (9:16)', width: 1080, height: 1920 },
  { label: 'Square (1:1)', width: 1080, height: 1080 },
  { label: '4K (16:9)', width: 3840, height: 2160 },
];

function ago(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const m = Math.round(ms / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  return `${Math.round(h / 24)} d ago`;
}

/** Project overview: recent projects, create with an explicit save location, open anything. */
export function StartPage() {
  const editor = useEditor();
  const show = useSelector(editor.ui, (u) => u.showStart);
  const recent = useSelector(editor.ui, (u) => u.recentProjects);
  const [name, setName] = useState('');
  const [size, setSize] = useState(0);
  const [fps, setFps] = useState(30);
  const [dir, setDir] = useState<string | null>(null);

  useEffect(() => {
    if (show) void editor.refreshRecentProjects();
  }, [show, editor]);

  if (!show) return null;
  const canNative = editor.bridge.mode === 'electrobun';

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && editor.ui.set({ showStart: false })}>
      <div className="panel modal start-page" style={{ width: 760 }}>
        <div className="row between" style={{ marginBottom: 14 }}>
          <NeonLogo size={26} withText />
          <button className="btn icon ghost" onClick={() => editor.ui.set({ showStart: false })} title="Close (Esc)"><NeonIcon icon={X} size={14} /></button>
        </div>
        <div className="start-grid">
          <div>
            <h2>Recent projects</h2>
            {recent.length === 0 ? <p className="hint">Nothing yet — create one on the right.</p> : null}
            {recent.map((r) => (
              <div key={r.path} className="list-item" style={{ cursor: 'pointer' }} onClick={() => (r.current ? editor.ui.set({ showStart: false }) : void editor.openProjectPath(r.path))}>
                <NeonIcon icon={FolderOpen} size={16} tone={r.current ? 'magenta' : 'cyan'} />
                <div className="name">
                  <div>{r.name} {r.current ? <span className="pill magenta">open</span> : null}</div>
                  <div className="meta mono" title={r.path}>{r.path.replace(/^\/Users\/[^/]+/, '~')} · {ago(r.updatedAt)}</div>
                </div>
              </div>
            ))}
            {canNative ? (
              <button className="btn" style={{ marginTop: 10 }} onClick={() => void editor.bridge.request('openProjectDialog', {}).then((r) => r && editor.ui.set({ showStart: false })).catch((e: Error) => editor.toast('error', e.message))}>
                <NeonIcon icon={FolderOpen} size={14} tone="cyan" /> Open another project…
              </button>
            ) : null}
          </div>
          <div>
            <h2>New project</h2>
            <div className="field"><label>Name</label><input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Client video 01" autoFocus /></div>
            <div className="grid-2">
              <div className="field">
                <label>Format</label>
                <select className="select" value={size} onChange={(e) => setSize(Number(e.target.value))}>
                  {SIZES.map((s, i) => <option key={s.label} value={i}>{s.label}</option>)}
                </select>
              </div>
              <div className="field">
                <label>FPS</label>
                <select className="select" value={fps} onChange={(e) => setFps(Number(e.target.value))}>
                  {[24, 25, 30, 50, 60].map((f) => <option key={f} value={f}>{f}</option>)}
                </select>
              </div>
            </div>
            <div className="field">
              <label>Save location</label>
              <div className="row">
                <input className="input mono" readOnly value={dir ? dir.replace(/^\/Users\/[^/]+/, '~') : '~/.neon-video/projects (scratch — Save As later)'} title={dir ?? ''} />
                {canNative ? (
                  <button className="btn sm" onClick={() => void editor.bridge.request('chooseFolder', {}).then((d) => d && setDir(d))}>Choose…</button>
                ) : null}
                {dir ? <button className="btn icon ghost" onClick={() => setDir(null)}><NeonIcon icon={X} size={12} /></button> : null}
              </div>
            </div>
            <button
              className="btn magenta"
              style={{ width: '100%', justifyContent: 'center' }}
              onClick={() => void editor.createProject({ name: name.trim() || undefined, fps, width: SIZES[size]!.width, height: SIZES[size]!.height, dir: dir ?? undefined })}
            >
              <NeonIcon icon={Plus} size={14} tone="magenta" /> Create project
            </button>
            <p className="hint" style={{ marginTop: 10 }}>Projects are folders (<span className="mono">Name.neon</span>) with the media inside — copy them anywhere, open them on any machine.</p>
          </div>
        </div>
        <div className="row between" style={{ marginTop: 14, alignItems: 'center' }}>
          <span className="hint mono">v{editor.bridge.bootstrap.version}</span>
          <UpdateRow />
        </div>
      </div>
    </div>
  );
}

/** "Search for updates" + live status; the actual install button lives in the title bar pill. */
function UpdateRow() {
  const editor = useEditor();
  const update = useSelector(editor.ui, (u) => u.update);
  const label =
    update.phase === 'checking' ? 'Checking…'
    : update.phase === 'downloading' ? `Downloading ${Math.round((update.progress ?? 0) * 100)}%`
    : update.phase === 'installing' ? 'Restarting…'
    : 'Check for updates';
  return (
    <span className="row" style={{ gap: 8, alignItems: 'center' }}>
      {update.phase === 'available' ? (
        <button className="btn sm magenta" onClick={() => void editor.applyUpdate()}>⬆ Install {update.version} & restart</button>
      ) : (
        <button className="btn sm" disabled={update.phase === 'checking' || update.phase === 'downloading' || update.phase === 'installing'} onClick={() => void editor.checkForUpdates()}>
          {label}
        </button>
      )}
    </span>
  );
}
