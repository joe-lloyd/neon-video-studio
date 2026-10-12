/**
 * @neon/motion/node — the headless renderer: bundle a composition, render it in Chrome over CDP
 * with exact video frames from FFmpeg, mix its audio offline and encode an MP4.
 */
export { bundleComposition, bundleNodeModule, fingerprint, nodeModulesAbove, motionVersion, DEFAULT_ALIAS, type BundleOptions, type BundleEntry, type BundleResult, type NodeBundleOptions } from './bundle.ts';
export { renderStill, type RenderStillOptions, type RenderStillResult } from './still.ts';
export { renderMedia, resolveConcurrency, defaultConcurrency, fpsToRational, type RenderMediaOptions, type RenderMediaResult, type RenderProgress, type RenderComposition } from './render.ts';
export { launchBrowser, resolveBrowserExecutable, findDownloadedShell, downloadChromeHeadlessShell, systemBrowserCandidates, browserCacheDir, chromeArgs, type Browser, type Page, type LaunchOptions, type ResolveBrowserOptions } from './browser.ts';
export { CdpConnection, CdpSession, CdpError } from './cdp.ts';
export { startRenderServer, mimeType, type RenderServer, type RenderServerOptions } from './server.ts';
export { FrameServer, ImageStreamSplitter, selectFrame, parseShowinfoFrame, parseShowinfoTimebase, FRAME_EPSILON, type FrameServerOptions, type FrameResult, type FrameSelection } from './frames.ts';
export { mixAudio, groupAudioSegments, segmentGainAt, atempoChain, softClip, MIX_SAMPLE_RATE, MIX_CHANNELS, type AudioSegment, type MixAudioOptions, type MixAudioResult } from './audio.ts';
export { probeMedia, clearProbeCache, defaultBinaries, type MediaProbe, type FfmpegBinaries } from './probe.ts';
export type { AudioFrameEntry, RenderInit, RenderFrameResult } from './protocol.ts';
export type { CompositionMetadata, CalculateMetadataFunction } from '../metadata.ts';
