import { useEffect, useRef, useState, useId } from 'react';
import type { StudioVoicePreview, MediaClip } from '@neon/core';
import { useEditor } from '../lib/context.ts';
import { useSelector, useStoreValue } from '../lib/store.ts';

export function StudioVoice() {
  const editor = useEditor();
  const { project } = useStoreValue(editor.project);
  const selection = useSelector(editor.ui, u => u.selection);
  const jobs = useSelector(editor.ui, u => u.aiJobs);
  const caps = useSelector(editor.ui, u => u.aiCaps);
  const recording = useSelector(editor.ui, u => u.recording);
  const selected = project.clips.filter(clip => selection.includes(clip.id));
  const audioClips = selected.filter((clip): clip is MediaClip => clip.kind === 'audio');
  const [auditionClipId, setAuditionClipId] = useState('');
  const clip = audioClips.find(clip => clip.id === auditionClipId) ?? audioClips[0];
  const previewJob = jobs.find(job => {
    if (job.op !== 'studio-voice' || job.status !== 'done') return false;
    const result = job.result as StudioVoicePreview | undefined;
    if (!result || result.projectId !== project.meta.id) return false;
    const targets = result.clips ?? [result];
    return targets.length === selection.length && targets.every(target => selection.includes(target.clipId));
  });
  const batchPreview = previewJob?.result as StudioVoicePreview | undefined;
  const preview = (batchPreview?.clips ?? (batchPreview ? [batchPreview] : [])).find(target => target.clipId === clip?.id);
  const reasonId = useId();
  const busy = jobs.some(j => j.status === 'running' || j.status === 'queued');
  const reason = recording ? 'Stop recording before generating or applying Studio Voice.'
    : busy ? 'Another AI job is running or queued. Wait for it to finish, or cancel it in Jobs.'
    : !selection.length ? 'Select one or more audio clips, or click the VO row label to select the whole row.'
    : audioClips.length !== selection.length ? 'Studio Voice needs audio clips. Deselect video/text clips, or detach video audio first.'
    : !caps ? 'Checking whether the local restoration model is ready…'
    : !caps.studioVoice?.available ? 'The local restoration model is unavailable. Refresh engines to check the installation.' : '';
  const previewChanged = batchPreview && (batchPreview.clips ?? [batchPreview]).some(target => {
    const current = audioClips.find(clip => clip.id === target.clipId);
    return !current || ![target.sourceAssetId, target.appliedAssetId].includes(current.assetId) || current.startFrame !== target.startFrame || current.durationFrames !== target.durationFrames || current.trimBefore !== target.trimBefore || (current.speed ?? 1) !== target.speed || project.meta.fps !== target.fps;
  });
  const applyReason = reason || (previewChanged ? 'Selected clips changed since this preview. Generate a new preview before applying.' : '');
  const [strength, setStrength] = useState(0.75);
  const [mode, setMode] = useState<'original' | 'studio'>('studio');
  const [playing, setPlaying] = useState(false);
  const context = useRef<AudioContext | null>(null);
  const sources = useRef<AudioBufferSourceNode[]>([]);
  const gains = useRef<GainNode[]>([]);
  const decoded = useRef<{ id: string; buffers: AudioBuffer[] } | null>(null);
  const generation = useRef(0);
  const [loading, setLoading] = useState(false);
  const stop = () => {
    generation.current++;
    for (const source of sources.current) { source.onended = null; try { source.stop(); } catch { /* already stopped */ } source.disconnect(); }
    sources.current = []; gains.current = [];
    setPlaying(false); setLoading(false);
  };
  useEffect(() => { stop(); decoded.current = null; }, [previewJob?.id, clip?.id, project.meta.id, !!recording]);
  useEffect(() => () => {
    generation.current++;
    for (const source of sources.current) { source.onended = null; try { source.stop(); } catch { /* ended */ } }
    void context.current?.close();
  }, []);
  useEffect(() => {
    const values = mode === 'original' ? [1, 0] : [1-strength, strength];
    gains.current.forEach((gain, i) => gain.gain.setTargetAtTime(values[i]!, context.current!.currentTime, 0.01));
  }, [mode, strength]);
  const play = async () => {
    if (!preview || editor.ui.get().recording) return;
    stop();
    const token = generation.current;
    editor.player?.pause();
    setLoading(true);
    try {
      const audio = context.current ??= new AudioContext();
      await audio.resume();
      if (decoded.current?.id !== `${previewJob!.id}:${preview.clipId}`) {
        const buffers = await Promise.all([preview.dryAssetId, preview.wetAssetId].map(async id => {
          const response = await fetch(editor.assetUrl(id));
          if (!response.ok) throw new Error('Audition audio unavailable');
          return audio.decodeAudioData(await response.arrayBuffer());
        }));
        if (generation.current !== token) return;
        decoded.current = { id: `${previewJob!.id}:${preview.clipId}`, buffers };
      }
      if (generation.current !== token || editor.ui.get().recording) return;
      const offset = preview.trimBefore / project.meta.fps;
      const duration = preview.durationFrames * preview.speed / project.meta.fps;
      const when = audio.currentTime + 0.05;
      const values = mode === 'original' ? [1, 0] : [1-strength, strength];
      // Both sources share one clock and sample-accurate start, so blending cannot drift.
      decoded.current.buffers.forEach((buffer, i) => {
        const source = audio.createBufferSource(); source.buffer = buffer; source.playbackRate.value = preview.speed;
        const gain = audio.createGain(); gain.gain.value = values[i]!;
        source.connect(gain).connect(audio.destination);
        sources.current.push(source); gains.current.push(gain);
        source.start(when, offset, duration);
      });
      sources.current[0]!.onended = stop;
      setLoading(false); setPlaying(true);
    } catch { if (generation.current === token) { stop(); editor.toast('error', 'Could not play this audition. Generate a new preview or try again.'); } }
  };
  return <div style={{ border: '1px solid var(--border)', borderRadius: 6, padding: 10, marginBottom: 12 }}>
    <b>Studio Voice · local AI restoration</b>
    <p className="hint">Reconstruct speech affected by noise, room echo, clipping or thin recordings. Audition before applying; AI can change voice texture.</p>
    <p className="hint">{!caps ? 'Checking local restoration model…' : caps.studioVoice?.available ? `VoiceFixer ready · ${caps.studioVoice.device === 'cuda' ? 'GPU' : 'CPU'} · audio stays on this computer` : 'Local model not installed. Run scripts/install-studio-voice.ps1, then refresh engines.'}</p>
    {reason ? <p id={reasonId} role="status" style={{ fontSize: 12, color: 'var(--text)' }}>{reason}</p> : <p className="hint">{audioClips.length} audio clip{audioClips.length === 1 ? '' : 's'} selected · {new Set(audioClips.map(clip => clip.assetId)).size} source recording(s)</p>}
    <span title={reason || 'Restore the selected audio clips'}>
      <button className="btn sm cyan" disabled={!!reason} aria-describedby={reason ? reasonId : undefined} onClick={() => { stop(); void editor.runAi('studio-voice', { clipIds: audioClips.map(clip => clip.id) }); }}>Generate {audioClips.length > 1 ? `${audioClips.length} previews` : 'preview'}</button>
    </span>
    <p className="hint">Processes each source once. Your edit stays unchanged until Apply.</p>
    {preview ? <>
      {audioClips.length > 1 ? <label className="hint" style={{ display: 'block', marginTop: 8 }}>Audition clip
        <select aria-label="Audition clip" className="select" value={clip?.id} onChange={event => { stop(); setAuditionClipId(event.target.value); }}>
          {audioClips.map(clip => <option key={clip.id} value={clip.id}>{clip.name}</option>)}
        </select>
      </label> : null}
      <div className="row" style={{ gap: 6, marginTop: 8 }}>
        <button className={`btn sm ${mode === 'original' ? 'cyan' : 'ghost'}`} aria-pressed={mode === 'original'} onClick={() => setMode('original')}>Original</button>
        <button className={`btn sm ${mode === 'studio' ? 'cyan' : 'ghost'}`} aria-pressed={mode === 'studio'} onClick={() => setMode('studio')}>Studio</button>
        <button className="btn sm" disabled={!!recording || busy} title={recording || busy ? reason : 'Play the chosen clip'} aria-describedby={recording || busy ? reasonId : undefined} onClick={() => playing || loading ? stop() : void play()}>{loading ? 'Cancel audition loading' : playing ? 'Stop audition' : 'Play audition'}</button>
      </div>
      <label className="hint" style={{ display: 'block', marginTop: 8 }}>Studio blend · {Math.round(strength*100)}%
        <input aria-label="Studio blend" style={{ width: '100%' }} type="range" min={0} max={1} step={0.01} value={strength} onChange={e => { setStrength(Number(e.target.value)); setMode('studio'); }} />
      </label>
      <p className="hint">Original and Studio are loudness matched for comparison.</p>
      <button className="btn sm magenta" disabled={!!applyReason} title={applyReason || 'Apply this blend to all selected audio clips'} aria-describedby={applyReason ? `${reasonId}-apply` : undefined} onClick={() => { stop(); void editor.runAi('studio-voice-apply', { previewJobId: previewJob!.id, strength }); }}>Apply Studio Voice{audioClips.length > 1 ? ` to ${audioClips.length} clips` : ''}</button>
      {applyReason ? <p id={`${reasonId}-apply`} role="status" style={{ fontSize: 12, color: 'var(--text)' }}>{applyReason}</p> : null}
      <p className="hint">Keeps clip timing and the original recording. Undo restores the previous audio.</p>
    </> : null}
  </div>;
}
