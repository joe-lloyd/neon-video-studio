import React from 'react';
import { Composition, type CalculateMetadataFunction } from 'remotion';
import { DEFAULT_PROJECT_META, projectDurationFrames } from '@neon/core';
import { TimelineComposition, type TimelineProps } from './compositions/TimelineComposition.tsx';

export const TIMELINE_COMPOSITION_ID = 'Timeline';

export const calculateTimelineMetadata: CalculateMetadataFunction<TimelineProps> = ({ props }) => {
  const projectFps = props.project.meta.fps || DEFAULT_PROJECT_META.fps;
  const fps = props.render?.fps ?? projectFps;
  const width = props.render?.width ?? props.project.meta.width;
  const height = props.render?.height ?? props.project.meta.height;
  const scale = fps / projectFps;
  const durationInFrames = Math.max(1, Math.round(projectDurationFrames(props.project) * scale));
  return { durationInFrames, fps, width, height, props, defaultCodec: 'h264' };
};

const EMPTY: TimelineProps = {
  project: {
    meta: { ...DEFAULT_PROJECT_META, id: 'empty', createdAt: '', updatedAt: '' },
    tracks: [],
    clips: [],
    assets: [],
  },
  assetBaseUrl: '',
  assetQuery: '',
  render: null,
};

export const RemotionRoot: React.FC = () => (
  <Composition
    id={TIMELINE_COMPOSITION_ID}
    component={TimelineComposition}
    durationInFrames={30}
    fps={30}
    width={1920}
    height={1080}
    defaultProps={EMPTY}
    calculateMetadata={calculateTimelineMetadata}
  />
);
