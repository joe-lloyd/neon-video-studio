/**
 * FX pack metadata — pure TypeScript (no React) so the CLI and the main process can validate
 * props without loading components. `fields` drives the inspector UI, the CLI JSON schema and
 * prop validation automatically.
 */
import type { TemplatePackMeta } from '@neon/core';

export const PACK_NAME = 'neon-essentials';

export const NEON_ESSENTIALS_META: TemplatePackMeta[] = [
  {
    name: 'NeonBadge',
    label: 'Neon Badge',
    description: 'Animated pill badge — great for “NEW”, prices, category tags.',
    defaultDurationSeconds: 4,
    fields: [
      { key: 'text', type: 'text', default: 'NEW' },
      { key: 'color', type: 'color', default: '#FF007F' },
      { key: 'textColor', type: 'color', default: '#FFFFFF' },
      { key: 'size', type: 'number', default: 44, min: 12, max: 200 },
      { key: 'corner', type: 'select', default: 'top-right', options: ['top-left', 'top-right', 'bottom-left', 'bottom-right'] },
      { key: 'pulse', type: 'boolean', default: true },
    ],
  },
  {
    name: 'KineticList',
    label: 'Kinetic List',
    description: 'Bullet points that slide in one after another (one per line).',
    defaultDurationSeconds: 6,
    fields: [
      { key: 'title', type: 'text', default: 'Three things' },
      { key: 'items', type: 'text', default: 'First point\nSecond point\nThird point', multiline: true },
      { key: 'accentColor', type: 'color', default: '#00F3FF' },
      { key: 'textColor', type: 'color', default: '#FFFFFF' },
      { key: 'align', type: 'select', default: 'left', options: ['left', 'center'] },
      { key: 'staggerSeconds', type: 'number', default: 0.5, min: 0.1, max: 3, step: 0.1 },
    ],
  },
];
