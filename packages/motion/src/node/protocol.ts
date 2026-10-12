/**
 * The page contract (render-page.tsx) as plain types, so the Node side never imports .tsx files —
 * callers that type-check without JSX (e.g. @neon/render) can use @neon/motion/node.
 * protocol-check.ts asserts these stay identical to the page's own types.
 */

/** One audible media element on one rendered frame (mirrors AudioFrameEntry in context.tsx). */
export interface AudioFrameEntry {
  src: string;
  /** Position in the source, seconds. */
  mediaTime: number;
  /** Linear gain, 0 = silent. */
  volume: number;
  playbackRate: number;
}

/** Argument of `window.__neonMotion.init()` (mirrors RenderInit in render-page.tsx). */
export interface RenderInit {
  props: Record<string, unknown>;
  config: { id: string; width: number; height: number; fps: number; durationInFrames: number };
  frameServerUrl: string;
}

/** Result of `window.__neonMotion.renderFrame()`. */
export interface RenderFrameResult {
  audio: AudioFrameEntry[];
}
