import React from 'react';
import { AbsoluteFill, Freeze, Sequence, type CalculateMetadataFunction } from 'remotion';
import { framesToTimecode, projectDurationFrames, sheetLayout } from '@neon/core';
import { TimelineComposition, type TimelineProps } from './TimelineComposition.tsx';

/** A grid of timeline frames in one still: each cell is the timeline frozen at its frame. */
export type ContactSheetProps = {
  timeline: TimelineProps;
  /** Project frames, one per cell. */
  frames: number[];
  cols: number;
  /** Sheet width in pixels; the height follows from the grid. */
  width: number;
};

export const calculateSheetMetadata: CalculateMetadataFunction<ContactSheetProps> = ({ props }) => {
  const { meta } = props.timeline.project;
  const layout = sheetLayout({ frames: props.frames, cols: props.cols, width: props.width, source: meta });
  // Project fps and full duration, so the frozen timeline's sequences resolve exactly as in a render.
  const durationInFrames = Math.max(1, projectDurationFrames(props.timeline.project));
  return { width: layout.width, height: layout.height, fps: meta.fps, durationInFrames, props };
};

export const ContactSheet: React.FC<ContactSheetProps> = ({ timeline, frames, cols, width }) => {
  const { meta } = timeline.project;
  const layout = sheetLayout({ frames, cols, width, source: meta });
  const scale = layout.cellWidth / meta.width;
  const fontSize = Math.round(layout.labelHeight * 0.62);
  return (
    <AbsoluteFill style={{ backgroundColor: '#141414' }}>
      {layout.cells.map((cell) => (
        <div key={cell.frame} style={{ position: 'absolute', left: cell.x, top: cell.y, width: layout.cellWidth, height: layout.cellHeight + layout.labelHeight }}>
          <div style={{ position: 'absolute', left: 0, top: 0, width: layout.cellWidth, height: layout.cellHeight, overflow: 'hidden' }}>
            {/* Lay the timeline out at project size, then shrink it, so text and FX keep their proportions. */}
            <Sequence width={meta.width} height={meta.height} style={{ transform: `scale(${scale})`, transformOrigin: '0 0' }}>
              <Freeze frame={cell.frame}>
                <TimelineComposition {...timeline} />
              </Freeze>
            </Sequence>
          </div>
          <div
            style={{
              position: 'absolute',
              left: 0,
              top: layout.cellHeight,
              height: layout.labelHeight,
              lineHeight: `${layout.labelHeight}px`,
              fontFamily: 'ui-monospace, Menlo, "DejaVu Sans Mono", monospace',
              fontSize,
              color: '#d8d8d8',
            }}
          >
            {framesToTimecode(cell.frame, meta.fps)}
          </div>
        </div>
      ))}
    </AbsoluteFill>
  );
};
