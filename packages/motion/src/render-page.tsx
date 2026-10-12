/**
 * The page side of the headless renderer. The generated bundle entry calls `registerRenderRoot()`
 * with the composition component; the Node renderer then drives `window.__neonMotion` over CDP:
 *
 *   await __neonMotion.init({ props, config, frameServerUrl })
 *   const { audio } = await __neonMotion.renderFrame(42)   // then Page.captureScreenshot
 *
 * Each renderFrame() commits the frame synchronously, waits for fonts, every delayRender() handle
 * (images and video stills decode through Img) and two animation frames, then reports the audio
 * every mounted media element contributes to that frame.
 */
import React from 'react';
import { flushSync } from 'react-dom';
import { createRoot, type Root } from 'react-dom/client';
import { CompositionRoot, type AudioFrameEntry, type Environment, type VideoConfig } from './context.tsx';
import { pendingDelayRenders, waitForRenderIdle } from './delay-render.ts';
import { COMPOSITION_ATTR, ensureBaselineStyles } from './baseline.ts';

export interface RenderInit {
  props: Record<string, unknown>;
  config: Pick<VideoConfig, 'id' | 'width' | 'height' | 'fps' | 'durationInFrames'>;
  /** Base URL of the frame server, e.g. http://127.0.0.1:4567 */
  frameServerUrl: string;
}

export interface RenderFrameResult {
  audio: AudioFrameEntry[];
}

export interface NeonMotionPage {
  version: 1;
  init(init: RenderInit): Promise<void>;
  renderFrame(frame: number): Promise<RenderFrameResult>;
  pendingDelayRenders(): string[];
}

declare global {
  interface Window {
    __neonMotion?: NeonMotionPage;
    __neonMotionError?: string;
  }
}

function nextAnimationFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- each composition has its own props
type AnyComposition = React.ComponentType<any>;

function isComponent(value: unknown): value is AnyComposition {
  return typeof value === 'function' || (typeof value === 'object' && value !== null && '$$typeof' in value);
}

/**
 * Register what the page can render: one component, or several keyed by composition id (the
 * renderer picks one with `init.config.id`).
 */
export function registerRenderRoot(compositions: AnyComposition | Record<string, AnyComposition>): void {
  const pick = (id: string): AnyComposition => {
    if (isComponent(compositions)) return compositions;
    const found = compositions[id];
    if (!found) throw new Error(`Unknown composition "${id}" (this bundle has: ${Object.keys(compositions).join(', ')})`);
    return found;
  };
  let root: Root | null = null;
  let state: { init: RenderInit; environment: Environment; element: React.ReactElement } | null = null;
  const audio = new Set<() => AudioFrameEntry | null>();

  window.addEventListener('error', (e) => {
    window.__neonMotionError = e.error instanceof Error ? `${e.error.message}\n${e.error.stack ?? ''}` : String(e.message);
  });
  window.addEventListener('unhandledrejection', (e) => {
    window.__neonMotionError = e.reason instanceof Error ? `${e.reason.message}\n${e.reason.stack ?? ''}` : String(e.reason);
  });

  const draw = (frame: number) => {
    if (!root || !state) throw new Error('__neonMotion.init() has not been called');
    const s = state;
    flushSync(() => {
      root!.render(
        <CompositionRoot frame={frame} config={s.init.config} environment={s.environment}>
          {s.element}
        </CompositionRoot>,
      );
    });
  };

  window.__neonMotion = {
    version: 1,
    async init(init) {
      const base = init.frameServerUrl.replace(/\/$/, '');
      const environment: Environment = {
        mode: 'render',
        playing: false,
        muted: true,
        volume: 1,
        scale: 1,
        frameUrl: (src, time, { transparent }) => `${base}/frame?src=${encodeURIComponent(src)}&t=${time.toFixed(6)}${transparent ? '&alpha=1' : ''}`,
        media: {
          registerAudio(getEntry) {
            audio.add(getEntry);
            return () => audio.delete(getEntry);
          },
          setBuffering: () => undefined,
        },
      };
      const container = document.getElementById('root') ?? document.body.appendChild(document.createElement('div'));
      container.id = 'root';
      container.setAttribute(COMPOSITION_ATTR, '');
      ensureBaselineStyles();
      Object.assign(container.style, {
        position: 'relative',
        width: `${init.config.width}px`,
        height: `${init.config.height}px`,
        overflow: 'hidden',
      });
      const Component = pick(init.config.id);
      state = { init, environment, element: <Component {...init.props} /> };
      root ??= createRoot(container);
    },
    async renderFrame(frame) {
      if (window.__neonMotionError) throw new Error(window.__neonMotionError);
      draw(frame);
      await document.fonts.ready;
      await waitForRenderIdle();
      await nextAnimationFrame();
      await nextAnimationFrame();
      if (window.__neonMotionError) throw new Error(window.__neonMotionError);
      const entries: AudioFrameEntry[] = [];
      for (const get of audio) {
        const entry = get();
        if (entry) entries.push(entry);
      }
      return { audio: entries };
    },
    pendingDelayRenders,
  };
}
