/**
 * Built-in FX pack registry — pure TS, safe to import from the CLI and the Bun main process.
 * Packs shipped inside the app live here; user-installed packs live in ~/.neon-video/packs and
 * are registered from their pack.json at runtime (see packages/core/src/node.ts). Guide: docs/fx-packs.md.
 */
import { registerTemplatePack } from '@neon/core';
import { NEON_ESSENTIALS_META, PACK_NAME as NEON_ESSENTIALS } from './neon-essentials/meta.ts';

export function registerAllPacks(): void {
  registerTemplatePack(NEON_ESSENTIALS, NEON_ESSENTIALS_META, { label: 'Neon Essentials', description: 'Starter overlays in the app’s own neon style.' });
}
