import type { CalculateMetadataFunction } from '@neon/motion';
import { DEFAULT_PROJECT_META, projectDurationFrames } from '@neon/core';
import type { TimelineProps } from './compositions/TimelineComposition.tsx';

export const TIMELINE_COMPOSITION_ID = 'Timeline';
export const SHEET_COMPOSITION_ID = 'ContactSheet';

/** Output size, rate and length of the Timeline composition for a project (+ optional render overrides). */
export const calculateTimelineMetadata: CalculateMetadataFunction<TimelineProps> = ({ props }) => {
  const projectFps = props.project.meta.fps || DEFAULT_PROJECT_META.fps;
  const fps = props.render?.fps ?? projectFps;
  const width = props.render?.width ?? props.project.meta.width;
  const height = props.render?.height ?? props.project.meta.height;
  const scale = fps / projectFps;
  const durationInFrames = Math.max(1, Math.round(projectDurationFrames(props.project) * scale));
  return { durationInFrames, fps, width, height };
};
