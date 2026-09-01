import { useState } from 'react';
import type { AiJob, MediaClip } from '@neon/core';
import { AudioLines, Brain, Captions, Crop, Eraser, Mic, NeonIcon, Sparkles, UserRound, Wind, X, MessageSquareText } from '@neon/icon-kit';
import { useEditor } from '../lib/context.ts';
import { useSelector, useStoreValue } from '../lib/store.ts';

function statusTone(status: AiJob['status']): string {
  return status === 'done' ? 'green' : status === 'failed' ? 'red' : status === 'cancelled' ? '' : 'cyan';
}

export function AiPanel() {
  const editor = useEditor();
  const { project } = useStoreValue(editor.project);
  const selection = useSelector(editor.ui, (u) => u.selection);
  const caps = useSelector(editor.ui, (u) => u.aiCaps);
  const jobs = useSelector(editor.ui, (u) => u.aiJobs);
  const clip = project.clips.find((c) => c.id === selection[0]);
  const media = clip && clip.kind !== 'component' ? (clip as MediaClip) : null;
  const asset = media ? project.assets.find((a) => a.id === media.assetId) : undefined;
  const transcript = media ? editor.transcriptForAsset(media.assetId) : undefined;
  const busy = jobs.some((j) => j.status === 'running' || j.status === 'queued');

  const [thresholdDb, setThresholdDb] = useState(-38);
  const [minSilence, setMinSilence] = useState(400);
  const [keep, setKeep] = useState(150);
  const [reduction, setReduction] = useState(15);
  const [engine, setEngine] = useState('auto');
  const [matteMode, setMatteMode] = useState<'person' | 'chroma'>('person');
  const [aspect, setAspect] = useState('9:16');
  const [resize, setResize] = useState(false);
  const [brollApply, setBrollApply] = useState(false);

  const target = media ? { clipId: media.id } : null;
  const run = (op: Parameters<typeof editor.runAi>[0], params: Record<string, unknown>) => void editor.runAi(op, { ...(target ?? {}), ...params });
  const hasSpeechEngine = caps?.whisper.available ?? false;
  const hasVision = caps?.vision.available ?? false;

  return (
    <>
      <div className="panel-header">
        <NeonIcon icon={Sparkles} size={12} tone="green" glow={2} />
        <span className="title">AI tools</span>
        <button className="btn sm ghost" onClick={() => void editor.loadAiStatus(true)} title="Re-detect engines">engines</button>
      </div>
      <div className="panel-body">
        {caps ? (
          <div className="row" style={{ flexWrap: 'wrap', gap: 4, marginBottom: 10 }}>
            <span className={`pill ${caps.ffmpeg.available ? 'green' : 'red'}`} title={caps.ffmpeg.available ? 'ffmpeg + ffprobe' : 'ffmpeg missing — installed automatically on launch/first use, or run `neon-cli ai setup`'}>ffmpeg</span>
            <span className={`pill ${caps.whisper.available ? 'green' : 'red'}`} title={caps.whisper.model ?? (caps as unknown as { hints?: Record<string, string> }).hints?.whisper ?? 'speech recognition not installed'}>whisper</span>
            <span className={`pill ${caps.vision.available ? 'green' : 'red'}`} title="Apple Vision helper">vision</span>
            <span className={`pill ${caps.rnnoise.available ? 'green' : ''}`} title="RNNoise model for ffmpeg arnndn">rnnoise</span>
            <span className={`pill ${caps.deepfilter.available ? 'green' : ''}`} title="DeepFilterNet binary">deepfilter</span>
            <span className={`pill ${caps.ytdlp.available ? 'green' : ''}`} title="yt-dlp for ripping web videos">yt-dlp</span>
            <span className={`pill ${caps.claude.available ? 'cyan' : ''}`} title="ANTHROPIC_API_KEY for B-roll concept matching">claude</span>
          </div>
        ) : (
          <p className="hint">Detecting engines…</p>
        )}

        {caps && !caps.whisper.available ? (
          <div className="callout-install" style={{ border: '1px solid rgba(255,184,0,.5)', borderRadius: 6, padding: '10px 12px', marginBottom: 12 }}>
            <p className="hint" style={{ marginBottom: 8 }}><b style={{ color: 'var(--warning)' }}>Speech recognition is not installed.</b> Transcription, filler removal, B-roll and the Script editor need whisper.cpp (~150 MB, one time, fully local).</p>
            <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
              <button className="btn sm magenta" disabled={busy} onClick={() => run('setup', { model: 'base.en' })}>Install automatically</button>
              <button
                className="btn sm ghost"
                onClick={() => {
                  // The server sends platform-appropriate hints (brew / winget / manual download).
                  const cmd = (caps as unknown as { hints?: Record<string, string> }).hints?.whisper ?? 'see `neon-cli ai status` for the install command';
                  void navigator.clipboard.writeText(cmd);
                  editor.toast('success', 'Install command copied — paste it into a terminal');
                }}
              >
                Copy command instead
              </button>
            </div>
          </div>
        ) : null}
        {!media ? (
          <div className="empty">
            <strong>Select a video or audio clip</strong>
            <br />
            to clean its voice track, remove its background or reframe it. B-roll suggestions work on the whole project.
          </div>
        ) : (
          <>
            <p className="hint" style={{ marginBottom: 8 }}>
              <b style={{ color: 'var(--text)' }}>{media.name}</b> · {asset?.kind}
              {transcript ? ` · ${transcript.words.length} words transcribed` : ' · not transcribed yet'}
              {media.volumeKeyframes?.length ? ' · volume automation' : ''}
              {media.reframe ? ` · reframed (${media.reframe.mode})` : ''}
              {asset?.hasAlpha ? ' · alpha' : ''}
            </p>

            <Section icon={Mic} title="Voice clean-up" tone="cyan">
              <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
                <button className="btn sm cyan" disabled={busy || !hasSpeechEngine} title={hasSpeechEngine ? '' : 'Install whisper.cpp (see engines)'} onClick={() => run('fillers', { apply: true })}>
                  <NeonIcon icon={Eraser} size={13} tone="cyan" /> Remove um/uh/like
                </button>
                <button className="btn sm ghost" disabled={busy || !hasSpeechEngine} onClick={() => run('fillers', { apply: false })}>preview</button>
              </div>
              <div className="row" style={{ gap: 6, marginTop: 6, flexWrap: 'wrap' }}>
                <button className="btn sm cyan" disabled={busy} onClick={() => run('silence', { apply: true, thresholdDb, minSilenceMs: minSilence, keepMs: keep })}>
                  <NeonIcon icon={AudioLines} size={13} tone="cyan" /> Trim dead air
                </button>
                <label className="hint">min <input className="input mono" style={{ width: 58, display: 'inline-block', padding: '2px 4px' }} type="number" value={minSilence} onChange={(e) => setMinSilence(Number(e.target.value))} /> ms</label>
                <label className="hint">keep <input className="input mono" style={{ width: 58, display: 'inline-block', padding: '2px 4px' }} type="number" value={keep} onChange={(e) => setKeep(Number(e.target.value))} /> ms</label>
                <label className="hint">thr <input className="input mono" style={{ width: 58, display: 'inline-block', padding: '2px 4px' }} type="number" value={thresholdDb} onChange={(e) => setThresholdDb(Number(e.target.value))} /> dB</label>
              </div>
              <div className="row" style={{ gap: 6, marginTop: 6, flexWrap: 'wrap' }}>
                <button className="btn sm cyan" disabled={busy} onClick={() => run('breaths', { reductionDb: reduction })}>
                  <NeonIcon icon={Wind} size={13} tone="cyan" /> Soften breaths
                </button>
                <label className="hint">−<input className="input mono" style={{ width: 48, display: 'inline-block', padding: '2px 4px' }} type="number" value={reduction} onChange={(e) => setReduction(Number(e.target.value))} /> dB</label>
                {media.volumeKeyframes?.length ? <button className="btn sm ghost" onClick={() => editor.updateClip(media.id, { volumeKeyframes: null })}>clear</button> : null}
              </div>
              <div className="row" style={{ gap: 6, marginTop: 6, flexWrap: 'wrap' }}>
                <button className="btn sm cyan" disabled={busy} onClick={() => run('denoise', { engine })}>
                  <NeonIcon icon={Brain} size={13} tone="cyan" /> Denoise
                </button>
                <select className="select" style={{ width: 'auto', padding: '2px 6px' }} value={engine} onChange={(e) => setEngine(e.target.value)}>
                  <option value="auto">auto</option>
                  <option value="rnnoise">rnnoise (neural)</option>
                  <option value="afftdn">afftdn (spectral)</option>
                  <option value="deepfilter">DeepFilterNet</option>
                </select>
              </div>
              <div className="row" style={{ gap: 6, marginTop: 6, flexWrap: 'wrap' }}>
                <button className="btn sm cyan" disabled={busy} title="High-pass → de-ess → compress → loudness normalise to -16 LUFS" onClick={() => run('enhance', { lufs: -16 })}>
                  <NeonIcon icon={AudioLines} size={13} tone="cyan" glow={2} /> Enhance voice
                </button>
                <span className="hint">clarity + broadcast loudness</span>
              </div>
              <button className="btn magenta" style={{ width: '100%', justifyContent: 'center', marginTop: 8 }} disabled={busy} onClick={() => run('clean', { fillers: hasSpeechEngine, silences: true, breaths: true, denoise: false })}>
                <NeonIcon icon={Sparkles} size={13} tone="magenta" /> Clean up voice (all of the above)
              </button>
            </Section>

            <Section icon={Captions} title="Transcript" tone="green">
              <div className="row" style={{ gap: 6 }}>
                <button className="btn sm" disabled={busy || !hasSpeechEngine} onClick={() => run('transcribe', {})}>{transcript ? 'Re-transcribe' : 'Transcribe'}</button>
                <button className="btn sm ghost" disabled={!transcript} onClick={() => editor.setPanel('script')}><NeonIcon icon={MessageSquareText} size={13} tone="green" /> Open script editor</button>
              </div>
            </Section>

            {asset?.kind === 'video' ? (
              <>
                <Section icon={UserRound} title="Background removal" tone="magenta">
                  <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
                    <select className="select" style={{ width: 'auto', padding: '2px 6px' }} value={matteMode} onChange={(e) => setMatteMode(e.target.value as 'person' | 'chroma')}>
                      <option value="person">person (Apple Vision)</option>
                      <option value="chroma">green screen (chroma key)</option>
                    </select>
                    <button className="btn sm magenta" disabled={busy || (matteMode === 'person' && !hasVision)} onClick={() => run('matte', { mode: matteMode })}>Remove background</button>
                  </div>
                  <p className="hint">Produces a ProRes 4444 clip with alpha and swaps it in; the original stays in Media.</p>
                </Section>
                <Section icon={Crop} title="Auto-reframe" tone="magenta">
                  <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
                    <select className="select" style={{ width: 'auto', padding: '2px 6px' }} value={aspect} onChange={(e) => setAspect(e.target.value)}>
                      <option value="9:16">9:16 vertical</option>
                      <option value="1:1">1:1 square</option>
                      <option value="4:5">4:5 portrait</option>
                      <option value="16:9">16:9</option>
                    </select>
                    <label className="hint"><input type="checkbox" checked={resize} onChange={(e) => setResize(e.target.checked)} /> resize project</label>
                    <button className="btn sm magenta" disabled={busy || !hasVision} onClick={() => run('reframe', { aspect, resizeProject: resize })}>Track face & reframe</button>
                    {media.reframe ? <button className="btn sm ghost" onClick={() => editor.updateClip(media.id, { reframe: null, fit: 'contain' })}>clear</button> : null}
                  </div>
                </Section>
              </>
            ) : null}
          </>
        )}

        <Section icon={Sparkles} title="B-roll from the script" tone="green">
          <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
            <button className="btn sm" disabled={busy || !hasSpeechEngine} onClick={() => void editor.runAi('broll', { apply: brollApply, assetId: media?.assetId })}>Suggest B-roll</button>
            <label className="hint"><input type="checkbox" checked={brollApply} onChange={(e) => setBrollApply(e.target.checked)} /> place automatically</label>
          </div>
          <p className="hint">Matches what is said against your Media library names{caps?.claude.available ? ' (Claude picks the concepts)' : ' — set ANTHROPIC_API_KEY to let Claude pick concepts'}.</p>
        </Section>

        <div className="panel-header" style={{ padding: '10px 0 6px' }}><span className="title">Jobs · {jobs.length}</span></div>
        {jobs.length === 0 ? <div className="hint">No AI jobs yet.</div> : null}
        {jobs.slice(0, 12).map((job) => (
          <div key={job.id} className="list-item" style={{ cursor: 'default', flexDirection: 'column', alignItems: 'stretch', gap: 6 }}>
            <div className="row between">
              <span className="mono" style={{ fontSize: 11 }}>{job.op}</span>
              <span className={`pill ${statusTone(job.status)}`}>{job.status}</span>
            </div>
            <div className="progress"><div style={{ width: `${Math.round(job.progress * 100)}%` }} /></div>
            <div className="row between hint">
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{job.message}</span>
              {job.status === 'running' || job.status === 'queued' ? <button className="btn sm ghost" onClick={() => void editor.cancelAi(job.id)}><NeonIcon icon={X} size={12} tone="red" /></button> : null}
            </div>
            {job.status === 'done' && job.op === 'broll' ? <BrollResult job={job} /> : null}
          </div>
        ))}
      </div>
    </>
  );
}

function Section({ icon, title, tone, children }: { icon: typeof Mic; title: string; tone: 'cyan' | 'magenta' | 'green'; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 12, padding: '8px 10px', border: '1px solid var(--border-subtle)', borderRadius: 6 }}>
      <div className="row" style={{ gap: 6, marginBottom: 6, fontSize: 11, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--muted)' }}>
        <NeonIcon icon={icon} size={12} tone={tone} /> {title}
      </div>
      {children}
    </div>
  );
}

function BrollResult({ job }: { job: AiJob }) {
  const editor = useEditor();
  const r = job.result as { suggestions: { startS: number; endS: number; keyword: string; assetName: string; assetId: string; reason: string; source: string }[]; applied: boolean } | undefined;
  if (!r || r.suggestions.length === 0) return <div className="hint">No matches — name library files after what they show.</div>;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      {r.suggestions.slice(0, 8).map((s, i) => (
        <div key={i} className="row between hint" style={{ gap: 6 }}>
          <span className="mono">{s.startS.toFixed(1)}s</span>
          <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={s.reason}>{s.keyword} → {s.assetName} <span className={`pill ${s.source === 'claude' ? 'cyan' : ''}`}>{s.source}</span></span>
          {!r.applied ? <button className="btn sm ghost" onClick={() => editor.insertAsset(s.assetId, Math.round(s.startS * editor.fps))}>place</button> : null}
        </div>
      ))}
    </div>
  );
}
