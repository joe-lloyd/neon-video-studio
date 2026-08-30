import React, { useMemo } from 'react';
import { AbsoluteFill, Audio, Img, OffthreadVideo, Sequence, interpolate, useCurrentFrame, useVideoConfig } from 'remotion';
import { sortClips, sortTracks, type Asset, type Clip, type MediaClip, type Project, type Track } from '@neon/core';
import { TEMPLATES } from '../templates/index.ts';

/** Kept as a type alias (not an interface) so it satisfies Remotion's Record<string, unknown> constraint. */
export type TimelineProps = {
  project: Project;
  /** http://host:port/assets */
  assetBaseUrl: string;
  /** Optional query string (without '?') appended to asset URLs, e.g. a room key. */
  assetQuery?: string;
  /** Output overrides; null = project settings. */
  render: { width: number; height: number; fps: number } | null;
};

export function assetUrl(base: string, asset: Pick<Asset, 'id'>, query?: string): string {
  const url = `${base.replace(/\/$/, '')}/${asset.id}`;
  return query ? `${url}?${query}` : url;
}

/** Opacity/volume envelope for fades, evaluated against the clip-local frame. */
function fadeEnvelope(frame: number, durationFrames: number, fadeIn: number, fadeOut: number): number {
  let v = 1;
  if (fadeIn > 0) v *= interpolate(frame, [0, fadeIn], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
  if (fadeOut > 0) {
    v *= interpolate(frame, [Math.max(0, durationFrames - fadeOut), durationFrames], [1, 0], {
      extrapolateLeft: 'clamp',
      extrapolateRight: 'clamp',
    });
  }
  return v;
}

const MediaClipView: React.FC<{ clip: MediaClip; asset: Asset | undefined; track: Track; props: TimelineProps; scale: number }> = ({
  clip,
  asset,
  track,
  props,
  scale,
}) => {
  const frame = useCurrentFrame();
  const { durationInFrames } = useVideoConfig();
  if (!asset) return <MissingBox label={`Missing asset ${clip.assetId.slice(0, 8)}…`} />;
  const src = assetUrl(props.assetBaseUrl, asset, props.assetQuery);
  const envelope = fadeEnvelope(frame, durationInFrames, Math.round(clip.fadeIn * scale), Math.round(clip.fadeOut * scale));
  const volume = track.muted ? 0 : Math.max(0, Math.min(2, clip.volume)) * envelope;
  const trimBefore = Math.round(clip.trimBefore * scale);
  const style: React.CSSProperties = { width: '100%', height: '100%', objectFit: clip.fit };

  if (clip.kind === 'audio') {
    return <Audio src={src} trimBefore={trimBefore} volume={volume} />;
  }
  if (clip.kind === 'image') {
    return (
      <AbsoluteFill style={{ opacity: envelope }}>
        <Img src={src} style={style} />
      </AbsoluteFill>
    );
  }
  return (
    <AbsoluteFill style={{ opacity: envelope }}>
      <OffthreadVideo src={src} trimBefore={trimBefore} volume={volume} style={style} pauseWhenBuffering />
    </AbsoluteFill>
  );
};

const MissingBox: React.FC<{ label: string }> = ({ label }) => (
  <AbsoluteFill
    style={{
      justifyContent: 'center',
      alignItems: 'center',
      color: '#FF3B3B',
      fontFamily: 'ui-monospace, Menlo, monospace',
      fontSize: 32,
      background: 'repeating-linear-gradient(45deg, rgba(255,59,59,0.15) 0 20px, transparent 20px 40px)',
    }}
  >
    {label}
  </AbsoluteFill>
);

const ComponentClipView: React.FC<{ clip: Extract<Clip, { kind: 'component' }> }> = ({ clip }) => {
  const Template = TEMPLATES[clip.componentName];
  if (!Template) return <MissingBox label={`Unknown component ${clip.componentName}`} />;
  return <Template {...clip.props} />;
};

export const TimelineComposition: React.FC<TimelineProps> = (props) => {
  const { fps } = useVideoConfig();
  const { project } = props;
  const scale = fps / (project.meta.fps || fps);
  const assetsById = useMemo(() => new Map(project.assets.map((a) => [a.id, a])), [project.assets]);
  const tracks = useMemo(() => sortTracks(project.tracks).filter((t) => !t.hidden), [project.tracks]);
  const clipsByTrack = useMemo(() => {
    const map = new Map<string, Clip[]>();
    for (const clip of sortClips(project.clips)) {
      const list = map.get(clip.trackId) ?? [];
      list.push(clip);
      map.set(clip.trackId, list);
    }
    return map;
  }, [project.clips]);

  return (
    <AbsoluteFill style={{ backgroundColor: project.meta.background || '#000' }}>
      {tracks.map((track) => (
        <React.Fragment key={track.id}>
          {(clipsByTrack.get(track.id) ?? []).map((clip) => {
            const from = Math.round(clip.startFrame * scale);
            const durationInFrames = Math.max(1, Math.round(clip.durationFrames * scale));
            return (
              <Sequence key={clip.id} from={from} durationInFrames={durationInFrames} name={clip.name} layout="none">
                {clip.kind === 'component' ? (
                  <ComponentClipView clip={clip} />
                ) : (
                  <MediaClipView clip={clip} asset={assetsById.get(clip.assetId)} track={track} props={props} scale={scale} />
                )}
              </Sequence>
            );
          })}
        </React.Fragment>
      ))}
    </AbsoluteFill>
  );
};
