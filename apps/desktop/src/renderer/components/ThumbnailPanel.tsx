import { useEffect, useMemo, useRef, useState } from 'react';
import { Player, type PlayerRef } from '@neon/motion/player';
import { TimelineComposition, type TimelineProps } from '@neon/compositions/composition';
import { THUMBNAIL_HEIGHT, THUMBNAIL_WIDTH, framesToTimecode, hasTemplate, listTemplates, newLayerTransform, templateJsonSchema, thumbnailProject, type StillResult, type ThumbnailLayer } from '@neon/core';
import { ChevronDown, ChevronRight, FolderOpen, ImageIcon, NeonIcon, Plus, Trash2 } from '@neon/icon-kit';
import { useEditor } from '../lib/context.ts';
import { useStoreValue } from '../lib/store.ts';
import { PropField, type SchemaProp } from './SidePanels.tsx';

/**
 * The video's thumbnail: a live 1280x720 preview of thumbnailProject() (the same frame the
 * renderer draws), the layer stack, and the selected layer's props and placement. Edits go
 * through the shared ProjectDoc like timeline edits, so they undo, sync to peers and reach the CLI.
 */
export function ThumbnailPanel() {
  const editor = useEditor();
  const { project } = useStoreValue(editor.project);
  const { frame: playhead } = useStoreValue(editor.playhead);
  const thumb = project.thumbnail ?? { background: { kind: 'frame' as const, frame: 0 }, layers: [] };
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [component, setComponent] = useState('TitleCard');
  const [rendered, setRendered] = useState<StillResult | null>(null);
  const [rendering, setRendering] = useState(false);
  const selected = thumb.layers.find((l) => l.id === selectedId) ?? null;
  const images = project.assets.filter((a) => a.kind === 'image');
  const fps = project.meta.fps;

  const run = (fn: () => void) => {
    try {
      fn();
    } catch (err) {
      editor.toast('error', (err as Error).message);
    }
  };
  const add = (layer: ThumbnailLayer) => setSelectedId(layer.id);
  const render = async () => {
    setRendering(true);
    const { port, token } = editor.bridge.bootstrap;
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/thumbnail/render`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: '{}' });
      const json = (await res.json()) as { ok: boolean; data: StillResult; error?: { message: string } };
      if (!json.ok) throw new Error(json.error?.message ?? 'render failed');
      setRendered(json.data);
    } catch (err) {
      editor.toast('error', (err as Error).message);
    } finally {
      setRendering(false);
    }
  };

  return (
    <>
      <div className="panel-header"><span className="title">Thumbnail</span><span className="hint mono">{THUMBNAIL_WIDTH}×{THUMBNAIL_HEIGHT}</span></div>
      <div className="panel-body">
        <ThumbnailPreview />
        <div className="field" style={{ marginTop: 10 }}>
          <label>Background</label>
          <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
            <button className={`btn sm ${thumb.background.kind === 'frame' ? 'cyan' : ''}`} title="Use the frame under the playhead" onClick={() => run(() => editor.doc.setThumbnailBackground({ kind: 'frame', frame: playhead }))}>
              Timeline at playhead
            </button>
            <input type="color" value={thumb.background.kind === 'color' && /^#[0-9a-f]{6}$/i.test(thumb.background.color) ? thumb.background.color : '#101018'} onChange={(e) => run(() => editor.doc.setThumbnailBackground({ kind: 'color', color: e.target.value }))} style={{ width: 34, height: 28, padding: 0, border: 'none', background: 'transparent' }} title="Solid colour" />
            <span className="hint">{thumb.background.kind === 'frame' ? `frame ${framesToTimecode(thumb.background.frame, fps)}` : thumb.background.color}</span>
          </div>
        </div>

        <div className="field">
          <label>Add a layer</label>
          <div className="row" style={{ gap: 6 }}>
            <select className="select" style={{ flex: 1 }} value={component} onChange={(e) => setComponent(e.target.value)}>
              {listTemplates().map((t) => <option key={t.name} value={t.name}>{t.label}{t.pack && t.pack !== 'core' ? ` · ${t.pack}` : ''}</option>)}
            </select>
            <button className="btn sm magenta" onClick={() => run(() => add(editor.doc.addThumbnailLayer({ kind: 'component', componentName: component, props: {}, transform: newLayerTransform(undefined) })))}><NeonIcon icon={Plus} size={12} tone="magenta" /> Add</button>
          </div>
          {images.length ? (
            <div className="row" style={{ gap: 6, marginTop: 6, flexWrap: 'wrap' }}>
              {images.map((a) => (
                <button key={a.id} className="btn sm" title="Add this image as a layer" onClick={() => run(() => add(editor.doc.addThumbnailLayer({ kind: 'image', assetId: a.id, transform: newLayerTransform({ scale: 0.4 }) })))}>
                  <NeonIcon icon={ImageIcon} size={12} tone="cyan" /> {a.name}
                </button>
              ))}
            </div>
          ) : <p className="hint">Import a PNG or JPG in Media to use it as a layer.</p>}
        </div>

        <div className="panel-header" style={{ padding: '8px 0 6px' }}><span className="title">Layers</span><span className="hint">top first</span></div>
        {thumb.layers.length === 0 ? <div className="empty">No layers yet.</div> : null}
        {[...thumb.layers].reverse().map((l) => {
          const index = thumb.layers.indexOf(l);
          return (
            <div key={l.id} className={`list-item ${l.id === selectedId ? 'selected' : ''}`} onClick={() => setSelectedId(l.id)}>
              <span style={{ flex: 1, fontSize: 12 }}>{l.name}</span>
              <span className="hint mono">{l.kind === 'component' ? l.componentName : 'image'}</span>
              <button className="btn icon ghost" title="Move up" disabled={index === thumb.layers.length - 1} onClick={(e) => { e.stopPropagation(); run(() => editor.doc.moveThumbnailLayer(l.id, index + 1)); }}><NeonIcon icon={ChevronDown} size={12} style={{ transform: 'rotate(180deg)' }} /></button>
              <button className="btn icon ghost" title="Move down" disabled={index === 0} onClick={(e) => { e.stopPropagation(); run(() => editor.doc.moveThumbnailLayer(l.id, index - 1)); }}><NeonIcon icon={ChevronDown} size={12} /></button>
              <button className="btn icon ghost" title="Remove layer" onClick={(e) => { e.stopPropagation(); run(() => editor.doc.removeThumbnailLayers([l.id])); }}><NeonIcon icon={Trash2} size={12} tone="red" /></button>
            </div>
          );
        })}

        {selected ? <LayerEditor key={selected.id} layer={selected} onError={(m) => editor.toast('error', m)} /> : null}

        <button className="btn magenta" style={{ width: '100%', justifyContent: 'center', marginTop: 12 }} disabled={rendering} onClick={() => void render()}>
          <NeonIcon icon={ImageIcon} size={14} tone="magenta" /> {rendering ? 'Rendering…' : 'Render thumbnail PNG'}
        </button>
        {rendered ? (
          <div className="row between hint mono" style={{ marginTop: 6 }}>
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{rendered.path.split('/').slice(-1)[0]}</span>
            <button className="btn sm ghost" onClick={() => void editor.bridge.request('revealPath', { path: rendered.path }).catch(() => undefined)}><NeonIcon icon={FolderOpen} size={12} tone="cyan" /> Reveal</button>
          </div>
        ) : null}
        <p className="hint" style={{ marginTop: 8 }}>YouTube uploads use this when “Use the project thumbnail” is on. CLI: <span className="mono">neon-cli thumbnail</span>.</p>
      </div>
    </>
  );
}

/** The thumbnail as the renderer will draw it, paused on its one frame. */
function ThumbnailPreview() {
  const editor = useEditor();
  const { project } = useStoreValue(editor.project);
  const proxies = useStoreValue(editor.proxies);
  const { project: thumbProject, frame } = useMemo(() => thumbnailProject(project), [project]);
  const playerRef = useRef<PlayerRef>(null);
  const inputProps = useMemo<TimelineProps>(
    () => ({ project: thumbProject, assetBaseUrl: `http://127.0.0.1:${editor.bridge.bootstrap.port}/assets`, assetQuery: '', proxies: proxies.ready, render: null }),
    [thumbProject, editor, proxies],
  );
  useEffect(() => {
    playerRef.current?.seekTo(frame);
  }, [frame, inputProps]);
  return (
    <div style={{ width: '100%', aspectRatio: `${THUMBNAIL_WIDTH} / ${THUMBNAIL_HEIGHT}`, background: '#000', borderRadius: 6, overflow: 'hidden', border: '1px solid var(--border-subtle)' }}>
      <Player
        ref={playerRef}
        component={TimelineComposition}
        inputProps={inputProps}
        durationInFrames={frame + 1}
        initialFrame={frame}
        fps={thumbProject.meta.fps}
        compositionWidth={THUMBNAIL_WIDTH}
        compositionHeight={THUMBNAIL_HEIGHT}
        style={{ width: '100%', height: '100%' }}
        clickToPlay={false}
        spaceKeyToPlayOrPause={false}
      />
    </div>
  );
}

function LayerEditor({ layer, onError }: { layer: ThumbnailLayer; onError: (message: string) => void }) {
  const editor = useEditor();
  const update = (patch: Parameters<typeof editor.doc.updateThumbnailLayer>[1]) => {
    try {
      editor.doc.updateThumbnailLayer(layer.id, patch);
    } catch (err) {
      onError((err as Error).message);
    }
  };
  const t = { rotation: 0, ...layer.transform };
  const schema = layer.kind === 'component' && hasTemplate(layer.componentName) ? (templateJsonSchema(layer.componentName) as { properties?: Record<string, SchemaProp> }) : null;
  const slider = (label: string, key: 'x' | 'y' | 'scale' | 'rotation', min: number, max: number, step: number) => (
    <div className="field">
      <label>{label} · {t[key].toFixed(key === 'rotation' ? 0 : 2)}</label>
      <input type="range" min={min} max={max} step={step} value={t[key]} onChange={(e) => update({ transform: { [key]: Number(e.target.value) } })} />
    </div>
  );
  return (
    <div style={{ marginTop: 10, borderTop: '1px solid var(--border-subtle)', paddingTop: 10 }}>
      <div className="row" style={{ gap: 4, marginBottom: 6 }}><NeonIcon icon={ChevronRight} size={12} tone="cyan" /><span className="title">{layer.name}</span></div>
      <div className="field"><label>Name</label><input className="input" defaultValue={layer.name} onBlur={(e) => e.target.value && e.target.value !== layer.name && update({ name: e.target.value })} /></div>
      <div className="grid-2">
        {slider('X', 'x', 0, 1, 0.01)}
        {slider('Y', 'y', 0, 1, 0.01)}
        {slider('Scale', 'scale', 0.05, 3, 0.01)}
        {slider('Rotation', 'rotation', -180, 180, 1)}
      </div>
      {layer.kind === 'component' && schema?.properties
        ? Object.entries(schema.properties).map(([name, prop]) => <PropField key={name} name={name} schema={prop} value={layer.props[name]} onChange={(v) => update({ props: { [name]: v } })} />)
        : null}
    </div>
  );
}
