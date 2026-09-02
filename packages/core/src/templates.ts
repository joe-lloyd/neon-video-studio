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

export type TextOverlayProps = z.infer<typeof TEXT_OVERLAY_SCHEMA>;
export type LowerThirdProps = z.infer<typeof LOWER_THIRD_SCHEMA>;
export type TitleCardProps = z.infer<typeof TITLE_CARD_SCHEMA>;
export type CountdownProps = z.infer<typeof COUNTDOWN_SCHEMA>;
export type ProgressBarProps = z.infer<typeof PROGRESS_BAR_SCHEMA>;
export type WatermarkProps = z.infer<typeof WATERMARK_SCHEMA>;
export type SolidColorProps = z.infer<typeof SOLID_COLOR_SCHEMA>;

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
  | { key: string; type: 'select'; label?: string; default: string; options: string[]; description?: string };

export interface TemplatePackMeta {
  /** Unique template name (also the React component key), e.g. "NeonBadge". */
  name: string;
  label: string;
  description: string;
  defaultDurationSeconds: number;
  fields: TemplateField[];
  category?: string;
  tags?: string[];
  icon?: string;
  previewProps?: Record<string, unknown>;
}

export function schemaFromFields(fields: TemplateField[]): z.ZodObject {
  const shape: Record<string, z.ZodType> = {};
  for (const f of fields) {
    switch (f.type) {
      case 'text':
        shape[f.key] = z.string().default(f.default);
        break;
      case 'number': {
        let n = z.number();
        if (f.min !== undefined) n = n.min(f.min);
        if (f.max !== undefined) n = n.max(f.max);
        shape[f.key] = n.default(f.default);
        break;
      }
      case 'color':
        shape[f.key] = z.string().min(1).default(f.default);
        break;
      case 'boolean':
        shape[f.key] = z.boolean().default(f.default);
        break;
      case 'select':
        shape[f.key] = z.enum(f.options as [string, ...string[]]).default(f.default);
        break;
    }
  }
  return z.object(shape);
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
      description: 'The built-in overlay set: text, lower thirds, titles, countdown, progress, watermark, colour.',
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
