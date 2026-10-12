/**
 * Render entry surface. The headless renderer's generated bundle entry imports the Timeline
 * and ContactSheet compositions from here and hands them to `registerRenderRoot()` (@neon/motion/render-page).
 * Keep this module free of side effects.
 */
export { TimelineComposition, assetUrl, type TimelineProps } from './compositions/TimelineComposition.tsx';
export { ContactSheet, calculateSheetMetadata, type ContactSheetProps } from './compositions/ContactSheet.tsx';
export { TIMELINE_COMPOSITION_ID, SHEET_COMPOSITION_ID, calculateTimelineMetadata } from './Root.tsx';
export { registerRuntimeComponents } from './templates/index.ts';
