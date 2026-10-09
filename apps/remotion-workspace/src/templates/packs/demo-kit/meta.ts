/**
 * Demo Kit metadata: overlays for software demos (point at things, show shortcuts, number steps).
 * Pure TypeScript (no React) so the CLI can validate props and print each template's JSON Schema;
 * every field `description` ends up in that schema, so write them for an agent reading it.
 *
 * Positions are fractions of the frame (0..1, origin top-left) so a clip works at any output
 * size; pixel sizes are authored at 1080p and scaled by the components.
 */
import { defineTemplate, type TemplatePackMeta } from '@neon/core';

export const PACK_NAME = 'demo-kit';
export const DEMO_ACCENT = '#F5276C';

const fraction = <K extends string>(key: K, def: number, description: string) =>
  ({ key, type: 'number', default: def, min: 0, max: 1, step: 0.005, description }) as const;
const color = { key: 'color', type: 'color', default: DEMO_ACCENT, description: 'Accent colour (any CSS colour). Text on it switches between dark and white automatically.' } as const;

export const CALLOUT = defineTemplate({
  name: 'Callout',
  label: 'Callout',
  description: 'Label bubble with a curved arrow pointing at a spot on screen.',
  defaultDurationSeconds: 4,
  category: 'Annotations',
  icon: 'MessageSquareText',
  tags: ['arrow', 'pointer', 'tooltip', 'annotation', 'label', 'demo'],
  previewProps: { text: 'Click here', x: 0.66, y: 0.6 },
  fields: [
    { key: 'text', type: 'text', default: 'Click here', multiline: true, description: 'Label text. A newline starts a second line.' },
    fraction('x', 0.5, 'Target point the arrow touches, as a fraction of frame width (0 = left edge, 1 = right edge).'),
    fraction('y', 0.5, 'Target point the arrow touches, as a fraction of frame height (0 = top, 1 = bottom).'),
    { key: 'side', type: 'select', default: 'auto', options: ['auto', 'left', 'right', 'top', 'bottom'], description: 'Side of the target the bubble sits on. auto picks the side with room, keeping the bubble inside the frame.' },
    color,
    { key: 'size', type: 'number', default: 32, min: 14, max: 96, description: 'Font size in px at 1080p (scaled for other outputs).' },
    { key: 'distance', type: 'number', default: 170, min: 40, max: 700, description: 'How far the bubble sits from the target, in px at 1080p.' },
  ],
});

export const SPOTLIGHT = defineTemplate({
  name: 'Spotlight',
  label: 'Spotlight',
  description: 'Dims the frame except one rounded rectangle; the lit area irises in.',
  defaultDurationSeconds: 4,
  category: 'Focus',
  icon: 'Focus',
  tags: ['focus', 'dim', 'highlight', 'mask', 'iris', 'demo'],
  previewProps: { x: 0.3, y: 0.3, w: 0.4, h: 0.4 },
  fields: [
    fraction('x', 0.3, 'Left edge of the lit area, as a fraction of frame width.'),
    fraction('y', 0.3, 'Top edge of the lit area, as a fraction of frame height.'),
    fraction('w', 0.4, 'Width of the lit area, as a fraction of frame width.'),
    fraction('h', 0.3, 'Height of the lit area, as a fraction of frame height.'),
    { key: 'radius', type: 'number', default: 16, min: 0, max: 400, description: 'Corner radius of the lit area in px at 1080p.' },
    { key: 'dim', type: 'number', default: 0.65, min: 0, max: 1, step: 0.05, description: 'Darkness outside the lit area: 0 = none, 1 = black.' },
    { key: 'feather', type: 'number', default: 8, min: 0, max: 80, description: 'Softness of the lit area edge in px at 1080p.' },
  ],
});

export const HIGHLIGHT_BOX = defineTemplate({
  name: 'HighlightBox',
  label: 'Highlight Box',
  description: 'Rounded outline around a UI element with a gentle pulse and an optional tag.',
  defaultDurationSeconds: 3,
  category: 'Annotations',
  icon: 'SquareDashed',
  tags: ['outline', 'box', 'rectangle', 'highlight', 'annotation', 'demo'],
  previewProps: { x: 0.25, y: 0.35, w: 0.5, h: 0.3, label: 'New' },
  fields: [
    fraction('x', 0.35, 'Left edge of the element, as a fraction of frame width.'),
    fraction('y', 0.4, 'Top edge of the element, as a fraction of frame height.'),
    fraction('w', 0.3, 'Width of the element, as a fraction of frame width.'),
    fraction('h', 0.12, 'Height of the element, as a fraction of frame height.'),
    color,
    { key: 'thickness', type: 'number', default: 4, min: 1, max: 20, description: 'Outline width in px at 1080p.' },
    { key: 'radius', type: 'number', default: 12, min: 0, max: 200, description: 'Corner radius in px at 1080p.' },
    { key: 'padding', type: 'number', default: 8, min: 0, max: 80, description: 'Gap between the element bounds and the outline, in px at 1080p.' },
    { key: 'label', type: 'text', default: '', description: 'Optional tag on the outline, e.g. "New". Empty for none.' },
    { key: 'pulse', type: 'boolean', default: true, description: 'Send a soft ring outward every 1.6 s.' },
  ],
});

export const KEY_COMBO = defineTemplate({
  name: 'KeyCombo',
  label: 'Key Combo',
  description: 'Keyboard shortcut as keycaps that press down, with an optional caption.',
  defaultDurationSeconds: 2.5,
  category: 'Shortcuts',
  icon: 'Keyboard',
  tags: ['keyboard', 'shortcut', 'hotkey', 'keys', 'keycap', 'demo'],
  previewProps: { combo: 'Mod+K', platform: 'mac', y: 0.5 },
  fields: [
    { key: 'combo', type: 'text', default: 'Ctrl+Shift+P', description: 'Keys joined with "+", e.g. "Ctrl+Shift+P". "Mod" is Cmd on mac and Ctrl on pc. Separate a chord sequence with spaces: "Ctrl+K Ctrl+S". The plus key itself is "Ctrl++".' },
    { key: 'platform', type: 'select', default: 'pc', options: ['pc', 'mac'], description: 'mac draws modifier glyphs (⌘ ⌥ ⇧ ⌃ ↩); pc spells modifiers out (Ctrl, Alt, Shift).' },
    { key: 'label', type: 'text', default: '', description: 'Optional caption beside the keys, e.g. "Command palette". Empty for none.' },
    fraction('x', 0.5, 'Horizontal centre of the key tray, as a fraction of frame width.'),
    fraction('y', 0.86, 'Vertical centre of the key tray, as a fraction of frame height.'),
    { key: 'size', type: 'number', default: 30, min: 14, max: 96, description: 'Key label size in px at 1080p.' },
    color,
  ],
});

export const STEP_BADGE = defineTemplate({
  name: 'StepBadge',
  label: 'Step Badge',
  description: 'Numbered step marker with a title and optional subtitle, e.g. "2 · Open Settings".',
  defaultDurationSeconds: 4,
  category: 'Steps',
  icon: 'ListOrdered',
  tags: ['step', 'number', 'tutorial', 'chapter', 'progress', 'demo'],
  previewProps: { step: 2, title: 'Open Settings', total: 5 },
  fields: [
    { key: 'step', type: 'number', default: 1, min: 0, max: 999, description: 'Step number shown in the disc.' },
    { key: 'title', type: 'text', default: 'Open Settings', description: 'What this step does.' },
    { key: 'subtitle', type: 'text', default: '', description: 'Optional second line in a lighter weight. Empty for none.' },
    { key: 'total', type: 'number', default: 0, min: 0, max: 999, description: 'Total number of steps. Above 0 adds "Step 2 of 5" above the title.' },
    { key: 'position', type: 'select', default: 'top-left', options: ['top-left', 'top-center', 'top-right', 'bottom-left', 'bottom-center', 'bottom-right'], description: 'Where the badge sits in the frame.' },
    color,
    { key: 'size', type: 'number', default: 36, min: 16, max: 96, description: 'Title font size in px at 1080p; the badge scales with it.' },
  ],
});

export const CLICK_PULSE = defineTemplate({
  name: 'ClickPulse',
  label: 'Click Pulse',
  description: 'Expanding rings at a point to show a click.',
  defaultDurationSeconds: 1,
  category: 'Cursor',
  icon: 'MousePointerClick',
  tags: ['click', 'tap', 'cursor', 'mouse', 'ripple', 'demo'],
  previewProps: { size: 90 },
  fields: [
    fraction('x', 0.5, 'Click point, as a fraction of frame width.'),
    fraction('y', 0.5, 'Click point, as a fraction of frame height.'),
    color,
    { key: 'size', type: 'number', default: 64, min: 16, max: 300, description: 'Radius the rings grow to, in px at 1080p.' },
    { key: 'double', type: 'boolean', default: false, description: 'Two quick pulses for a double-click.' },
  ],
});

export const DEMO_KIT_META: TemplatePackMeta[] = [CALLOUT, SPOTLIGHT, HIGHLIGHT_BOX, KEY_COMBO, STEP_BADGE, CLICK_PULSE];
