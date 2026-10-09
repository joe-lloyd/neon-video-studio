import React, { useMemo } from 'react';
import { AbsoluteFill, useCurrentFrame, useVideoConfig } from 'remotion';
import { cueAt, parseTrackList, projectCaptions, type CaptionCue, type CaptionsProps } from '@neon/core';
import { useTimelineFrame, useTimelineProject } from '@neon/fx-kit';
import { SANS, useUiScale } from './shared.ts';

const SAMPLE = ['Captions', 'follow', 'every', 'cut', 'you', 'make.'];

/** Outside the timeline (the FX library card) there is no transcript: show a sample cue over the clip. */
function sampleCue(durationInFrames: number): CaptionCue {
  const step = durationInFrames / SAMPLE.length;
  const words = SAMPLE.map((text, i) => ({ text, start: Math.round(i * step), end: Math.round((i + 1) * step) }));
  return { start: 0, end: durationInFrames, text: SAMPLE.join(' '), words };
}

/**
 * Burned-in subtitles. The cues come from the project's transcripts placed on the current timeline
 * (@neon/core captions.ts), so they follow cuts, splits and speed changes without being re-made.
 * The clip can span any part of the timeline: it shows whatever is spoken under it.
 */
export const Captions: React.FC<CaptionsProps> = ({ style, position, fontSize, maxWords, color, highlightColor, background, backgroundColor, tracks }) => {
  const project = useTimelineProject();
  const timelineFrame = useTimelineFrame();
  const localFrame = useCurrentFrame();
  const { durationInFrames } = useVideoConfig();
  const s = useUiScale();

  const cues = useMemo(() => (project ? projectCaptions(project, { tracks: parseTrackList(tracks), maxWords }) : null), [project, tracks, maxWords]);
  const frame = timelineFrame ?? localFrame;
  const cue = cues ? cueAt(cues, frame) : sampleCue(durationInFrames);
  if (!cue) return null;

  // Karaoke: the latest word that has started stays lit through the short gaps between words.
  const active = style === 'karaoke' ? cue.words.findLastIndex((w) => w.start <= frame) : -1;

  const size = fontSize * s;
  const outline = background ? undefined : `0 0 ${0.08 * size}px #000, 0 0 ${0.16 * size}px #000, 0 ${0.04 * size}px ${0.04 * size}px #000`;
  return (
    <AbsoluteFill
      style={{
        justifyContent: position === 'top' ? 'flex-start' : position === 'middle' ? 'center' : 'flex-end',
        alignItems: 'center',
        padding: `${90 * s}px ${96 * s}px`,
      }}
    >
      <div
        style={{
          maxWidth: '82%',
          fontFamily: SANS,
          fontSize: size,
          fontWeight: 700,
          lineHeight: 1.28,
          letterSpacing: '0.005em',
          textAlign: 'center',
          color,
          textShadow: outline,
          background: background ? backgroundColor : undefined,
          borderRadius: 0.32 * size,
          padding: background ? `${0.22 * size}px ${0.55 * size}px` : 0,
        }}
      >
        {cue.words.map((w, i) => (
          <React.Fragment key={`${w.start}-${i}`}>
            {i > 0 ? ' ' : null}
            <span style={i === active ? { color: highlightColor } : undefined}>{w.text}</span>
          </React.Fragment>
        ))}
      </div>
    </AbsoluteFill>
  );
};
