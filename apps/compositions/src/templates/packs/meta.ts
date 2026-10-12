/**
 * Built-in FX pack registry — pure TS, safe to import from the CLI and the Bun main process.
 * Packs shipped inside the app live here; user-installed packs live in ~/.neon-video/packs and
 * are registered from their pack.json at runtime (see packages/core/src/node.ts). Guide: docs/fx-packs.md.
 */
import { registerTemplatePack } from '@neon/core';
import { NEON_ESSENTIALS_META, PACK_NAME as NEON_ESSENTIALS } from './neon-essentials/meta.ts';
import { DEMO_KIT_META, PACK_NAME as DEMO_KIT } from './demo-kit/meta.ts';

export function registerAllPacks(): void {
  registerTemplatePack(NEON_ESSENTIALS, NEON_ESSENTIALS_META, { label: 'Neon Essentials', description: 'Starter overlays in the app’s own neon style.' });
  registerTemplatePack(DEMO_KIT, DEMO_KIT_META, { label: 'Demo Kit', description: 'Overlays for software demos: callouts, spotlights, highlight boxes, shortcuts, numbered steps and clicks.', category: 'Demo' });
}
