/** Keyboard shortcut parsing for KeyCombo. Pure, so the CLI-facing behaviour is unit-tested. */
import type { TemplateProps } from '@neon/core';
import type { KEY_COMBO } from './meta.ts';

export type Platform = TemplateProps<typeof KEY_COMBO>['platform'];

/** Lower-cased key name → label per platform. Keys not listed keep their spelling (single letters upper-cased). */
const KEY_LABELS: Record<string, { pc: string; mac: string }> = {
  mod: { pc: 'Ctrl', mac: '⌘' },
  cmd: { pc: 'Cmd', mac: '⌘' },
  command: { pc: 'Cmd', mac: '⌘' },
  meta: { pc: 'Win', mac: '⌘' },
  super: { pc: 'Win', mac: '⌘' },
  win: { pc: 'Win', mac: '⌘' },
  ctrl: { pc: 'Ctrl', mac: '⌃' },
  control: { pc: 'Ctrl', mac: '⌃' },
  alt: { pc: 'Alt', mac: '⌥' },
  opt: { pc: 'Alt', mac: '⌥' },
  option: { pc: 'Alt', mac: '⌥' },
  shift: { pc: 'Shift', mac: '⇧' },
  enter: { pc: 'Enter', mac: '↩' },
  return: { pc: 'Enter', mac: '↩' },
  backspace: { pc: 'Backspace', mac: '⌫' },
  delete: { pc: 'Del', mac: '⌦' },
  del: { pc: 'Del', mac: '⌦' },
  esc: { pc: 'Esc', mac: 'esc' },
  escape: { pc: 'Esc', mac: 'esc' },
  tab: { pc: 'Tab', mac: '⇥' },
  capslock: { pc: 'Caps Lock', mac: '⇪' },
  space: { pc: 'Space', mac: 'Space' },
  up: { pc: '↑', mac: '↑' },
  down: { pc: '↓', mac: '↓' },
  left: { pc: '←', mac: '←' },
  right: { pc: '→', mac: '→' },
  pageup: { pc: 'PgUp', mac: 'PgUp' },
  pagedown: { pc: 'PgDn', mac: 'PgDn' },
};

export function keyLabel(key: string, platform: Platform): string {
  const known = KEY_LABELS[key.toLowerCase()];
  if (known) return known[platform];
  return key.length === 1 ? key.toUpperCase() : key;
}

/** "Ctrl+K Ctrl+S" → [["Ctrl","K"],["Ctrl","S"]]; "Ctrl++" → [["Ctrl","+"]]. */
export function parseCombo(combo: string): string[][] {
  return combo
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((chord) => {
      const parts = chord.split('+');
      const keys = parts.filter(Boolean);
      return keys.length < parts.length ? [...keys, '+'] : keys;
    });
}

/** Display labels for every key of every chord in `combo`. */
export function comboLabels(combo: string, platform: Platform): string[][] {
  return parseCombo(combo).map((keys) => keys.map((k) => keyLabel(k, platform)));
}
