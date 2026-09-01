/** FX pack React components (browser/render side only). Keys must match the names in meta.ts. */
import type { TemplateComponent } from '../index.ts';
import { NeonBadge } from './neon-essentials/NeonBadge.tsx';
import { KineticList } from './neon-essentials/KineticList.tsx';
import { BobaTitle } from './boba-expressive/BobaTitle.tsx';
import { BobaLowerThird } from './boba-expressive/BobaLowerThird.tsx';
import { BobaTag } from './boba-expressive/BobaTag.tsx';
import { BobaBlob } from './boba-expressive/BobaBlob.tsx';
import { BobaMorphLoader } from './boba-expressive/BobaMorphLoader.tsx';

export const PACK_COMPONENTS: Record<string, TemplateComponent> = {
  NeonBadge: NeonBadge as unknown as TemplateComponent,
  KineticList: KineticList as unknown as TemplateComponent,
  BobaTitle: BobaTitle as unknown as TemplateComponent,
  BobaLowerThird: BobaLowerThird as unknown as TemplateComponent,
  BobaTag: BobaTag as unknown as TemplateComponent,
  BobaBlob: BobaBlob as unknown as TemplateComponent,
  BobaMorphLoader: BobaMorphLoader as unknown as TemplateComponent,
};
