/** FX pack React components (browser/render side only). Keys must match the names in meta.ts. */
import type { TemplateComponent } from '../index.ts';
import { NeonBadge } from './neon-essentials/NeonBadge.tsx';
import { KineticList } from './neon-essentials/KineticList.tsx';

export const PACK_COMPONENTS: Record<string, TemplateComponent> = {
  NeonBadge: NeonBadge as unknown as TemplateComponent,
  KineticList: KineticList as unknown as TemplateComponent,
};
