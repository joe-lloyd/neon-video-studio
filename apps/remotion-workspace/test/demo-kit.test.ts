import { test } from 'node:test';
import assert from 'node:assert/strict';
import { listTemplates, resolveTemplateProps, templateDefaults, templateJsonSchema } from '@neon/core';
import { registerAllPacks } from '../src/templates/packs/meta.ts';
import { comboLabels } from '../src/templates/packs/demo-kit/keys.ts';

registerAllPacks();

test('every Demo Kit template is listed under the demo-kit pack', () => {
  const names = listTemplates()
    .filter((t) => t.pack === 'demo-kit')
    .map((t) => t.name)
    .sort();
  assert.deepEqual(names, ['Callout', 'ClickPulse', 'HighlightBox', 'KeyCombo', 'Spotlight', 'StepBadge']);
});

test('Demo Kit defaults validate and fill every prop', () => {
  assert.deepEqual(templateDefaults('Callout'), { text: 'Click here', x: 0.5, y: 0.5, side: 'auto', color: '#F5276C', size: 32, distance: 170 });
  assert.deepEqual(templateDefaults('Spotlight'), { x: 0.3, y: 0.3, w: 0.4, h: 0.3, radius: 16, dim: 0.65, feather: 8 });
  assert.deepEqual(templateDefaults('HighlightBox'), { x: 0.35, y: 0.4, w: 0.3, h: 0.12, color: '#F5276C', thickness: 4, radius: 12, padding: 8, label: '', pulse: true });
  assert.deepEqual(templateDefaults('KeyCombo'), { combo: 'Ctrl+Shift+P', platform: 'pc', label: '', x: 0.5, y: 0.86, size: 30, color: '#F5276C' });
  assert.deepEqual(templateDefaults('StepBadge'), { step: 1, title: 'Open Settings', subtitle: '', total: 0, position: 'top-left', color: '#F5276C', size: 36 });
  assert.deepEqual(templateDefaults('ClickPulse'), { x: 0.5, y: 0.5, color: '#F5276C', size: 64, double: false });
});

test('Demo Kit rejects positions outside the frame and unknown sides', () => {
  assert.throws(() => resolveTemplateProps('Callout', { x: 1.5 }), /Invalid props for Callout: x/);
  assert.throws(() => resolveTemplateProps('Callout', { side: 'middle' }), /Invalid props for Callout: side/);
});

test('field descriptions reach the JSON Schema agents read', () => {
  assert.partialDeepStrictEqual(templateJsonSchema('Spotlight'), {
    properties: { dim: { type: 'number', minimum: 0, maximum: 1, default: 0.65, description: 'Darkness outside the lit area: 0 = none, 1 = black.' } },
  });
});

test('KeyCombo labels shortcuts per platform', () => {
  assert.deepEqual(comboLabels('Ctrl+Shift+P', 'pc'), [['Ctrl', 'Shift', 'P']]);
  assert.deepEqual(comboLabels('Mod+Shift+p', 'mac'), [['⌘', '⇧', 'P']]);
  assert.deepEqual(comboLabels('mod+k', 'pc'), [['Ctrl', 'K']]);
  assert.deepEqual(comboLabels('Ctrl+K Ctrl+S', 'pc'), [['Ctrl', 'K'], ['Ctrl', 'S']]);
  assert.deepEqual(comboLabels('Ctrl++', 'pc'), [['Ctrl', '+']]);
  assert.deepEqual(comboLabels('Alt+Enter', 'mac'), [['⌥', '↩']]);
});
