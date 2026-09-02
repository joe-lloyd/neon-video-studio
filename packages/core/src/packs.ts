/**
 * FX pack manifests. A pack is a folder:
 *
 *   my-pack/
 *     pack.json      ← this manifest: identity + every template's fields (pure data)
 *     index.tsx      ← exports one React component per template name
 *     …              ← anything else the components import (relative paths only)
 *
 * Because the manifest is data, every process (CLI, main, renderer, render worker) can register
 * a pack's templates without executing its code. Components are compiled/bundled separately.
 */
import { z } from 'zod';
import type { TemplateField, TemplatePackMeta } from './templates.ts';

export const PACK_MANIFEST_FILE = 'pack.json';
export const PACK_DEFAULT_ENTRY = 'index.tsx';

export type PackSource = 'builtin' | 'installed';

export interface PackManifest {
  /** Unique id, kebab-case (also the folder name), e.g. "boba-expressive". */
  name: string;
  label: string;
  version: string;
  description?: string;
  author?: string;
  /** Default category for templates that do not set their own. */
  category?: string;
  tags?: string[];
  /** Module (relative to the pack folder) exporting the React components. Default index.tsx. */
  entry?: string;
  templates: TemplatePackMeta[];
}

export interface PackRecord {
  manifest: PackManifest;
  source: PackSource;
  /** Folder on disk for installed packs. */
  dir?: string;
}

const fieldBase = { key: z.string().regex(/^[a-zA-Z_][a-zA-Z0-9_]*$/), label: z.string().optional(), description: z.string().optional() };

export const TemplateFieldSchema: z.ZodType<TemplateField> = z.discriminatedUnion('type', [
  z.object({ ...fieldBase, type: z.literal('text'), default: z.string(), multiline: z.boolean().optional() }),
  z.object({ ...fieldBase, type: z.literal('number'), default: z.number(), min: z.number().optional(), max: z.number().optional(), step: z.number().optional() }),
  z.object({ ...fieldBase, type: z.literal('color'), default: z.string() }),
  z.object({ ...fieldBase, type: z.literal('boolean'), default: z.boolean() }),
  z.object({ ...fieldBase, type: z.literal('select'), default: z.string(), options: z.array(z.string()).min(1) }),
]);

export const TemplatePackMetaSchema: z.ZodType<TemplatePackMeta> = z.object({
  name: z.string().regex(/^[A-Z][A-Za-z0-9]*$/, 'template names are PascalCase identifiers'),
  label: z.string().min(1),
  description: z.string().default(''),
  defaultDurationSeconds: z.number().positive(),
  fields: z.array(TemplateFieldSchema),
  category: z.string().optional(),
  tags: z.array(z.string()).optional(),
  icon: z.string().optional(),
  previewProps: z.record(z.string(), z.unknown()).optional(),
});

export const PackManifestSchema: z.ZodType<PackManifest> = z.object({
  name: z.string().regex(/^[a-z][a-z0-9-]*$/, 'pack names are kebab-case'),
  label: z.string().min(1),
  version: z.string().min(1),
  description: z.string().optional(),
  author: z.string().optional(),
  category: z.string().optional(),
  tags: z.array(z.string()).optional(),
  entry: z.string().regex(/^[^/\\][^\\]*\.(tsx|ts|jsx|js)$/, 'entry must be a relative module path').optional(),
  templates: z.array(TemplatePackMetaSchema).min(1),
});

/** Validate a parsed pack.json; throws a readable error listing the first few issues. */
export function parsePackManifest(raw: unknown): PackManifest {
  const result = PackManifestSchema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues.slice(0, 4).map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
    throw new Error(`Invalid pack.json: ${issues}`);
  }
  return result.data;
}
