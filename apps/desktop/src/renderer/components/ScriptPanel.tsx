import { useMemo } from 'react';
import type { MediaClip } from '@neon/core';
import { Captions, NeonIcon, Scissors } from '@neon/icon-kit';
import { useEditor } from '../lib/context.ts';
import { useSelector, useStoreValue } from '../lib/store.ts';

/**
 * Text-driven editing: the transcript of the selected clip's asset (or the first transcript in
 * the project). Click a word to jump there; shift-click to extend a selection; ⌫ / "Cut" removes
 * the selected words from the timeline (all tracks, ripple, tiny crossfades).
 */
export function ScriptPanel() {
  const editor = useEditor();
  const { project } = useStoreValue(editor.project);
  const selection = useSelector(editor.ui, (u) => u.selection);
  const scriptSel = useSelector(editor.ui, (u) => u.scriptSelection);
  const playhead = useStoreValue(editor.playhead).frame;
  const fps = project.meta.fps;

  const clip = project.clips.find((c) => c.id === selection[0]);
  const media = clip && clip.kind !== 'component' ? (clip as MediaClip) : null;
  const transcript = (media ? editor.transcriptForAsset(media.assetId) : undefined) ?? project.transcripts[0];
  const asset = transcript ? project.assets.find((a) => a.id === transcript.assetId) : undefined;

  // Which word is under the playhead (via the clips that show this asset).
  const activeIndex = useMemo(() => {
    if (!transcript) return -1;
    const family = new Set([transcript.assetId]);
    for (const a of project.assets) if (a.derivedFrom === transcript.assetId) family.add(a.id);
    const clips = project.clips.filter((c): c is MediaClip => c.kind !== 'component' && family.has(c.assetId));
    for (const c of clips) {
      const local = playhead - c.startFrame;
      if (local < 0 || local >= c.durationFrames) continue;
      const seconds = (local + c.trimBefore) / fps;
      return transcript.words.findIndex((w) => seconds >= w.s && seconds < w.e + 0.05);
    }
    return -1;
  }, [transcript, project.clips, playhead, fps]);

  if (!transcript) {
    return (
      <>
        <div className="panel-header"><NeonIcon icon={Captions} size={12} tone="green" /><span className="title">Script</span></div>
        <div className="panel-body">
          <div className="empty">
            <strong>No transcript yet.</strong>
            <br />
            Select a clip with speech and run <b>Transcribe</b> in the AI tab (or <span className="mono">neon-cli ai transcribe</span>).
            {media ? (
              <div style={{ marginTop: 10 }}>
                <button className="btn sm cyan" onClick={() => void editor.runAi('transcribe', { clipId: media.id })}>Transcribe “{media.name}”</button>
              </div>
            ) : null}
          </div>
        </div>
      </>
    );
  }

  const inSelection = (i: number) => scriptSel && scriptSel.assetId === transcript.assetId && i >= Math.min(scriptSel.from, scriptSel.to) && i <= Math.max(scriptSel.from, scriptSel.to);
  const selectedCount = scriptSel && scriptSel.assetId === transcript.assetId ? Math.abs(scriptSel.to - scriptSel.from) + 1 : 0;
  const fillers = transcript.words.filter((w) => w.filler).length;

  return (
    <>
      <div className="panel-header">
        <NeonIcon icon={Captions} size={12} tone="green" />
        <span className="title">Script · {asset?.name ?? transcript.assetId.slice(0, 8)}</span>
        <button className="btn sm danger" disabled={selectedCount === 0} onClick={() => void editor.cutScriptSelection()} title="Remove the selected words from the video (⌫)">
          <NeonIcon icon={Scissors} size={12} tone="red" /> Cut {selectedCount ? `${selectedCount} word${selectedCount === 1 ? '' : 's'}` : ''}
        </button>
      </div>
      <div className="panel-body script-body" tabIndex={0}>
        <p className="hint" style={{ marginBottom: 8 }}>
          {transcript.words.length} words · {fillers} fillers highlighted · click = jump, shift-click = select range, ⌫ = cut
          {fillers ? <> · <button className="btn sm ghost" onClick={() => void editor.runAi('fillers', { assetId: transcript.assetId, apply: true })}>remove all fillers</button></> : null}
        </p>
        <div className="script-words">
          {transcript.words.map((w, i) => (
            <span
              key={i}
              className={`word${w.filler ? ' filler' : ''}${i === activeIndex ? ' active' : ''}${inSelection(i) ? ' selected' : ''}`}
              title={`${w.s.toFixed(2)}s – ${w.e.toFixed(2)}s${w.p !== undefined ? ` · p=${w.p.toFixed(2)}` : ''}`}
              onClick={(e) => {
                if (e.shiftKey && scriptSel && scriptSel.assetId === transcript.assetId) editor.ui.set({ scriptSelection: { ...scriptSel, to: i } });
                else editor.ui.set({ scriptSelection: { assetId: transcript.assetId, from: i, to: i } });
                const frame = editor.timelineFrameForSource(transcript.assetId, w.s);
                if (frame !== null) editor.seek(frame);
              }}
            >
              {w.w}
            </span>
          ))}
        </div>
      </div>
    </>
  );
}
