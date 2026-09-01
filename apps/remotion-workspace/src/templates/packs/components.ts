/** FX pack React components (browser/render side only). Keys must match the names in meta.ts. */
import type { TemplateComponent } from '../index.ts';
import { NeonBadge } from './neon-essentials/NeonBadge.tsx';
import { KineticList } from './neon-essentials/KineticList.tsx';
import { [removed]Title } from './[removed]-expressive/[removed]Title.tsx';
import { [removed]LowerThird } from './[removed]-expressive/[removed]LowerThird.tsx';
import { [removed]Tag } from './[removed]-expressive/[removed]Tag.tsx';
import { [removed]Blob } from './[removed]-expressive/[removed]Blob.tsx';
import { [removed]MorphLoader } from './[removed]-expressive/[removed]MorphLoader.tsx';

export const PACK_COMPONENTS: Record<string, TemplateComponent> = {
  NeonBadge: NeonBadge as unknown as TemplateComponent,
  KineticList: KineticList as unknown as TemplateComponent,
  [removed]Title: [removed]Title as unknown as TemplateComponent,
  [removed]LowerThird: [removed]LowerThird as unknown as TemplateComponent,
  [removed]Tag: [removed]Tag as unknown as TemplateComponent,
  [removed]Blob: [removed]Blob as unknown as TemplateComponent,
  [removed]MorphLoader: [removed]MorphLoader as unknown as TemplateComponent,
};
