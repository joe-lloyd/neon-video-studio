/**
 * FX panel — two views:
 *   Components: every template from built-in packs + packs enabled in this project, grouped by
 *               category, searchable, each card a live-rendered thumbnail (animates on hover).
 *               Click = add at the playhead · drag = drop onto an FX track.
 *   Library:    installed / example / built-in packs. Install (folder dialog or drag a pack folder
 *               here), enable per project (button or drag the pack card onto the project zone),
 *               uninstall, reload after editing a pack.
 */
import { useMemo, useState, useSyncExternalStore, type ComponentType, type DragEvent } from 'react';
import { Player, Thumbnail } from '@remotion/player';
import { CORE_PACK_NAME, getTemplatesVersion, listTemplates, subscribeTemplates, templateDefaults, type ComponentTemplate } from '@neon/core';
import { getTemplateComponent } from '@neon/remotion-workspace/templates';
import {
  BarChart3,
  Brain,
  Captions,
  CircleDot,
  Clapperboard,
  Crop,
  Film,
  Flower2,
  FolderOpen,
  Hash,
  ImageIcon,
  Layers,
  Loader2,
  MessageSquareText,
  Music,
  NeonIcon,
  PaintBucket,
  Plus,
  Radio,
  Sparkles,
  Stamp,
  Tag,
  Timer,
  Trash2,
  Type,
  Wind,
  X,
} from '@neon/icon-kit';
import type { LucideIcon } from 'lucide-react';
import type { PackInfo } from '../../shared/rpc.ts';
import { useEditor } from '../lib/context.ts';
import { useSelector, useStoreValue } from '../lib/store.ts';

const ICONS: Record<string, LucideIcon> = {
  Type, Clapperboard, Layers, Timer, BarChart3, Stamp, PaintBucket, Tag, Flower2, Loader2, Sparkles, Hash, CircleDot, Wind, Film, Music, Image: ImageIcon, Captions, Crop, Brain, MessageSquareText, Radio,
};

const PREVIEW_FPS = 30;
const PACK_MIME = 'application/x-neon-pack';
const TEMPLATE_MIME = 'application/x-neon-template';

function useTemplates(): ComponentTemplate[] {
  const version = useSyncExternalStore(subscribeTemplates, getTemplatesVersion, getTemplatesVersion);
  return useMemo(() => listTemplates(), [version]);
}

export function FxPanel() {
  const [view, setView] = useState<'components' | 'library'>('components');
  return (
    <>
      <div className="panel-header">
        <span className="title">FX</span>
        <div className="seg" role="tablist">
          <button role="tab" className={view === 'components' ? 'active' : ''} onClick={() => setView('components')}>Components</button>
          <button role="tab" className={view === 'library' ? 'active' : ''} onClick={() => setView('library')}>Library</button>
        </div>
      </div>
      {view === 'components' ? <ComponentsView onOpenLibrary={() => setView('library')} /> : <LibraryView />}
    </>
  );
}

// ---- components -------------------------------------------------------------------------

function ComponentsView({ onOpenLibrary }: { onOpenLibrary: () => void }) {
  const editor = useEditor();
  const templates = useTemplates();
  const packs = useSelector(editor.ui, (u) => u.packs);
  const { project } = useStoreValue(editor.project);
  const [query, setQuery] = useState('');

  const packLabel = useMemo(() => new Map(packs.map((p) => [p.name, p.label])), [packs]);
  const enabled = useMemo(() => new Set(project.meta.packs ?? []), [project.meta.packs]);
  const installedNames = useMemo(() => new Set(packs.filter((p) => p.source === 'installed').map((p) => p.name)), [packs]);

  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    const visible = templates.filter((t) => {
      const pack = t.pack ?? CORE_PACK_NAME;
      if (installedNames.has(pack) && !enabled.has(pack)) return false;
      if (!q) return true;
      const hay = [t.name, t.label, t.description, t.category, pack, packLabel.get(pack), ...(t.tags ?? [])].filter(Boolean).join(' ').toLowerCase();
      return q.split(/\s+/).every((term) => hay.includes(term));
    });
    const byCat = new Map<string, ComponentTemplate[]>();
    for (const t of visible) {
      const cat = t.category ?? 'Other';
      byCat.set(cat, [...(byCat.get(cat) ?? []), t]);
    }
    return [...byCat.entries()]
      .sort(([a], [b]) => (a === 'Other' ? 1 : b === 'Other' ? -1 : a.localeCompare(b)))
      .map(([cat, items]) => [cat, items.sort((a, b) => a.label.localeCompare(b.label))] as const);
  }, [templates, query, enabled, installedNames, packLabel]);

  const total = groups.reduce((n, [, items]) => n + items.length, 0);
  return (
    <div className="panel-body">
      <input className="input fx-search" placeholder="Search components… (name, category, pack, tag)" value={query} onChange={(e) => setQuery(e.target.value)} />
      {total === 0 ? (
        <div className="empty">
          {query ? <>No components match <strong>{query}</strong>.</> : <>No components available.</>}
          <br />
          <button className="btn sm ghost" style={{ marginTop: 10 }} onClick={onOpenLibrary}>Browse the Library</button>
        </div>
      ) : null}
      {groups.map(([cat, items]) => (
        <section key={cat}>
          <div className="fx-cat">{cat} <span className="count">{items.length}</span></div>
          <div className="fx-grid">
            {items.map((t) => (
              <TemplateCard key={t.name} template={t} packLabel={packLabel.get(t.pack ?? CORE_PACK_NAME) ?? t.pack ?? CORE_PACK_NAME} />
            ))}
          </div>
        </section>
      ))}
      <p className="hint" style={{ marginTop: 14 }}>
        Click adds at the playhead · drag onto an FX track. Want more? Add packs in the <button className="link" onClick={onOpenLibrary}>Library</button>.
      </p>
    </div>
  );
}

function TemplateCard({ template, packLabel }: { template: ComponentTemplate; packLabel: string }) {
  const editor = useEditor();
  const [hover, setHover] = useState(false);
  const Icon = (template.icon && ICONS[template.icon]) || Sparkles;
  return (
    <div
      className="fx-card"
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData(TEMPLATE_MIME, template.name);
        e.dataTransfer.effectAllowed = 'copy';
      }}
      onClick={() => editor.insertTemplate(template.name)}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      title={`${template.label} — ${template.description}\n${template.defaultDurationSeconds}s · click to add at the playhead, drag onto an FX track`}
    >
      <div className="fx-thumb">
        <TemplatePreview template={template} live={hover} />
      </div>
      <div className="fx-card-meta">
        <NeonIcon icon={Icon} size={13} tone="green" />
        <span className="fx-label">{template.label}</span>
      </div>
      <span className="fx-pack">{packLabel}</span>
    </div>
  );
}

/** Static frame normally; a looping Player while hovered. Both render the real component at 1080p, scaled into the card. */
function TemplatePreview({ template, live }: { template: ComponentTemplate; live: boolean }) {
  const Component = getTemplateComponent(template.name) as ComponentType<Record<string, unknown>> | undefined;
  const inputProps = useMemo(() => {
    try {
      return { ...templateDefaults(template.name), ...(template.previewProps ?? {}) };
    } catch {
      return {} as Record<string, unknown>;
    }
  }, [template]);
  if (!Component) return <div className="fx-thumb-missing">not loaded</div>;
  const durationInFrames = Math.max(1, Math.round(template.defaultDurationSeconds * PREVIEW_FPS));
  const common = { component: Component, inputProps, durationInFrames, fps: PREVIEW_FPS, compositionWidth: 1920, compositionHeight: 1080, style: { width: '100%', height: '100%' } };
  return live ? (
    <Player {...common} autoPlay loop controls={false} clickToPlay={false} spaceKeyToPlayOrPause={false} acknowledgeRemotionLicense />
  ) : (
    <Thumbnail {...common} frameToDisplay={Math.min(durationInFrames - 1, Math.round(durationInFrames * 0.45))} />
  );
}

// ---- library ----------------------------------------------------------------------------

function LibraryView() {
  const editor = useEditor();
  const packs = useSelector(editor.ui, (u) => u.packs);
  const busy = useSelector(editor.ui, (u) => u.packsBusy);
  const { project } = useStoreValue(editor.project);
  const enabled = useMemo(() => new Set(project.meta.packs ?? []), [project.meta.packs]);
  const [dropping, setDropping] = useState<'files' | 'pack' | null>(null);

  const installed = packs.filter((p) => p.source === 'installed');
  const builtin = packs.filter((p) => p.source === 'builtin');
  const examples = packs.filter((p) => p.source === 'example');
  const inProject = installed.filter((p) => enabled.has(p.name));
  const available = installed.filter((p) => !enabled.has(p.name));
  const missing = [...enabled].filter((n) => !installed.some((p) => p.name === n));

  const hasFiles = (e: DragEvent) => Array.from(e.dataTransfer.types).includes('Files');
  return (
    <div
      className={`panel-body fx-library${dropping === 'files' ? ' dropping' : ''}`}
      onDragOver={(e) => {
        if (!hasFiles(e)) return;
        e.preventDefault();
        if (dropping !== 'files') setDropping('files');
      }}
      onDragLeave={(e) => {
        if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
        setDropping(null);
      }}
      onDrop={(e) => {
        if (!hasFiles(e)) return;
        e.preventDefault();
        setDropping(null);
        void readDroppedPackFolder(e.dataTransfer.items).then((files) => {
          if (!files) return editor.toast('error', 'Drop a pack folder — the one containing pack.json');
          return editor.installPackFiles(files);
        });
      }}
    >
      <div className="row" style={{ gap: 6, marginBottom: 10 }}>
        <button className="btn sm cyan" disabled={busy} onClick={() => void editor.installPackFromDialog()}><NeonIcon icon={FolderOpen} size={13} tone="cyan" /> Install folder…</button>
        <button className="btn sm ghost" disabled={busy} title="Re-scan ~/.neon-video/packs and recompile" onClick={() => void editor.reloadPacks()}><NeonIcon icon={Loader2} size={13} tone={busy ? 'cyan' : 'muted'} /> Reload</button>
      </div>

      <section
        className={`fx-section pack-zone${dropping === 'pack' ? ' active' : ''}`}
        onDragOver={(e) => {
          if (!Array.from(e.dataTransfer.types).includes(PACK_MIME)) return;
          e.preventDefault();
          e.stopPropagation();
          if (dropping !== 'pack') setDropping('pack');
        }}
        onDragLeave={(e) => {
          if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
          if (dropping === 'pack') setDropping(null);
        }}
        onDrop={(e) => {
          const name = e.dataTransfer.getData(PACK_MIME);
          if (!name) return;
          e.preventDefault();
          e.stopPropagation();
          setDropping(null);
          editor.setPackEnabled(name, true);
        }}
      >
        <h4>In this project <span className="count">{inProject.length + missing.length}</span></h4>
        {inProject.length === 0 && missing.length === 0 ? (
          <div className="pack-drop">Drag an installed pack here — or use <b>Add to project</b> — to use its components in <b>{project.meta.name}</b>.</div>
        ) : null}
        {inProject.map((p) => <PackCard key={p.name} pack={p} enabled />)}
        {missing.map((name) => (
          <div key={name} className="pack-card error">
            <div className="head"><span className="name">{name}</span><span className="pill red">not installed</span></div>
            <div className="err">This project uses a pack that is not installed on this machine. Install it, or remove it from the project.</div>
            <div className="actions"><button className="btn sm ghost" onClick={() => editor.setPackEnabled(name, false)}><NeonIcon icon={X} size={12} /> Remove from project</button></div>
          </div>
        ))}
      </section>

      <section className="fx-section">
        <h4>Installed <span className="count">{available.length}</span></h4>
        {available.length === 0 ? <p className="hint">{installed.length ? 'All installed packs are in this project.' : 'No packs installed yet. Install a folder, drop one here, or pick an example below.'}</p> : null}
        {available.map((p) => <PackCard key={p.name} pack={p} enabled={false} />)}
      </section>

      {examples.length ? (
        <section className="fx-section">
          <h4>Examples <span className="hint">from this repo</span></h4>
          {examples.map((p) => <PackCard key={p.name} pack={p} enabled={false} />)}
        </section>
      ) : null}

      <section className="fx-section">
        <h4>Built-in <span className="hint">always available</span></h4>
        {builtin.map((p) => <PackCard key={p.name} pack={p} enabled />)}
      </section>

      <p className="hint" style={{ marginTop: 14 }}>
        A pack is a folder with <span className="mono">pack.json</span> + <span className="mono">index.tsx</span>. Installed packs live in <span className="mono">~/.neon-video/packs</span>. See <span className="mono">docs/fx-packs.md</span>.
      </p>
    </div>
  );
}

function PackCard({ pack, enabled }: { pack: PackInfo; enabled: boolean }) {
  const editor = useEditor();
  const busy = useSelector(editor.ui, (u) => u.packsBusy);
  const installed = pack.source === 'installed';
  return (
    <div
      className={`pack-card${enabled && installed ? ' enabled' : ''}${pack.status === 'error' ? ' error' : ''}`}
      draggable={installed && pack.status === 'ready'}
      onDragStart={(e) => {
        e.dataTransfer.setData(PACK_MIME, pack.name);
        e.dataTransfer.effectAllowed = 'link';
      }}
    >
      <div className="head">
        <NeonIcon icon={pack.source === 'builtin' ? Sparkles : Layers} size={14} tone={pack.status === 'error' ? 'red' : enabled ? 'green' : 'muted'} />
        <span className="name">{pack.label}</span>
        {pack.version ? <span className="hint mono">v{pack.version}</span> : null}
        {pack.source === 'builtin' ? <span className="pill">built-in</span> : pack.source === 'example' ? <span className="pill cyan">example</span> : enabled ? <span className="pill green">in project</span> : null}
      </div>
      {pack.description ? <div className="desc">{pack.description}</div> : null}
      {pack.author ? <div className="hint">by {pack.author}</div> : null}
      {pack.error ? <div className="err">{pack.error}</div> : null}
      <div className="templates" title={pack.templates.join(', ')}>
        {pack.templates.length} component{pack.templates.length === 1 ? '' : 's'}{pack.templates.length ? ` · ${pack.templates.slice(0, 4).join(', ')}${pack.templates.length > 4 ? '…' : ''}` : ''}
      </div>
      {pack.source !== 'builtin' ? (
        <div className="actions">
          {pack.source === 'example' && pack.dir ? (
            <button className="btn sm cyan" disabled={busy || pack.status !== 'ready'} onClick={() => void editor.installPackDir(pack.dir!)}><NeonIcon icon={Plus} size={12} tone="cyan" /> Install</button>
          ) : null}
          {installed && pack.status === 'ready' ? (
            enabled ? (
              <button className="btn sm ghost" onClick={() => editor.setPackEnabled(pack.name, false)}><NeonIcon icon={X} size={12} /> Remove from project</button>
            ) : (
              <button className="btn sm magenta" onClick={() => editor.setPackEnabled(pack.name, true)}><NeonIcon icon={Plus} size={12} tone="magenta" /> Add to project</button>
            )
          ) : null}
          {installed ? (
            <button className="btn sm ghost" disabled={busy} title="Delete from ~/.neon-video/packs" onClick={() => void editor.uninstallPack(pack.name)}><NeonIcon icon={Trash2} size={12} tone="red" /> Uninstall</button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

// ---- folder drop --------------------------------------------------------------------------

const TEXT_FILE = /\.(tsx?|jsx?|mjs|cjs|json|css|md|txt|svg)$/i;

/** Read a dropped pack folder (via the webkit entry API) into { path, content } pairs rooted at the folder name. */
async function readDroppedPackFolder(items: DataTransferItemList): Promise<{ path: string; content: string }[] | null> {
  const entries = Array.from(items)
    .map((item) => item.webkitGetAsEntry())
    .filter((e): e is FileSystemEntry => e !== null);
  const dir = entries.find((e) => e.isDirectory) as FileSystemDirectoryEntry | undefined;
  if (!dir) return null;
  const out: { path: string; content: string }[] = [];
  await walkEntry(dir, dir.name, out);
  return out.some((f) => f.path === `${dir.name}/pack.json`) ? out : null;
}

async function walkEntry(dir: FileSystemDirectoryEntry, prefix: string, out: { path: string; content: string }[]): Promise<void> {
  const reader = dir.createReader();
  const all: FileSystemEntry[] = [];
  for (;;) {
    const batch = await new Promise<FileSystemEntry[]>((res, rej) => reader.readEntries(res, rej));
    if (batch.length === 0) break;
    all.push(...batch);
  }
  for (const entry of all) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    if (entry.isDirectory) await walkEntry(entry as FileSystemDirectoryEntry, `${prefix}/${entry.name}`, out);
    else if (TEXT_FILE.test(entry.name)) {
      const file = await new Promise<File>((res, rej) => (entry as FileSystemFileEntry).file(res, rej));
      out.push({ path: `${prefix}/${entry.name}`, content: await file.text() });
    }
  }
}
