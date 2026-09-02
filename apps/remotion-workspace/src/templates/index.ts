import type React from 'react';
import { TextOverlay } from './TextOverlay.tsx';
import { LowerThird } from './LowerThird.tsx';
import { TitleCard } from './TitleCard.tsx';
import { Countdown } from './Countdown.tsx';
import { ProgressBar } from './ProgressBar.tsx';
import { Watermark } from './Watermark.tsx';
import { SolidColor } from './SolidColor.tsx';

export type TemplateComponent = React.ComponentType<Record<string, unknown>>;

import { PACK_COMPONENTS } from './packs/components.ts';
import { registerAllPacks } from './packs/meta.ts';

// Register pack metadata for every process that imports the template components.
registerAllPacks();

/** Name → React implementation. Names must match @neon/core COMPONENT_TEMPLATES; props are validated there. */
export const TEMPLATES: Record<string, TemplateComponent> = {
  TextOverlay: TextOverlay as unknown as TemplateComponent,
  LowerThird: LowerThird as unknown as TemplateComponent,
  TitleCard: TitleCard as unknown as TemplateComponent,
  Countdown: Countdown as unknown as TemplateComponent,
  ProgressBar: ProgressBar as unknown as TemplateComponent,
  Watermark: Watermark as unknown as TemplateComponent,
  SolidColor: SolidColor as unknown as TemplateComponent,
  ...PACK_COMPONENTS,
};

// ---- runtime packs --------------------------------------------------------------------
// Installed packs are compiled outside this bundle and register their components here at
// runtime (the renderer after loading a pack bundle; the render worker from its generated entry).

const RUNTIME_TEMPLATES = new Map<string, TemplateComponent>();

/** Register a pack module's exports (one component per template name). Returns the names taken. */
export function registerRuntimeComponents(pack: string, mod: Record<string, unknown>): string[] {
  const exports = (mod.default && typeof mod.default === 'object' ? (mod.default as Record<string, unknown>) : mod);
  const names: string[] = [];
  for (const [name, value] of Object.entries(exports)) {
    if (typeof value !== 'function' && !(value && typeof value === 'object' && '$$typeof' in (value as object))) continue;
    if (name === 'default') continue;
    RUNTIME_TEMPLATES.set(name, value as TemplateComponent);
    names.push(name);
  }
  if (names.length === 0) console.warn(`[templates] pack ${pack} exported no components`);
  return names;
}

export function unregisterRuntimeComponents(names: string[]): void {
  for (const n of names) RUNTIME_TEMPLATES.delete(n);
}

/** Built-in or runtime-registered implementation for a template name. */
export function getTemplateComponent(name: string): TemplateComponent | undefined {
  return TEMPLATES[name] ?? RUNTIME_TEMPLATES.get(name);
}

export { TextOverlay, LowerThird, TitleCard, Countdown, ProgressBar, Watermark, SolidColor };
