/**
 * @neon/motion — Neon's frame-based React video engine.
 *
 * A composition is a React component that reads the current frame with `useCurrentFrame()` and
 * the canvas with `useVideoConfig()`, and derives everything it draws from those. The same
 * component runs in the preview (`@neon/motion/player`) and in the headless exporter
 * (`@neon/motion/node`), so every frame looks the same in both.
 *
 * The API deliberately mirrors the conventions FX-pack authors already know (AbsoluteFill,
 * Sequence, interpolate, spring, …); packs that import `remotion` are pointed at this module.
 */
export { AbsoluteFill, Sequence, Series, Loop, Freeze, type SequenceProps, type LoopProps, type SeriesSequenceProps } from './components.tsx';
export { Img, Video, OffthreadVideo, Audio, type ImgProps, type VideoProps, type AudioProps, type VolumeProp } from './media.tsx';
export {
  useCurrentFrame,
  useVideoConfig,
  useCurrentScale,
  useEnvironment,
  CompositionRoot,
  type VideoConfig,
  type RenderMode,
  type Environment,
  type AudioFrameEntry,
  type MediaRegistry,
  type CompositionRootProps,
} from './context.tsx';
export { interpolate, type InterpolateOptions, type ExtrapolateType } from './interpolate.ts';
export { Easing, bezier, type EasingFunction } from './easing.ts';
export { spring, measureSpring, DEFAULT_SPRING_CONFIG, type SpringConfig, type SpringOptions } from './spring.ts';
export { interpolateColors, parseColor } from './color.ts';
export { random } from './random.ts';
export { delayRender, continueRender, cancelRender } from './delay-render.ts';
export { type CompositionMetadata, type CalculateMetadataFunction } from './metadata.ts';
