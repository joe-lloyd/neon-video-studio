import { useMemo } from 'react';
import type { MediaClip } from '@neon/core';
import { Captions, NeonIcon, Scissors, VolumeX } from '@neon/icon-kit';
import { useEditor } from '../lib/context.ts';
import { kbdFor } from '../lib/kbd.ts';
import { useSelector, useStoreValue } from '../lib/store.ts';

/**
 * Text-driven editing: the transcript of the selected clip's asset (or the first transcript in
 * the project). Click a word to jump there; shift-click extends a range; ⌘/Ctrl-click adds
 * individual words. "Cut video" ripple-cuts video+audio (all tracks); "Mute words" only zeroes
 * the audio in place — the fix-my-voice-over case, nothing on the timeline moves.
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

  const kbd = kbdFor(editor.bridge.bootstrap.platform);
  const selWords = scriptSel && scriptSel.assetId === transcript.assetId ? scriptSel.words : [];
  const inSelection = (i: number) => selWords.includes(i);
  const selectedCount = selWords.length;
  const fillers = transcript.words.filter((w) => w.filler).length;
  const label = selectedCount ? `${selectedCount} word${selectedCount === 1 ? '' : 's'}` : '';

  const selectWord = (i: number, e: React.MouseEvent) => {
    const addKey = e.metaKey || e.ctrlKey;
    if (e.shiftKey && scriptSel && scriptSel.assetId === transcript.assetId) {
      // Extend a contiguous range from the anchor; ⌘/Ctrl keeps previously added words too.
      const lo = Math.min(scriptSel.anchor, i);
      const hi = Math.max(scriptSel.anchor, i);
      const range = Array.from({ length: hi - lo + 1 }, (_, n) => lo + n);
      const words = addKey ? [...new Set([...scriptSel.words, ...range])] : range;
      editor.ui.set({ scriptSelection: { assetId: transcript.assetId, words, anchor: scriptSel.anchor } });
    } else if (addKey && scriptSel && scriptSel.assetId === transcript.assetId) {
      const words = scriptSel.words.includes(i) ? scriptSel.words.filter((w) => w !== i) : [...scriptSel.words, i];
      editor.ui.set({ scriptSelection: words.length ? { assetId: transcript.assetId, words, anchor: i } : null });
    } else {
      editor.ui.set({ scriptSelection: { assetId: transcript.assetId, words: [i], anchor: i } });
    }
    const frame = editor.timelineFrameForSource(transcript.assetId, transcript.words[i]!.s);
    if (frame !== null) editor.seek(frame);
  };

  return (
    <>
      <div className="panel-header">
        <NeonIcon icon={Captions} size={12} tone="green" />
        <span className="title">Script · {asset?.name ?? transcript.assetId.slice(0, 8)}</span>
        <button
          className="btn sm"
          disabled={selectedCount === 0}
          onClick={() => void editor.cutScriptSelection('audio')}
          title="Mute just these words in the audio — the video keeps playing, nothing moves (fix a voice-over)"
        >
          <NeonIcon icon={VolumeX} size={12} tone="cyan" /> Mute {label}
        </button>
        <button
          className="btn sm danger"
          disabled={selectedCount === 0}
          onClick={() => void editor.cutScriptSelection('timeline')}
          title="Remove these words from the video AND audio (all tracks, ripple) (⌫)"
        >
          <NeonIcon icon={Scissors} size={12} tone="red" /> Cut {label}
        </button>
      </div>
      <div className="panel-body script-body" tabIndex={0}>
        <p className="hint" style={{ marginBottom: 8 }}>
          {transcript.words.length} words · {fillers} fillers highlighted · click = jump · shift = range · {kbd.isMac ? '⌘' : 'Ctrl'}-click = add words · ⌫ = cut video
          {fillers ? <> · <button className="btn sm ghost" onClick={() => void editor.runAi('fillers', { assetId: transcript.assetId, apply: true })}>remove all fillers</button></> : null}
        </p>
        <div className="script-words">
          {transcript.words.map((w, i) => (
            <span
              key={i}
              className={`word${w.filler ? ' filler' : ''}${i === activeIndex ? ' active' : ''}${inSelection(i) ? ' selected' : ''}`}
              title={`${w.s.toFixed(2)}s – ${w.e.toFixed(2)}s${w.p !== undefined ? ` · p=${w.p.toFixed(2)}` : ''}`}
              onClick={(e) => selectWord(i, e)}
            >
              {w.w}
            </span>
          ))}
        </div>
      </div>
    </>
  );
}
