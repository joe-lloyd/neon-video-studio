import type { Project, RenderPreset } from '@neon/core';

/** PNG captures. Frames are project frames. */
export type StillTarget =
  /** One frame at project layout, scaled to `width`. */
  | { kind: 'still'; frame: number; width: number }
  /** A grid of frames in one image (the ContactSheet composition). */
  | { kind: 'sheet'; frames: number[]; cols: number; width: number };

/** What a job produces and where it goes. */
export type RenderTarget = (
  | {
      kind: 'video';
      preset: RenderPreset;
      /** Inclusive timeline frame range at *project* fps; null = whole timeline. */
      frameRange: [number, number] | null;
      concurrency?: number | string | null;
    }
  | StillTarget
) & { outputPath: string };

/** Everything every job needs besides its target. */
export interface RenderEnv {
  project: Project;
  /** http://host:port/assets — the composition appends /<sha256> */
  assetBaseUrl: string;
  assetQuery?: string;
  /** Directory for cached composition bundles (one sub-directory per fingerprint). */
  bundleCacheDir: string;
  /** Absolute path of the composition entry (apps/compositions/src/index.ts). */
  entryPoint: string;
  /** Directories whose contents invalidate the bundle cache. */
  watchDirs: string[];
  /**
   * Installed FX packs the project uses. The worker generates an entry that imports each pack's
   * component module and registers it before the composition mounts.
   */
  packs?: { name: string; entry: string }[];
  /** @deprecated Ignored (was the Remotion licence key); kept so older callers still type-check. */
  licenseKey?: string;
  /** Chrome/Chromium to render with; default: $NEON_CHROME_PATH, an installed Chrome, else Chrome Headless Shell (downloaded once). */
  browserExecutable?: string | null;
  /** @deprecated Ignored (Remotion's compositor directory); the renderer only needs ffmpeg on PATH or $NEON_FFMPEG_PATH. */
  binariesDirectory?: string | null;
}

/** Everything the worker needs, serialised to a temp file and passed via --job. */
export type RenderJobSpec = RenderEnv & RenderTarget;

export interface RenderResult {
  outputPath: string;
  durationMs: number;
  /** Output size in pixels. */
  width: number;
  height: number;
}

export type WorkerEvent =
  | { neon: 1; type: 'stage'; stage: 'bundling' | 'rendering'; message?: string }
  | { neon: 1; type: 'bundle'; cached: boolean; location: string }
  | { neon: 1; type: 'start'; totalFrames: number; width: number; height: number; fps: number }
  | { neon: 1; type: 'progress'; progress: number; renderedFrames: number; encodedFrames: number }
  | ({ neon: 1; type: 'done' } & RenderResult)
  | { neon: 1; type: 'error'; message: string; stack?: string };
