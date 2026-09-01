/**
 * FX pack metadata registry — pure TS, safe to import from the CLI and the Bun main process.
 * Adding a pack: create packs/<your-pack>/{meta.ts, *.tsx}, then list it here and in
 * packs/components.ts. Full guide: docs/fx-packs.md.
 */
import { registerTemplatePack } from '@neon/core';
import { NEON_ESSENTIALS_META, PACK_NAME as NEON_ESSENTIALS } from './neon-essentials/meta.ts';
import { BOBA_EXPRESSIVE_META, PACK_NAME as BOBA_EXPRESSIVE } from './boba-expressive/meta.ts';

export function registerAllPacks(): void {
  registerTemplatePack(NEON_ESSENTIALS, NEON_ESSENTIALS_META);
  registerTemplatePack(BOBA_EXPRESSIVE, BOBA_EXPRESSIVE_META);
}
