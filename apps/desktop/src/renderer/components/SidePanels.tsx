import { useState } from 'react';
import {
  CLIP_COLORS,
  RENDER_PRESETS,
  formatDuration,
  framesToTimecode,
  listTemplates,
  parseTimecode,
  templateJsonSchema,
  type Asset,
  type Clip,
  type RenderJob,
} from '@neon/core';
import {
  BarChart3,
  Check,
  Clapperboard,
  Copy,
  Download,
  Film,
  Flower2,
  FolderOpen,
  Hash,
  ImageIcon,
  Layers,
  Loader2,
  Music,
  NeonIcon,
  Terminal,
  CircleDot,
  PaintBucket,
  Plus,
  Radio,
  Sparkles,
  Stamp,
  Tag,
  Timer,
  Trash2,
  Type,
  Upload,
  Users,
  X,
} from '@neon/icon-kit';
import type { LucideIcon } from 'lucide-react';
import { useEditor } from '../lib/context.ts';
import { AiPanel } from './AiPanel.tsx';
import { ScriptPanel } from './ScriptPanel.tsx';
import { useSelector, useStoreValue, type Panel } from '../lib/store.ts';

const TABS: { id: Panel; label: string; icon: LucideIcon }[] = [
  { id: 'assets', label: 'Media', icon: Film },
  { id: 'templates', label: 'FX', icon: Clapperboard },
  { id: 'inspector', label: 'Inspect', icon: Layers },
  { id: 'peers', label: 'Room', icon: Users },
  { id: 'ai', label: 'AI', icon: Sparkles },
  { id: 'script', label: 'Script', icon: Type },
  { id: 'renders', label: 'Render', icon: Download },
  { id: 'activity', label: 'Live', icon: Terminal },
];

const SOURCE_LABEL: Record<string, { label: string; tone: 'magenta' | 'cyan' | 'green' | 'amber' | 'muted' | 'white' }> = {
  cli: { label: 'CLI', tone: 'cyan' },
  ui: { label: 'YOU', tone: 'magenta' },
  peer: { label: 'PEER', tone: 'green' },
  render: { label: 'RENDER', tone: 'amber' },
  room: { label: 'ROOM', tone: 'green' },
  system: { label: 'SYS', tone: 'muted' },
};

export function SidePanels() {
  const editor = useEditor();
  const panel = useSelector(editor.ui, (u) => u.panel);
  return (
    <aside className="side">
      <div
        className="side-resize"
        title="Drag to resize"
        onPointerDown={(e) => {
          const startX = e.clientX;
          const startW = editor.ui.get().sidebarWidth;
          const el = e.currentTarget;
          el.classList.add('active');
          el.setPointerCapture(e.pointerId);
          const move = (ev: PointerEvent) => editor.ui.set({ sidebarWidth: Math.min(560, Math.max(260, startW + (startX - ev.clientX))) });
          const up = () => {
            el.classList.remove('active');
            window.removeEventListener('pointermove', move);
            window.removeEventListener('pointerup', up);
          };
          window.addEventListener('pointermove', move);
          window.addEventListener('pointerup', up);
        }}
      />
      <div className="panel" style={{ flex: 1 }}>
        <div className="side-tabs">
          {TABS.map((t) => (
            <button key={t.id} data-panel={t.id} className={panel === t.id ? 'active' : ''} onClick={() => editor.setPanel(t.id)}>
              <NeonIcon icon={t.icon} size={15} tone={panel === t.id ? 'magenta' : 'muted'} />
              {t.label}
            </button>
          ))}
        </div>
        {panel === 'assets' ? <AssetsPanel /> : null}
        {panel === 'templates' ? <TemplatesPanel /> : null}
        {panel === 'inspector' ? <InspectorPanel /> : null}
        {panel === 'peers' ? <PeersPanel /> : null}
        {panel === 'renders' ? <RendersPanel /> : null}
        {panel === 'activity' ? <ActivityPanel /> : null}
        {panel === 'ai' ? <AiPanel /> : null}
        {panel === 'script' ? <ScriptPanel /> : null}
      </div>
    </aside>
  );
}

// ---- media ----------------------------------------------------------------------------

const ASSET_ICON: Record<Asset['kind'], LucideIcon> = { video: Film, audio: Music, image: ImageIcon };

function AssetsPanel() {
  const editor = useEditor();
  const { project } = useStoreValue(editor.project);
  const [ripUrl, setRipUrl] = useState('');
  const ripping = useSelector(editor.ui, (u) => u.aiJobs.some((j) => j.op === 'rip' && (j.status === 'running' || j.status === 'queued')));
  const startRip = () => {
    const url = ripUrl.trim();
    if (!/^https?:\/\//.test(url)) return editor.toast('error', 'Paste a full video URL (https://…)');
    void editor.runAi('rip', { url, quality: '1080' });
    setRipUrl('');
  };
  return (
    <>
      <div className="panel-header">
        <span className="title">Media · {project.assets.length}</span>
        <button className="btn sm cyan" onClick={() => void editor.importMedia()}>
          <NeonIcon icon={Upload} size={13} tone="cyan" /> Import
        </button>
      </div>
      <div className="row" style={{ padding: '8px 10px 0', gap: 6 }}>
        <input
          className="input mono"
          placeholder="Paste a YouTube / video URL to rip…"
          value={ripUrl}
          onChange={(e) => setRipUrl(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && startRip()}
          disabled={ripping}
        />
        <button className="btn sm magenta" disabled={ripping || !ripUrl.trim()} onClick={startRip} title="Download with yt-dlp into the media library">
          {ripping ? '…' : 'Rip'}
        </button>
      </div>
      {ripping ? <p className="hint" style={{ padding: '4px 12px 0' }}>Downloading — progress in the AI tab / Live feed.</p> : null}
      <div className="panel-body">
        {project.assets.length === 0 ? (
          <div className="empty">
            <strong>No media yet.</strong>
            <br />
            Import video, audio or images, then drag them onto the timeline.
            <br />
            <span className="hint">CLI: neon-cli assets import ./clip.mp4 --at 0</span>
          </div>
        ) : (
          project.assets.map((a) => (
            <div
              key={a.id}
              className="list-item"
              draggable
              onDragStart={(e) => {
                e.dataTransfer.setData('application/x-neon-asset', a.id);
                e.dataTransfer.effectAllowed = 'copy';
              }}
              onDoubleClick={() => editor.insertAsset(a.id)}
              title={`${a.name}\nsha256 ${a.id}\nDouble-click to add at the playhead`}
            >
              <NeonIcon icon={ASSET_ICON[a.kind]} size={18} tone={a.kind === 'video' ? 'magenta' : a.kind === 'audio' ? 'cyan' : 'white'} />
              <div className="name">
                <div>{a.name}</div>
                <div className="meta mono">
                  {a.durationFrames ? framesToTimecode(a.durationFrames, project.meta.fps) : a.kind}
                  {a.width ? ` · ${a.width}×${a.height}` : ''} · {(a.size / 1e6).toFixed(1)} MB
                </div>
              </div>
              <div className="actions">
                <button className="btn icon ghost" title="Add at playhead" onClick={() => editor.insertAsset(a.id)}><NeonIcon icon={Plus} size={13} tone="cyan" /></button>
                <button className="btn icon ghost" title="Remove asset and its clips" onClick={() => editor.removeAsset(a.id)}><NeonIcon icon={Trash2} size={13} tone="red" /></button>
              </div>
            </div>
          ))
        )}
      </div>
    </>
  );
}

// ---- templates ------------------------------------------------------------------------

const TEMPLATE_ICON: Record<string, LucideIcon> = {
  TextOverlay: Type,
  LowerThird: Clapperboard,
  TitleCard: Layers,
  Countdown: Timer,
  ProgressBar: BarChart3,
  Watermark: Stamp,
  SolidColor: PaintBucket,
  BobaTitle: Type,
  BobaLowerThird: Clapperboard,
  BobaTag: Tag,
  BobaBlob: Flower2,
  BobaMorphLoader: Loader2,
};

function TemplatesPanel() {
  const editor = useEditor();
  return (
    <>
      <div className="panel-header"><span className="title">React templates</span></div>
      <div className="panel-body">
        {listTemplates().map((t) => (
          <div
            key={t.name}
            className="list-item"
            draggable
            onDragStart={(e) => {
              e.dataTransfer.setData('application/x-neon-template', t.name);
              e.dataTransfer.effectAllowed = 'copy';
            }}
            onClick={() => editor.insertTemplate(t.name)}
            title="Click to add at the playhead, or drag onto an FX track"
          >
            <NeonIcon icon={TEMPLATE_ICON[t.name] ?? Sparkles} size={18} tone="green" />
            <div className="name">
              <div>{t.label} <span className="hint mono">{t.name}</span></div>
              <div className="meta">{t.description} · {t.defaultDurationSeconds}s</div>
            </div>
          </div>
        ))}
        <p className="hint" style={{ marginTop: 12 }}>
          Add your own: create an FX pack in <span className="mono">apps/remotion-workspace/src/templates/packs</span> — see <span className="mono">docs/fx-packs.md</span>.
        </p>
      </div>
    </>
  );
}

// ---- inspector ------------------------------------------------------------------------

function TimecodeField({ label, frames, fps, onChange, min = 0 }: { label: string; frames: number; fps: number; onChange: (f: number) => void; min?: number }) {
  const [draft, setDraft] = useState<string | null>(null);
  const commit = () => {
    if (draft === null) return;
    try {
      const f = parseTimecode(draft, fps);
      if (f >= min) onChange(f);
    } catch {
      /* ignore invalid */
    }
    setDraft(null);
  };
  return (
    <div className="field">
      <label>{label}</label>
      <input
        className="input mono"
        value={draft ?? framesToTimecode(frames, fps)}
        onChange={(e) => setDraft(e.target.value)}
        onFocus={() => setDraft(framesToTimecode(frames, fps))}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit();
          if (e.key === 'Escape') setDraft(null);
        }}
      />
    </div>
  );
}

interface SchemaProp {
  type?: string | string[];
  enum?: unknown[];
  description?: string;
  minimum?: number;
  maximum?: number;
  default?: unknown;
}

function PropField({ name, schema, value, onChange }: { name: string; schema: SchemaProp; value: unknown; onChange: (v: unknown) => void }) {
  const type = Array.isArray(schema.type) ? schema.type[0] : schema.type;
  const isColor = /color/i.test(name) && type === 'string';
  if (schema.enum) {
    return (
      <div className="field">
        <label>{name}</label>
        <select className="select" value={String(value ?? '')} onChange={(e) => onChange(e.target.value)}>
          {schema.enum.map((o) => (
            <option key={String(o)} value={String(o)}>{String(o)}</option>
          ))}
        </select>
      </div>
    );
  }
  if (type === 'boolean') {
    return (
      <div className="field">
        <label className="row"><input type="checkbox" checked={Boolean(value)} onChange={(e) => onChange(e.target.checked)} /> {name}</label>
      </div>
    );
  }
  if (type === 'number' || type === 'integer') {
    const isRange = schema.minimum !== undefined && schema.maximum !== undefined && schema.maximum - schema.minimum <= 1;
    return (
      <div className="field">
        <label>{name}{isRange ? ` · ${Number(value).toFixed(2)}` : ''}</label>
        {isRange ? (
          <input type="range" min={schema.minimum} max={schema.maximum} step={0.01} value={Number(value ?? 0)} onChange={(e) => onChange(Number(e.target.value))} />
        ) : (
          <input className="input mono" type="number" min={schema.minimum} max={schema.maximum} step={type === 'integer' ? 1 : 'any'} value={Number(value ?? 0)} onChange={(e) => onChange(type === 'integer' ? Math.round(Number(e.target.value)) : Number(e.target.value))} />
        )}
      </div>
    );
  }
  if (isColor) {
    const hex = /^#[0-9a-f]{6}$/i.test(String(value)) ? String(value) : '#ffffff';
    return (
      <div className="field">
        <label>{name}</label>
        <div className="row">
          <input type="color" value={hex} onChange={(e) => onChange(e.target.value)} style={{ width: 34, height: 28, padding: 0, border: 'none', background: 'transparent' }} />
          <input className="input mono" value={String(value ?? '')} onChange={(e) => onChange(e.target.value)} />
        </div>
      </div>
    );
  }
  const long = name === 'text' || String(value ?? '').length > 40;
  return (
    <div className="field">
      <label>{name}</label>
      {long ? (
        <textarea className="textarea" rows={3} value={String(value ?? '')} onChange={(e) => onChange(e.target.value)} />
      ) : (
        <input className="input" value={String(value ?? '')} onChange={(e) => onChange(e.target.value)} />
      )}
    </div>
  );
}

function InspectorPanel() {
  const editor = useEditor();
  const { project } = useStoreValue(editor.project);
  const selection = useSelector(editor.ui, (u) => u.selection);
  const clip = project.clips.find((c) => c.id === selection[0]);
  const fps = project.meta.fps;

  if (!clip) {
    return (
      <>
        <div className="panel-header"><span className="title">Project</span></div>
        <div className="panel-body">
          <div className="field"><label>Name</label><input className="input" defaultValue={project.meta.name} key={project.meta.name} onBlur={(e) => editor.renameProject(e.target.value)} /></div>
          <div className="grid-2">
            <div className="field"><label>Width</label><input className="input mono" type="number" defaultValue={project.meta.width} key={`w${project.meta.width}`} onBlur={(e) => editor.doc.updateMeta({ width: Math.max(16, Math.round(Number(e.target.value) / 2) * 2) })} /></div>
            <div className="field"><label>Height</label><input className="input mono" type="number" defaultValue={project.meta.height} key={`h${project.meta.height}`} onBlur={(e) => editor.doc.updateMeta({ height: Math.max(16, Math.round(Number(e.target.value) / 2) * 2) })} /></div>
            <div className="field"><label>FPS</label><input className="input mono" type="number" defaultValue={project.meta.fps} key={`f${project.meta.fps}`} onBlur={(e) => editor.doc.updateMeta({ fps: Math.max(1, Math.min(240, Math.round(Number(e.target.value)))) })} /></div>
            <div className="field"><label>Background</label><input className="input mono" defaultValue={project.meta.background} key={project.meta.background} onBlur={(e) => editor.doc.updateMeta({ background: e.target.value })} /></div>
          </div>
          <p className="hint">Select a clip on the timeline to edit its properties. Changing fps rescales nothing — frame positions are kept as-is.</p>
          <p className="hint mono" style={{ wordBreak: 'break-all' }}>id {project.meta.id}</p>
        </div>
      </>
    );
  }

  const asset = clip.kind !== 'component' ? project.assets.find((a) => a.id === clip.assetId) : undefined;
  const schema = clip.kind === 'component' ? (templateJsonSchema(clip.componentName) as { properties?: Record<string, SchemaProp> }) : null;

  return (
    <>
      <div className="panel-header">
        <span className="kind" style={{ width: 8, height: 8, borderRadius: 2, background: clip.color ?? CLIP_COLORS[clip.kind] }} />
        <span className="title">{clip.kind === 'component' ? clip.componentName : clip.kind}</span>
        <span className="hint mono">{clip.id.slice(-8)}</span>
      </div>
      <div className="panel-body">
        <div className="field"><label>Name</label><input className="input" key={clip.id + clip.name} defaultValue={clip.name} onBlur={(e) => e.target.value !== clip.name && editor.updateClip(clip.id, { name: e.target.value })} /></div>
        <div className="grid-2">
          <TimecodeField label="Start" frames={clip.startFrame} fps={fps} onChange={(f) => editor.moveClip(clip.id, f)} />
          <TimecodeField label="Duration" frames={clip.durationFrames} fps={fps} onChange={(f) => f > 0 && editor.updateClip(clip.id, { durationFrames: f })} min={1} />
        </div>
        {clip.kind !== 'component' ? (
          <>
            {clip.kind !== 'image' ? <TimecodeField label="Source in (trim before)" frames={clip.trimBefore} fps={fps} onChange={(f) => editor.updateClip(clip.id, { trimBefore: f })} /> : null}
            {clip.kind !== 'image' ? (
              <div className="field">
                <label>Volume · {Math.round(clip.volume * 100)}%</label>
                <input type="range" min={0} max={2} step={0.01} value={clip.volume} onChange={(e) => editor.updateClip(clip.id, { volume: Number(e.target.value) })} />
              </div>
            ) : null}
            {clip.kind !== 'audio' ? (
              <div className="field">
                <label>Fit</label>
                <select className="select" value={clip.fit} onChange={(e) => editor.updateClip(clip.id, { fit: e.target.value as Clip extends { fit: infer F } ? F : never })}>
                  <option value="contain">contain</option>
                  <option value="cover">cover</option>
                  <option value="fill">fill</option>
                </select>
              </div>
            ) : null}
            <div className="grid-2">
              <TimecodeField label="Fade in" frames={clip.fadeIn} fps={fps} onChange={(f) => editor.updateClip(clip.id, { fadeIn: f })} />
              <TimecodeField label="Fade out" frames={clip.fadeOut} fps={fps} onChange={(f) => editor.updateClip(clip.id, { fadeOut: f })} />
            </div>
            {asset ? (
              <p className="hint mono" style={{ wordBreak: 'break-all' }}>
                {asset.name} · {asset.width ? `${asset.width}×${asset.height} · ` : ''}{asset.durationFrames ? formatDuration(asset.durationFrames, fps) : ''}
                <br />sha256 {asset.id.slice(0, 16)}…
              </p>
            ) : (
              <p className="hint" style={{ color: 'var(--danger)' }}>Asset missing from project.</p>
            )}
          </>
        ) : (
          <>
            {Object.entries(schema?.properties ?? {}).map(([name, prop]) => (
              <PropField key={name} name={name} schema={prop} value={clip.props[name]} onChange={(v) => editor.updateClip(clip.id, { props: { [name]: v } })} />
            ))}
          </>
        )}
        {clip.kind !== 'audio' ? (
          <>
            <div className="panel-header" style={{ padding: '10px 0 6px' }}><span className="title">Canvas & animation</span></div>
            <div className="grid-2">
              <div className="field"><label>Position X · %</label><input className="input mono" type="number" step={1} value={Math.round((clip.transform?.x ?? 0.5) * 100)} onChange={(e) => editor.setTransform(clip.id, { x: Number(e.target.value) / 100, y: clip.transform?.y ?? 0.5, scale: clip.transform?.scale ?? 1 })} /></div>
              <div className="field"><label>Position Y · %</label><input className="input mono" type="number" step={1} value={Math.round((clip.transform?.y ?? 0.5) * 100)} onChange={(e) => editor.setTransform(clip.id, { x: clip.transform?.x ?? 0.5, y: Number(e.target.value) / 100, scale: clip.transform?.scale ?? 1 })} /></div>
            </div>
            <div className="field">
              <label>Scale · {Math.round((clip.transform?.scale ?? 1) * 100)}% {clip.transform ? <button className="btn sm ghost" onClick={() => editor.setTransform(clip.id, null)}>reset</button> : null}</label>
              <input type="range" min={0.05} max={3} step={0.01} value={clip.transform?.scale ?? 1} onChange={(e) => editor.setTransform(clip.id, { x: clip.transform?.x ?? 0.5, y: clip.transform?.y ?? 0.5, scale: Number(e.target.value) })} />
            </div>
            <div className="grid-2">
              <AnimationField label="Animate in" value={clip.animateIn} onChange={(a) => editor.updateClip(clip.id, { animateIn: a })} fps={fps} />
              <AnimationField label="Animate out" value={clip.animateOut} onChange={(a) => editor.updateClip(clip.id, { animateOut: a })} fps={fps} />
            </div>
            <p className="hint">Drag the element in the preview to position it (snaps to centre/margins/other elements; hold ⌘ to disable). Corners scale, double-click resets.</p>
          </>
        ) : null}
        <div className="row" style={{ marginTop: 8, flexWrap: 'wrap' }}>
          <button className="btn sm" onClick={() => editor.seek(clip.startFrame)}>Go to start</button>
          {clip.kind === 'video' ? (
            <button className="btn sm" title="Copy the audio to an audio track and mute this clip's own sound" onClick={() => editor.detachAudio(clip.id)}>
              Detach audio
            </button>
          ) : null}
          <button className="btn sm danger" onClick={() => editor.deleteSelection()}><NeonIcon icon={Trash2} size={13} tone="red" /> Delete</button>
        </div>
      </div>
    </>
  );
}

function AnimationField({ label, value, onChange, fps }: { label: string; value?: { type: string; durationFrames: number }; onChange: (a: { type: 'fade' | 'slide-up' | 'slide-down' | 'slide-left' | 'slide-right' | 'pop'; durationFrames: number } | null) => void; fps: number }) {
  return (
    <div className="field">
      <label>{label}</label>
      <div className="row">
        <select
          className="select"
          value={value?.type ?? 'none'}
          onChange={(e) => onChange(e.target.value === 'none' ? null : { type: e.target.value as 'fade', durationFrames: value?.durationFrames ?? Math.round(fps * 0.4) })}
        >
          <option value="none">none</option>
          <option value="fade">fade</option>
          <option value="slide-up">slide up</option>
          <option value="slide-down">slide down</option>
          <option value="slide-left">slide left</option>
          <option value="slide-right">slide right</option>
          <option value="pop">pop</option>
        </select>
        {value ? <input className="input mono" style={{ width: 62 }} type="number" min={1} value={value.durationFrames} title="frames" onChange={(e) => onChange({ type: value.type as 'fade', durationFrames: Math.max(1, Math.round(Number(e.target.value))) })} /> : null}
      </div>
    </div>
  );
}

// ---- peers ----------------------------------------------------------------------------

function PeersPanel() {
  const editor = useEditor();
  const ui = useStoreValue(editor.ui);
  const [code, setCode] = useState('');
  const [hostUrl, setHostUrl] = useState('');
  const [password, setPassword] = useState('');
  const [copied, setCopied] = useState(false);
  const s = ui.session;
  const room = ui.room;

  return (
    <>
      <div className="panel-header"><span className="title">Room · P2P sync</span>{room.role !== 'none' ? <span className={`pill ${room.role === 'host' ? 'magenta' : 'cyan'}`}>{room.role}</span> : null}</div>
      <div className="panel-body">
        {room.role === 'none' ? (
          <>
            <p className="hint">Host a room to let other machines on your network edit this project live (Yjs CRDT over WebRTC; signaling + asset replication run inside this app — no cloud).</p>
            <div className="field"><label>Optional password</label><input className="input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="encrypts signaling" /></div>
            <button className="btn magenta" style={{ width: '100%', justifyContent: 'center' }} onClick={() => void editor.hostRoom(password || undefined)}>
              <NeonIcon icon={Radio} size={14} tone="magenta" /> Host room
            </button>
            <hr style={{ border: 0, borderTop: '1px solid var(--border-subtle)', margin: '16px 0' }} />
            <div className="field"><label>Room code</label><input className="input mono" value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} placeholder="K7PM-2XQD-9HRT" /></div>
            <div className="field"><label>Host URL (optional, if discovery fails)</label><input className="input mono" value={hostUrl} onChange={(e) => setHostUrl(e.target.value)} placeholder="ws://192.168.1.20:47611" /></div>
            <button className="btn cyan" style={{ width: '100%', justifyContent: 'center' }} disabled={!code.trim()} onClick={() => void editor.joinRoom(code, password || undefined, hostUrl)}>
              <NeonIcon icon={Users} size={14} tone="cyan" /> Join room
            </button>
            <p className="hint" style={{ marginTop: 10 }}>Joining replaces the open project with the host's (your current project stays saved on disk).</p>
          </>
        ) : (
          <>
            <div className="field">
              <label>Room code</label>
              <div className="row">
                <input className="input mono glow-m" readOnly value={room.roomCode} style={{ fontSize: 16, letterSpacing: 2, color: 'var(--magenta)' }} />
                <button className="btn icon" title="Copy" onClick={() => { void navigator.clipboard.writeText(room.roomCode); setCopied(true); setTimeout(() => setCopied(false), 1200); }}>
                  <NeonIcon icon={copied ? Check : Copy} size={14} tone={copied ? 'green' : 'white'} />
                </button>
              </div>
            </div>
            {room.role === 'host' ? <p className="hint mono">LAN {room.lanUrl}</p> : <p className="hint mono">host {room.hostUrl}</p>}
            <div className="row" style={{ gap: 6, flexWrap: 'wrap', margin: '8px 0' }}>
              <span className={`pill ${s?.localSynced ? 'green' : ''}`}>local {s?.localSynced ? 'synced' : '…'}</span>
              <span className={`pill ${s && s.webrtcPeers > 0 ? 'cyan' : ''}`}>webrtc {s?.webrtcPeers ?? 0}</span>
              {room.role === 'guest' ? <span className={`pill ${s?.lanConnected ? 'green' : ''}`}>lan ws {s?.lanConnected ? 'on' : 'off'}</span> : null}
            </div>
            <div className="panel-header" style={{ padding: '6px 0' }}><span className="title">Peers · {s?.peers.length ?? 0}</span></div>
            {(s?.peers ?? []).map((p) => (
              <div key={p.clientId} className="list-item" style={{ cursor: 'default' }}>
                <span className="peer-swatch" style={{ background: p.color, color: p.color }} />
                <div className="name">
                  <div>{p.name} {p.isLocal ? <span className="hint">(you)</span> : null}</div>
                  <div className="meta mono">playhead {framesToTimecode(p.playheadFrame, editor.fps)}{p.selection.length ? ` · ${p.selection.length} selected` : ''}</div>
                </div>
              </div>
            ))}
            <button className="btn danger" style={{ width: '100%', justifyContent: 'center', marginTop: 12 }} onClick={() => void editor.leaveRoom()}>
              <NeonIcon icon={X} size={14} tone="red" /> Leave room
            </button>
            <p className="hint" style={{ marginTop: 10 }}>CLI on another machine: <span className="mono">neon-cli room join {room.roomCode}</span></p>
          </>
        )}
        <hr style={{ border: 0, borderTop: '1px solid var(--border-subtle)', margin: '16px 0' }} />
        <div className="field">
          <label>Your display name</label>
          <input className="input" defaultValue={editor.bridge.bootstrap.peerName} onBlur={(e) => { const name = e.target.value.trim(); if (name) { editor.session.setPresence({ name }); void editor.bridge.request('setPeerName', { name }).catch(() => undefined); } }} />
        </div>
      </div>
    </>
  );
}

// ---- renders --------------------------------------------------------------------------

export function RenderControls({ compact = false }: { compact?: boolean }) {
  const editor = useEditor();
  const { project, durationFrames } = useStoreValue(editor.project);
  const [preset, setPreset] = useState('project');
  const [output, setOutput] = useState('');
  const presets = [{ id: 'project', label: `Project · ${project.meta.width}×${project.meta.height} @ ${project.meta.fps}` }, ...RENDER_PRESETS.map((p) => ({ id: p.id, label: `${p.label} — ${p.description}` }))];
  return (
    <>
      <div className="field">
        <label>Preset</label>
        <select className="select" value={preset} onChange={(e) => setPreset(e.target.value)}>
          {presets.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
        </select>
      </div>
      <div className="field">
        <label>Output file (optional)</label>
        <input className="input mono" value={output} onChange={(e) => setOutput(e.target.value)} placeholder="~/.neon-video/renders/<auto>.mp4" />
      </div>
      <button className="btn magenta" style={{ width: '100%', justifyContent: 'center' }} disabled={durationFrames === 0} onClick={() => void editor.startRender(preset, output.trim() || undefined)}>
        <NeonIcon icon={Download} size={14} tone="magenta" /> Render {formatDuration(durationFrames, project.meta.fps)} · H.264 MP4
      </button>
      {!compact ? <p className="hint" style={{ marginTop: 8 }}>Rendering runs in a separate Node worker via @remotion/renderer (headless Chrome + FFmpeg). The first render bundles the Remotion project and downloads Chrome Headless Shell — expect a minute.</p> : null}
    </>
  );
}

function statusTone(status: RenderJob['status']): string {
  return status === 'done' ? 'green' : status === 'failed' ? 'red' : status === 'cancelled' ? '' : 'cyan';
}

export function RenderJobs() {
  const editor = useEditor();
  const renders = useSelector(editor.ui, (u) => u.renders);
  if (renders.length === 0) return <div className="empty">No renders yet.</div>;
  return (
    <>
      {renders.map((job) => (
        <div key={job.id} className="list-item" style={{ cursor: 'default', flexDirection: 'column', alignItems: 'stretch', gap: 6 }}>
          <div className="row between">
            <span className="mono" style={{ fontSize: 11 }}>{job.outputPath.split('/').slice(-1)[0]}</span>
            <span className={`pill ${statusTone(job.status)}`}>{job.status}</span>
          </div>
          <div className="progress"><div style={{ width: `${Math.round(job.progress * 100)}%` }} /></div>
          <div className="row between hint mono">
            <span>{job.presetId} · {job.renderedFrames}/{job.totalFrames || '?'} frames</span>
            <span className="row" style={{ gap: 4 }}>
              {job.status === 'done' ? <button className="btn sm ghost" onClick={() => void editor.bridge.request('revealPath', { path: job.outputPath }).catch(() => undefined)}><NeonIcon icon={FolderOpen} size={12} tone="cyan" /> Reveal</button> : null}
              {job.status === 'rendering' || job.status === 'bundling' || job.status === 'queued' ? <button className="btn sm ghost" onClick={() => void editor.cancelRender(job.id)}><NeonIcon icon={X} size={12} tone="red" /> Cancel</button> : null}
            </span>
          </div>
          {job.error ? <div className="hint" style={{ color: 'var(--danger)', whiteSpace: 'pre-wrap' }}>{job.error}</div> : null}
        </div>
      ))}
    </>
  );
}

function RendersPanel() {
  return (
    <>
      <div className="panel-header"><span className="title">Render</span><NeonIcon icon={Hash} size={12} tone="muted" /></div>
      <div className="panel-body">
        <RenderControls />
        <div className="panel-header" style={{ padding: '10px 0 6px' }}><span className="title">Jobs</span></div>
        <RenderJobs />
      </div>
    </>
  );
}


// ---- live activity --------------------------------------------------------------------

function ActivityPanel() {
  const editor = useEditor();
  const activity = useSelector(editor.ui, (u) => u.activity);
  const port = editor.bridge.bootstrap.port;
  return (
    <>
      <div className="panel-header">
        <NeonIcon icon={CircleDot} size={12} tone={activity.length ? 'green' : 'muted'} glow={2} />
        <span className="title">Live · {activity.length}</span>
        <button className="btn sm ghost" onClick={() => editor.ui.set({ activity: [] })}>Clear</button>
      </div>
      <div className="panel-body" style={{ padding: 6 }}>
        {activity.length === 0 ? (
          <div className="empty">
            <strong>Nothing yet.</strong>
            <br />
            Everything the CLI, agents, peers and the renderer do shows up here in real time.
            <br />
            <span className="hint mono">neon-cli events</span> <span className="hint">tails the same stream in a terminal.</span>
          </div>
        ) : (
          activity.map((e) => {
            const src = SOURCE_LABEL[e.source] ?? SOURCE_LABEL.system!;
            return (
              <div
                key={e.id}
                className={`activity-row ${e.source}`}
                onClick={() => {
                  if (e.clipIds?.length) {
                    editor.select(e.clipIds.filter((id) => editor.doc.getClip(id)));
                    editor.flashClips(e.clipIds);
                    const first = editor.doc.getClip(e.clipIds[0]!);
                    if (first) editor.seek(first.startFrame);
                  }
                }}
                title={e.action}
              >
                <span className={`src-badge ${src.tone}`}>{src.label}</span>
                <span className="activity-msg">{e.message}</span>
                <span className="activity-ts mono">{e.ts.slice(11, 19)}</span>
              </div>
            );
          })
        )}
        <p className="hint" style={{ marginTop: 10, padding: '0 6px' }}>API on <span className="mono">127.0.0.1:{port}</span> · token in <span className="mono">~/.neon-video/instance.json</span></p>
      </div>
    </>
  );
}
