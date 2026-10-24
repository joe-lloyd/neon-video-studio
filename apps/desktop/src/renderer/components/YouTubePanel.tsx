import { useEffect, useState } from 'react';
import { RENDER_PRESETS, YOUTUBE_CATEGORIES, YouTubeCategoryIdSchema, type YouTubeCategoryId, type YouTubePrivacy, type YouTubeState, type YouTubeUploadJob, type YouTubeUploadRequestInput, type YouTubeVideo } from '@neon/core';
import { AlertTriangle, Copy, Link, NeonIcon, Upload, X } from '@neon/icon-kit';
import { useEditor } from '../lib/context.ts';
import { useStoreValue } from '../lib/store.ts';

/**
 * Publish to YouTube from the Render panel. Talks to the same control API as `neon-cli youtube`,
 * so the app and the CLI share one code path (main/youtube.ts holds the Google tokens).
 */
function useYouTubeApi() {
  const { port, token } = useEditor().bridge.bootstrap;
  return async <T,>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> => {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const json = (await res.json()) as { ok: boolean; data: T; error?: { message: string } };
    if (!json.ok) throw new Error(json.error?.message ?? 'request failed');
    return json.data;
  };
}

const busy = (job: YouTubeUploadJob) => job.status === 'rendering' || job.status === 'uploading' || job.status === 'finishing';

export function YouTubePublish() {
  const editor = useEditor();
  const api = useYouTubeApi();
  const { project, durationFrames } = useStoreValue(editor.project);
  const [state, setState] = useState<YouTubeState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [title, setTitle] = useState(project.meta.name);
  const [description, setDescription] = useState('');
  const [tags, setTags] = useState('');
  const [categoryId, setCategoryId] = useState<YouTubeCategoryId>('28');
  const [privacy, setPrivacy] = useState<YouTubePrivacy>('private');
  const [publishAt, setPublishAt] = useState('');
  const [madeForKids, setMadeForKids] = useState<boolean | null>(null);
  const [aiContent, setAiContent] = useState(false);
  const [playlistId, setPlaylistId] = useState('');
  const [thumbnail, setThumbnail] = useState('');
  const [useProjectThumbnail, setUseProjectThumbnail] = useState((project.thumbnail?.layers.length ?? 0) > 0);
  const [preset, setPreset] = useState('project');
  const [file, setFile] = useState('');
  const [videos, setVideos] = useState<YouTubeVideo[] | null>(null);
  const [settingThumb, setSettingThumb] = useState<string | null>(null);

  const pending = state?.auth.state === 'pending' || (state?.uploads ?? []).some(busy);
  useEffect(() => {
    let live = true;
    const load = () => api<YouTubeState>('GET', '/api/youtube').then((s) => live && setState(s)).catch((err: Error) => live && setError(err.message));
    void load();
    const timer = setInterval(load, pending ? 1000 : 5000);
    return () => {
      live = false;
      clearInterval(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pending]);

  const run = (p: Promise<unknown>) => {
    setError(null);
    void p.then(() => api<YouTubeState>('GET', '/api/youtube').then(setState)).catch((err: Error) => setError(err.message));
  };

  if (!state) return <div className="hint">{error ?? 'Loading YouTube…'}</div>;
  const auth = state.auth;

  const upload = () => {
    if (madeForKids === null) return;
    const body: YouTubeUploadRequestInput = {
      source: file.trim() ? { kind: 'file', path: file.trim() } : { kind: 'timeline', preset },
      metadata: {
        title,
        description,
        tags: tags.split(',').map((t) => t.trim()).filter(Boolean),
        categoryId,
        privacy,
        publishAt: privacy === 'private' && publishAt ? new Date(publishAt).toISOString() : undefined,
        madeForKids,
        containsSyntheticMedia: aiContent,
        playlistId: playlistId.trim() || undefined,
        thumbnail: useProjectThumbnail ? undefined : thumbnail.trim() || undefined,
        projectThumbnail: useProjectThumbnail,
      },
    };
    run(api('POST', '/api/youtube/upload', body));
  };

  return (
    <>
      {auth.state === 'unconfigured' ? <p className="hint">{auth.hint}</p> : null}
      {auth.state === 'signed-out' ? (
        <>
          <button className="btn cyan" style={{ width: '100%', justifyContent: 'center' }} onClick={() => run(api('POST', '/api/youtube/login', { open: true }))}>
            <NeonIcon icon={Link} size={14} tone="cyan" /> Sign in with Google
          </button>
          {state.loginError ? <p className="hint" style={{ color: 'var(--danger)' }}>{state.loginError}</p> : null}
        </>
      ) : null}
      {auth.state === 'pending' ? (
        <p className="hint">
          Finish signing in on the Google page that opened in your browser.{' '}
          <button className="btn sm ghost" onClick={() => void navigator.clipboard.writeText(auth.authUrl)}><NeonIcon icon={Copy} size={12} tone="cyan" /> Copy its link</button>
        </p>
      ) : null}
      {auth.state === 'signed-in' ? (
        <>
          <div className="row between hint">
            <span>Channel: <b>{auth.channel.title}</b>{auth.channel.handle ? ` (${auth.channel.handle})` : ''}</span>
            <button className="btn sm ghost" onClick={() => run(api('POST', '/api/youtube/logout', {}))}>Sign out</button>
          </div>
          <div className="field"><label>Title</label><input className="input" maxLength={100} value={title} onChange={(e) => setTitle(e.target.value)} /></div>
          <div className="field"><label>Description</label><textarea className="input" rows={4} maxLength={5000} value={description} onChange={(e) => setDescription(e.target.value)} /></div>
          <div className="field"><label>Tags (comma separated)</label><input className="input" value={tags} onChange={(e) => setTags(e.target.value)} placeholder="video editor, typescript" /></div>
          <div className="row" style={{ gap: 8 }}>
            <div className="field" style={{ flex: 1 }}>
              <label>Visibility</label>
              <select className="select" value={privacy} onChange={(e) => setPrivacy(e.target.value === 'public' ? 'public' : e.target.value === 'unlisted' ? 'unlisted' : 'private')}>
                <option value="private">Private</option>
                <option value="unlisted">Unlisted</option>
                <option value="public">Public</option>
              </select>
            </div>
            <div className="field" style={{ flex: 1 }}>
              <label>Category</label>
              <select className="select" value={categoryId} onChange={(e) => setCategoryId(YouTubeCategoryIdSchema.catch('28').parse(e.target.value))}>
                {YOUTUBE_CATEGORIES.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
              </select>
            </div>
          </div>
          {privacy === 'private' ? (
            <div className="field"><label>Schedule (optional, goes public then)</label><input className="input" type="datetime-local" value={publishAt} onChange={(e) => setPublishAt(e.target.value)} /></div>
          ) : null}
          <div className="field">
            <label>Made for kids? (YouTube requires an answer)</label>
            <div className="row" style={{ gap: 12 }}>
              <label className="hint"><input type="radio" name="yt-kids" checked={madeForKids === false} onChange={() => setMadeForKids(false)} /> No</label>
              <label className="hint"><input type="radio" name="yt-kids" checked={madeForKids === true} onChange={() => setMadeForKids(true)} /> Yes</label>
            </div>
          </div>
          <label className="hint row" style={{ marginBottom: 8 }}><input type="checkbox" checked={aiContent} onChange={(e) => setAiContent(e.target.checked)} /> Realistic AI-generated or altered content</label>
          <div className="field"><label>Playlist ID (optional)</label><input className="input mono" value={playlistId} onChange={(e) => setPlaylistId(e.target.value)} placeholder="PL…" /></div>
          <label className="hint row" style={{ marginBottom: 8 }}><input type="checkbox" checked={useProjectThumbnail} onChange={(e) => setUseProjectThumbnail(e.target.checked)} /> Use the project thumbnail (Thumb tab)</label>
          {!useProjectThumbnail ? <div className="field"><label>Thumbnail .png/.jpg (optional)</label><input className="input mono" value={thumbnail} onChange={(e) => setThumbnail(e.target.value)} placeholder="/path/to/thumbnail.png" /></div> : null}
          <div className="row" style={{ gap: 8 }}>
            <div className="field" style={{ flex: 1 }}>
              <label>Render preset</label>
              <select className="select" value={preset} disabled={Boolean(file.trim())} onChange={(e) => setPreset(e.target.value)}>
                <option value="project">Project · {project.meta.width}×{project.meta.height}</option>
                {RENDER_PRESETS.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
              </select>
            </div>
            <div className="field" style={{ flex: 1 }}><label>…or upload a file</label><input className="input mono" value={file} onChange={(e) => setFile(e.target.value)} placeholder="/path/to/video.mp4" /></div>
          </div>
          <button className="btn magenta" style={{ width: '100%', justifyContent: 'center' }} disabled={!title.trim() || madeForKids === null || (!file.trim() && durationFrames === 0)} onClick={upload}>
            <NeonIcon icon={Upload} size={14} tone="magenta" /> {file.trim() ? 'Upload to YouTube' : 'Render & upload to YouTube'}
          </button>
          {madeForKids === null ? <p className="hint" style={{ marginTop: 6 }}>Answer “made for kids” to upload.</p> : null}
          <div className="panel-header" style={{ padding: '12px 0 6px' }}>
            <span className="title">Your videos</span>
            <button className="btn sm ghost" onClick={() => run(api<YouTubeVideo[]>('GET', '/api/youtube/videos').then(setVideos))}>{videos ? 'Refresh' : 'Show'}</button>
          </div>
          {videos?.length === 0 ? <div className="hint">No uploads yet.</div> : null}
          {videos?.map((v) => (
            <div key={v.id} className="list-item" style={{ cursor: 'default' }}>
              <span style={{ flex: 1, fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={v.url}>{v.title}</span>
              <span className="hint mono">{v.privacy}</span>
              <button
                className="btn sm"
                disabled={settingThumb !== null}
                title="Render the project thumbnail (Thumb tab) and set it on this video"
                onClick={() => {
                  setSettingThumb(v.id);
                  run(api('POST', '/api/youtube/thumbnail', { video: v.id, projectThumbnail: true }).then(() => editor.toast('success', `Thumbnail set on “${v.title}”`)).finally(() => setSettingThumb(null)));
                }}
              >
                {settingThumb === v.id ? 'Setting…' : 'Use project thumbnail'}
              </button>
            </div>
          ))}
        </>
      ) : null}
      {error ? <p className="hint" style={{ color: 'var(--danger)', whiteSpace: 'pre-wrap' }}>{error}</p> : null}
      {state.uploads.map((job) => (
        <div key={job.id} className="list-item" style={{ cursor: 'default', flexDirection: 'column', alignItems: 'stretch', gap: 6, marginTop: 8 }}>
          <div className="row between">
            <span style={{ fontSize: 12 }}>{job.title}</span>
            <span className={`pill ${job.status === 'done' ? 'green' : job.status === 'failed' ? 'red' : job.status === 'cancelled' ? '' : 'cyan'}`}>{job.status}</span>
          </div>
          {busy(job) ? <div className="progress"><div style={{ width: `${Math.round(job.progress * 100)}%` }} /></div> : null}
          <div className="row between hint mono">
            <span>{job.status === 'uploading' ? `${(job.bytesSent / 1048576).toFixed(1)}/${(job.totalBytes / 1048576).toFixed(1)} MB` : job.privacy}</span>
            <span className="row" style={{ gap: 4 }}>
              {job.url ? <button className="btn sm ghost" title="Copy the link" onClick={() => void navigator.clipboard.writeText(job.url ?? '')}><NeonIcon icon={Copy} size={12} tone="cyan" /> {job.url.replace('https://', '')}</button> : null}
              {busy(job) ? <button className="btn sm ghost" onClick={() => run(api('POST', `/api/youtube/uploads/${job.id}/cancel`, {}))}><NeonIcon icon={X} size={12} tone="red" /> Cancel</button> : null}
            </span>
          </div>
          {job.warnings.map((w) => <div key={w} className="hint row" style={{ gap: 4, alignItems: 'flex-start' }}><NeonIcon icon={AlertTriangle} size={12} tone="amber" /> {w}</div>)}
          {job.error ? <div className="hint" style={{ color: 'var(--danger)', whiteSpace: 'pre-wrap' }}>{job.error}</div> : null}
        </div>
      ))}
    </>
  );
}
