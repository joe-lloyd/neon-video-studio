import { z } from 'zod';
import type { PackManifest, PackRecord, PackSource } from './packs.ts';

/**
 * Registry of React component templates that can be placed on overlay tracks.
 *
 * Only metadata lives here (name, prop schema, defaults) so that the CLI, the main process
 * and the UI can validate and describe templates without importing React. The React
 * implementations live in apps/remotion-workspace and are looked up by `name`.
 */

const cssColor = z.string().min(1).describe('CSS colour');

export const TEXT_OVERLAY_SCHEMA = z.object({
  text: z.string().min(1).default('Hello World').describe('Text to display'),
  fontSize: z.number().int().min(8).max(400).default(96),
  color: cssColor.default('#FFFFFF'),
  glowColor: cssColor.default('#FF007F'),
  position: z.enum(['top', 'center', 'bottom']).default('center'),
  align: z.enum(['left', 'center', 'right']).default('center'),
  animation: z.enum(['none', 'fade', 'slide-up', 'typewriter']).default('fade'),
  fontFamily: z.string().default('"JetBrains Mono", "SFMono-Regular", ui-monospace, monospace'),
});

export const LOWER_THIRD_SCHEMA = z.object({
  title: z.string().min(1).default('Speaker Name'),
  subtitle: z.string().default('Role · Company'),
  accentColor: cssColor.default('#FF007F'),
  textColor: cssColor.default('#FFFFFF'),
  side: z.enum(['left', 'right']).default('left'),
});

export const TITLE_CARD_SCHEMA = z.object({
  title: z.string().min(1).default('Chapter One'),
  subtitle: z.string().default(''),
  background: cssColor.default('#09090B'),
  accentColor: cssColor.default('#00F3FF'),
  textColor: cssColor.default('#FFFFFF'),
});

export const COUNTDOWN_SCHEMA = z.object({
  from: z.number().int().min(1).max(3600).default(5).describe('Seconds to count down from'),
  color: cssColor.default('#00F3FF'),
  fontSize: z.number().int().min(16).max(800).default(320),
});

export const PROGRESS_BAR_SCHEMA = z.object({
  color: cssColor.default('#FF007F'),
  trackColor: cssColor.default('rgba(255,255,255,0.12)'),
  height: z.number().int().min(1).max(200).default(8),
  position: z.enum(['top', 'bottom']).default('bottom'),
});

export const WATERMARK_SCHEMA = z.object({
  text: z.string().default('NEON'),
  opacity: z.number().min(0).max(1).default(0.5),
  corner: z.enum(['top-left', 'top-right', 'bottom-left', 'bottom-right']).default('bottom-right'),
  color: cssColor.default('#FFFFFF'),
  fontSize: z.number().int().min(8).max(200).default(28),
});

export const SOLID_COLOR_SCHEMA = z.object({
  color: cssColor.default('#FF007F'),
  opacity: z.number().min(0).max(1).default(1),
});

export const CAPTIONS_SCHEMA = z.object({
  style: z.enum(['karaoke', 'block']).default('karaoke').describe('karaoke highlights the word being spoken; block shows the cue plainly'),
  position: z.enum(['bottom', 'top', 'middle']).default('bottom').describe('Where the captions sit on the frame'),
  fontSize: z.number().int().min(16).max(200).default(54).describe('Text size in pixels at 1080p (scaled for other outputs)'),
  maxWords: z.number().int().min(1).max(16).default(6).describe('Most words on screen at once'),
  color: cssColor.default('#FFFFFF').describe('Text colour'),
  highlightColor: cssColor.default('#00F3FF').describe('Colour of the spoken word (karaoke)'),
  background: z.boolean().default(true).describe('Draw a dark box behind the text'),
  backgroundColor: cssColor.default('rgba(9,9,11,0.82)').describe('Box colour when background is on'),
  tracks: z.string().default('').describe('Comma-separated track names to caption, e.g. "A1,V1" (empty = every audible audio/video track)'),
});

export type TextOverlayProps = z.infer<typeof TEXT_OVERLAY_SCHEMA>;
export type LowerThirdProps = z.infer<typeof LOWER_THIRD_SCHEMA>;
export type TitleCardProps = z.infer<typeof TITLE_CARD_SCHEMA>;
export type CountdownProps = z.infer<typeof COUNTDOWN_SCHEMA>;
export type ProgressBarProps = z.infer<typeof PROGRESS_BAR_SCHEMA>;
export type WatermarkProps = z.infer<typeof WATERMARK_SCHEMA>;
export type SolidColorProps = z.infer<typeof SOLID_COLOR_SCHEMA>;
export type CaptionsProps = z.infer<typeof CAPTIONS_SCHEMA>;

export interface ComponentTemplate<S extends z.ZodObject = z.ZodObject> {
  name: string;
  label: string;
  description: string;
  /** Default clip length when inserted without an explicit duration (in seconds). */
  defaultDurationSeconds: number;
  schema: S;
  /** Pack this template came from ("core" for built-ins). */
  pack?: string;
  /** Grouping in the FX panel (e.g. "Titles", "Lower thirds"). */
  category?: string;
  /** Extra search terms. */
  tags?: string[];
  /** Icon name from the app's icon kit (falls back to a sparkle). */
  icon?: string;
  /** Prop overrides used when rendering the library thumbnail/preview. */
  previewProps?: Record<string, unknown>;
}

export const CORE_PACK_NAME = 'core';

// ---- FX packs -------------------------------------------------------------------------
// Packs describe their props with a plain field spec (no zod import needed in pack code);
// the schema, inspector UI and CLI validation are derived from it.

export type TemplateField =
  | { key: string; type: 'text'; label?: string; default: string; multiline?: boolean; description?: string }
  | { key: string; type: 'number'; label?: string; default: number; min?: number; max?: number; step?: number; description?: string }
  | { key: string; type: 'color'; label?: string; default: string; description?: string }
  | { key: string; type: 'boolean'; label?: string; default: boolean; description?: string }
  | { key: string; type: 'select'; label?: string; default: string; options: readonly string[]; description?: string };

export interface TemplatePackMeta {
  /** Unique template name (also the React component key), e.g. "NeonBadge". */
  name: string;
  label: string;
  description: string;
  defaultDurationSeconds: number;
  fields: readonly TemplateField[];
  category?: string;
  tags?: string[];
  icon?: string;
  previewProps?: Record<string, unknown>;
}

export function schemaFromFields(fields: readonly TemplateField[]): z.ZodObject {
  const shape: Record<string, z.ZodType> = {};
  for (const f of fields) {
    const schema = fieldSchema(f);
    shape[f.key] = f.description ? schema.describe(f.description) : schema;
  }
  return z.object(shape);
}

function fieldSchema(f: TemplateField): z.ZodType {
  switch (f.type) {
    case 'text':
      return z.string().default(f.default);
    case 'number': {
      let n = z.number();
      if (f.min !== undefined) n = n.min(f.min);
      if (f.max !== undefined) n = n.max(f.max);
      return n.default(f.default);
    }
    case 'color':
      return z.string().min(1).default(f.default);
    case 'boolean':
      return z.boolean().default(f.default);
    case 'select':
      return z.enum(f.options as [string, ...string[]]).default(f.default);
  }
}

/** The value a field's prop holds once validated: select fields narrow to their options. */
type FieldValue<F extends TemplateField> = F extends { type: 'number' }
  ? number
  : F extends { type: 'boolean' }
    ? boolean
    : F extends { type: 'select'; options: readonly (infer O extends string)[] }
      ? O
      : string;

/** Validated props of a template declared with defineTemplate(), derived from its fields. */
export type TemplateProps<T extends { fields: readonly TemplateField[] }> = {
  [F in T['fields'][number] as F['key']]: FieldValue<F>;
};

/**
 * Declare a pack template with literal field types so a component can type its props as
 * `TemplateProps<typeof MY_TEMPLATE>` instead of restating them by hand.
 */
export function defineTemplate<const F extends readonly TemplateField[]>(
  template: Omit<TemplatePackMeta, 'fields'> & { fields: F },
): TemplatePackMeta & { fields: F } {
  return template;
}

const EXTRA_TEMPLATES = new Map<string, ComponentTemplate>();
const PACKS = new Map<string, PackRecord>();
const TEMPLATE_LISTENERS = new Set<() => void>();
let templatesVersion = 0;

function notifyTemplates(): void {
  templatesVersion++;
  for (const l of TEMPLATE_LISTENERS) l();
}

/** Subscribe to registry changes (packs registered/removed at runtime). Returns an unsubscribe. */
export function subscribeTemplates(listener: () => void): () => void {
  TEMPLATE_LISTENERS.add(listener);
  return () => TEMPLATE_LISTENERS.delete(listener);
}

/** Monotonic counter bumped on every registry change — handy as a React store snapshot. */
export function getTemplatesVersion(): number {
  return templatesVersion;
}

/**
 * Register (or re-register) a pack's templates. Template names are global — a name already owned
 * by the core set or another pack is skipped and reported in `conflicts`, so one pack cannot
 * silently shadow another.
 */
export function registerPack(manifest: PackManifest, source: PackSource = 'builtin', dir?: string): { conflicts: string[] } {
  const previous = PACKS.get(manifest.name);
  if (previous) for (const t of previous.manifest.templates) if (EXTRA_TEMPLATES.get(t.name)?.pack === manifest.name) EXTRA_TEMPLATES.delete(t.name);
  const conflicts: string[] = [];
  for (const t of manifest.templates) {
    const owner = (COMPONENT_TEMPLATES as Record<string, ComponentTemplate>)[t.name] ? CORE_PACK_NAME : EXTRA_TEMPLATES.get(t.name)?.pack;
    if (owner && owner !== manifest.name) {
      conflicts.push(`${t.name} (already provided by ${owner})`);
      continue;
    }
    EXTRA_TEMPLATES.set(t.name, {
      name: t.name,
      label: t.label,
      description: t.description,
      defaultDurationSeconds: t.defaultDurationSeconds,
      schema: schemaFromFields(t.fields),
      pack: manifest.name,
      category: t.category ?? manifest.category,
      tags: t.tags,
      icon: t.icon,
      previewProps: t.previewProps,
    });
  }
  PACKS.set(manifest.name, { manifest, source, dir });
  notifyTemplates();
  return { conflicts };
}

export function unregisterPack(name: string): void {
  const record = PACKS.get(name);
  if (!record) return;
  for (const t of record.manifest.templates) if (EXTRA_TEMPLATES.get(t.name)?.pack === name) EXTRA_TEMPLATES.delete(t.name);
  PACKS.delete(name);
  notifyTemplates();
}

/** Every registered pack, with the built-in core set first. */
export function listPacks(): PackRecord[] {
  const core: PackRecord = {
    source: 'builtin',
    manifest: {
      name: CORE_PACK_NAME,
      label: 'Neon Core',
      version: '1',
      description: 'The built-in overlay set: text, captions, lower thirds, titles, countdown, progress, watermark, colour.',
      templates: [],
    },
  };
  return [core, ...PACKS.values()];
}

export function getPack(name: string): PackRecord | undefined {
  return PACKS.get(name);
}

/** Built-in packs shipped with the app: a plain (label, templates) shorthand for registerPack(). */
export function registerTemplatePack(pack: string, templates: TemplatePackMeta[], opts: { label?: string; description?: string; category?: string } = {}): void {
  registerPack({ name: pack, label: opts.label ?? pack, version: '1', description: opts.description, category: opts.category, templates }, 'builtin');
}

export const COMPONENT_TEMPLATES = {
  TextOverlay: {
    name: 'TextOverlay',
    label: 'Text Overlay',
    description: 'Animated headline text with a neon glow.',
    defaultDurationSeconds: 4,
    schema: TEXT_OVERLAY_SCHEMA,
    icon: 'Type',
    category: 'Text',
  },
  LowerThird: {
    name: 'LowerThird',
    label: 'Lower Third',
    description: 'Name/title bar that slides in from the side.',
    defaultDurationSeconds: 5,
    schema: LOWER_THIRD_SCHEMA,
    icon: 'Clapperboard',
    category: 'Lower thirds',
  },
  TitleCard: {
    name: 'TitleCard',
    label: 'Title Card',
    description: 'Full-frame chapter title on a solid background.',
    defaultDurationSeconds: 3,
    schema: TITLE_CARD_SCHEMA,
    icon: 'Layers',
    category: 'Titles',
  },
  Countdown: {
    name: 'Countdown',
    label: 'Countdown',
    description: 'Big numeric countdown.',
    defaultDurationSeconds: 5,
    schema: COUNTDOWN_SCHEMA,
    icon: 'Timer',
    category: 'Utilities',
  },
  ProgressBar: {
    name: 'ProgressBar',
    label: 'Progress Bar',
    description: 'Thin bar that fills over the clip duration.',
    defaultDurationSeconds: 10,
    schema: PROGRESS_BAR_SCHEMA,
    icon: 'BarChart3',
    category: 'Utilities',
  },
  Watermark: {
    name: 'Watermark',
    label: 'Watermark',
    description: 'Small corner text watermark.',
    defaultDurationSeconds: 10,
    schema: WATERMARK_SCHEMA,
    icon: 'Stamp',
    category: 'Branding',
  },
  SolidColor: {
    name: 'SolidColor',
    label: 'Solid Colour',
    description: 'Full-frame colour fill (backgrounds, flashes, tints).',
    defaultDurationSeconds: 3,
    schema: SOLID_COLOR_SCHEMA,
    icon: 'PaintBucket',
    category: 'Backgrounds',
  },
  Captions: {
    name: 'Captions',
    label: 'Captions',
    description: 'Burned-in subtitles from the transcripts; they follow cuts and speed changes.',
    defaultDurationSeconds: 10,
    schema: CAPTIONS_SCHEMA,
    icon: 'Captions',
    category: 'Text',
    tags: ['subtitles', 'transcript', 'karaoke'],
  },
} as const satisfies Record<string, ComponentTemplate>;

export type ComponentTemplateName = keyof typeof COMPONENT_TEMPLATES;

export function listTemplates(): ComponentTemplate[] {
  return [...Object.values(COMPONENT_TEMPLATES).map((t) => ({ ...t, pack: CORE_PACK_NAME })), ...EXTRA_TEMPLATES.values()];
}

export function hasTemplate(name: string): boolean {
  return name in COMPONENT_TEMPLATES || EXTRA_TEMPLATES.has(name);
}

export function getTemplate(name: string): ComponentTemplate {
  const core = (COMPONENT_TEMPLATES as Record<string, ComponentTemplate>)[name];
  const template = core ? { ...core, pack: CORE_PACK_NAME } : EXTRA_TEMPLATES.get(name);
  if (!template) {
    throw new Error(`Unknown component "${name}". Available: ${listTemplates().map((t) => t.name).join(', ')}`);
  }
  return template;
}

/** Validate + fill defaults. Throws a readable error for agents/CLI on invalid input. */
export function resolveTemplateProps(name: string, props: unknown): Record<string, unknown> {
  const template = getTemplate(name);
  const result = template.schema.safeParse(props ?? {});
  if (!result.success) {
    const issues = result.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
    throw new Error(`Invalid props for ${name}: ${issues}`);
  }
  return result.data as Record<string, unknown>;
}

/** JSON Schema for a template — handy for AI agents discovering the API (`neon-cli list --json`). */
export function templateJsonSchema(name: string): Record<string, unknown> {
  return z.toJSONSchema(getTemplate(name).schema) as Record<string, unknown>;
}

export function templateDefaults(name: string): Record<string, unknown> {
  return resolveTemplateProps(name, {});
}
