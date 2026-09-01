import type { Project, RenderPreset } from '@neon/core';

/** Everything the worker needs, serialised to a temp file and passed via --job. */
export interface RenderJobSpec {
  project: Project;
  outputPath: string;
  preset: RenderPreset;
  /** http://host:port/assets — the composition appends /<sha256> */
  assetBaseUrl: string;
  assetQuery?: string;
  /** Inclusive timeline frame range at *project* fps; null = whole timeline. */
  frameRange?: [number, number] | null;
  bundleCacheDir: string;
  /** Absolute path of the Remotion entry (apps/remotion-workspace/src/index.ts). */
  entryPoint: string;
  /** Directories whose contents invalidate the bundle cache. */
  watchDirs: string[];
  licenseKey?: string;
  concurrency?: number | string | null;
  /** Existing Chrome/Chromium binary to use instead of Remotion's downloaded headless shell. */
  browserExecutable?: string | null;
  /**
   * Directory that already CONTAINS Remotion's binaries (compositor + browser) — Remotion does
   * not populate it. Leave unset to let Remotion manage node_modules/.remotion relative to the
   * worker cwd (the render runtime root, which is writable).
   */
  binariesDirectory?: string | null;
}

export type WorkerEvent =
  | { neon: 1; type: 'stage'; stage: 'bundling' | 'rendering'; message?: string }
  | { neon: 1; type: 'bundle'; cached: boolean; location: string }
  | { neon: 1; type: 'start'; totalFrames: number; width: number; height: number; fps: number }
  | { neon: 1; type: 'progress'; progress: number; renderedFrames: number; encodedFrames: number }
  | { neon: 1; type: 'done'; outputPath: string; durationMs: number }
  | { neon: 1; type: 'error'; message: string; stack?: string };
