/** Built-in FX pack React components (browser/render side only). Keys must match the names in meta.ts. */
import type { TemplateComponent } from '../index.ts';
import { NeonBadge } from './neon-essentials/NeonBadge.tsx';
import { KineticList } from './neon-essentials/KineticList.tsx';
import { Callout } from './demo-kit/Callout.tsx';
import { Spotlight } from './demo-kit/Spotlight.tsx';
import { HighlightBox } from './demo-kit/HighlightBox.tsx';
import { KeyCombo } from './demo-kit/KeyCombo.tsx';
import { StepBadge } from './demo-kit/StepBadge.tsx';
import { ClickPulse } from './demo-kit/ClickPulse.tsx';

export const PACK_COMPONENTS: Record<string, TemplateComponent> = {
  NeonBadge: NeonBadge as unknown as TemplateComponent,
  KineticList: KineticList as unknown as TemplateComponent,
  Callout: Callout as unknown as TemplateComponent,
  Spotlight: Spotlight as unknown as TemplateComponent,
  HighlightBox: HighlightBox as unknown as TemplateComponent,
  KeyCombo: KeyCombo as unknown as TemplateComponent,
  StepBadge: StepBadge as unknown as TemplateComponent,
  ClickPulse: ClickPulse as unknown as TemplateComponent,
};
