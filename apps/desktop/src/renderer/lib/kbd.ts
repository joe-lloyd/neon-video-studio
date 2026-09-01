/**
 * Platform-aware keyboard shortcut labels. The handlers already accept both ⌘ and Ctrl
 * (hooks.ts checks metaKey || ctrlKey) — only the *display* strings differ per platform.
 */
export interface Kbd {
  isMac: boolean;
  /** ⌘X / Ctrl+X */
  mod: (key: string) => string;
  /** ⇧⌘X / Ctrl+Shift+X */
  shiftMod: (key: string) => string;
  /** The modifier that pauses canvas snapping while held: ⌘ on mac, Alt elsewhere. */
  snapPause: string;
}

export function kbdFor(platform: string): Kbd {
  const isMac = platform === 'darwin';
  return {
    isMac,
    mod: (key) => (isMac ? `⌘${key}` : `Ctrl+${key}`),
    shiftMod: (key) => (isMac ? `⇧⌘${key}` : `Ctrl+Shift+${key}`),
    snapPause: isMac ? '⌘' : 'Alt',
  };
}
