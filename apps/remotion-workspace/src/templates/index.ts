import type React from 'react';
import { TextOverlay } from './TextOverlay.tsx';
import { LowerThird } from './LowerThird.tsx';
import { TitleCard } from './TitleCard.tsx';
import { Countdown } from './Countdown.tsx';
import { ProgressBar } from './ProgressBar.tsx';
import { Watermark } from './Watermark.tsx';
import { SolidColor } from './SolidColor.tsx';

export type TemplateComponent = React.ComponentType<Record<string, unknown>>;

/** Name → React implementation. Names must match @neon/core COMPONENT_TEMPLATES; props are validated there. */
export const TEMPLATES: Record<string, TemplateComponent> = {
  TextOverlay: TextOverlay as unknown as TemplateComponent,
  LowerThird: LowerThird as unknown as TemplateComponent,
  TitleCard: TitleCard as unknown as TemplateComponent,
  Countdown: Countdown as unknown as TemplateComponent,
  ProgressBar: ProgressBar as unknown as TemplateComponent,
  Watermark: Watermark as unknown as TemplateComponent,
  SolidColor: SolidColor as unknown as TemplateComponent,
};

export { TextOverlay, LowerThird, TitleCard, Countdown, ProgressBar, Watermark, SolidColor };
