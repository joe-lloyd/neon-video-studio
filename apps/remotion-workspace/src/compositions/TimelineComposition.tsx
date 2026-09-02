import React, { useMemo } from 'react';
import { AbsoluteFill, Audio, Img, OffthreadVideo, Sequence, interpolate, spring, useCurrentFrame, useVideoConfig } from 'remotion';
import { sortClips, sortTracks, volumeAt, type Asset, type Clip, type MediaClip, type Project, type Track } from '@neon/core';
import { getTemplateComponent } from '../templates/index.ts';

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
  const fadeIn = Math.round(clip.fadeIn * scale);
  const fadeOut = Math.round(clip.fadeOut * scale);
  const envelope = fadeEnvelope(frame, durationInFrames, fadeIn, fadeOut);
  const baseVolume = track.muted ? 0 : Math.max(0, Math.min(2, clip.volume));
  const keyframes = clip.volumeKeyframes;
  // Volume automation (breath attenuation etc.). Keyframes are in project frames, `f` in output frames.
  const volume = keyframes && keyframes.length
    ? (f: number) => baseVolume * volumeAt(keyframes, f / scale) * fadeEnvelope(f, durationInFrames, fadeIn, fadeOut)
    : baseVolume * envelope;
  const trimBefore = Math.round(clip.trimBefore * scale);
  const style: React.CSSProperties = { width: '100%', height: '100%', objectFit: clip.fit };
  if (clip.reframe && clip.reframe.keyframes.length) {
    // Auto-reframe: keep the tracked subject centred by steering object-position on a covering fit.
    const kfs = clip.reframe.keyframes;
    const local = frame / scale;
    let a = kfs[0]!;
    let b = kfs[kfs.length - 1]!;
    for (let i = 0; i < kfs.length; i++) {
      if (kfs[i]!.frame <= local) a = kfs[i]!;
      if (kfs[i]!.frame >= local) {
        b = kfs[i]!;
        break;
      }
    }
    const t = b.frame === a.frame ? 0 : Math.min(1, Math.max(0, (local - a.frame) / (b.frame - a.frame)));
    const cx = a.cx + (b.cx - a.cx) * t;
    const cy = a.cy + (b.cy - a.cy) * t;
    style.objectFit = 'cover';
    style.objectPosition = `${(cx * 100).toFixed(2)}% ${(cy * 100).toFixed(2)}%`;
  }

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
      <OffthreadVideo src={src} trimBefore={trimBefore} volume={volume} style={style} pauseWhenBuffering transparent={Boolean(asset.hasAlpha)} />
    </AbsoluteFill>
  );
};

/** Enter/exit animation + canvas transform wrapper shared by component, image and video clips. */
const ElementWrapper: React.FC<{ clip: Clip; scale: number; children: React.ReactNode }> = ({ clip, scale, children }) => {
  const frame = useCurrentFrame();
  const { fps, durationInFrames } = useVideoConfig();
  const t = clip.transform;

  let opacity = 1;
  let dx = 0; // percent of canvas
  let dy = 0;
  let popScale = 1;
  const applyAnim = (anim: NonNullable<Clip['animateIn']>, progress: number, dir: 1 | -1) => {
    const inv = 1 - progress;
    switch (anim.type) {
      case 'fade':
        opacity *= progress;
        break;
      case 'slide-up':
        opacity *= progress;
        dy += dir * inv * 12;
        break;
      case 'slide-down':
        opacity *= progress;
        dy -= dir * inv * 12;
        break;
      case 'slide-left':
        opacity *= progress;
        dx += dir * inv * 12;
        break;
      case 'slide-right':
        opacity *= progress;
        dx -= dir * inv * 12;
        break;
      case 'pop':
        opacity *= Math.min(1, progress * 2);
        popScale *= 0.4 + 0.6 * progress;
        break;
    }
  };
  if (clip.animateIn) {
    const d = Math.max(1, Math.round(clip.animateIn.durationFrames * scale));
    const p = clip.animateIn.type === 'pop'
      ? spring({ frame, fps, durationInFrames: d, config: { damping: 11, stiffness: 180 } })
      : interpolate(frame, [0, d], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
    applyAnim(clip.animateIn, p, 1);
  }
  if (clip.animateOut) {
    const d = Math.max(1, Math.round(clip.animateOut.durationFrames * scale));
    const p = interpolate(frame, [durationInFrames - d, durationInFrames], [1, 0], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
    applyAnim(clip.animateOut, p, -1);
  }

  const style: React.CSSProperties = { opacity };
  const parts: string[] = [];
  if (t) parts.push(`translate(${((t.x - 0.5) * 100).toFixed(3)}%, ${((t.y - 0.5) * 100).toFixed(3)}%)`);
  if (dx !== 0 || dy !== 0) parts.push(`translate(${dx.toFixed(3)}%, ${dy.toFixed(3)}%)`);
  const totalScale = (t?.scale ?? 1) * popScale;
  if (totalScale !== 1) parts.push(`scale(${totalScale.toFixed(4)})`);
  if (t?.rotation) parts.push(`rotate(${t.rotation.toFixed(2)}deg)`);
  if (parts.length) style.transform = parts.join(' ');
  // data-clip-id lets the preview's canvas editor find this wrapper and measure the painted
  // content bounds for its manipulation box; inert during headless renders.
  return <AbsoluteFill style={style} data-clip-id={clip.id}>{children}</AbsoluteFill>;
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
  const Template = getTemplateComponent(clip.componentName);
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
                  <ElementWrapper clip={clip} scale={scale}>
                    <ComponentClipView clip={clip} />
                  </ElementWrapper>
                ) : clip.kind === 'audio' ? (
                  <MediaClipView clip={clip} asset={assetsById.get(clip.assetId)} track={track} props={props} scale={scale} />
                ) : (
                  <ElementWrapper clip={clip} scale={scale}>
                    <MediaClipView clip={clip} asset={assetsById.get(clip.assetId)} track={track} props={props} scale={scale} />
                  </ElementWrapper>
                )}
              </Sequence>
            );
          })}
        </React.Fragment>
      ))}
    </AbsoluteFill>
  );
};
