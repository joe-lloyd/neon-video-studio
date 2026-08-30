import { useEffect, useRef, useState, type RefObject } from 'react';
import type { Editor } from './store.ts';

export function useElementSize<T extends HTMLElement>(): [RefObject<T | null>, { width: number; height: number }] {
  const ref = useRef<T | null>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => {
      if (!entry) return;
      const { width, height } = entry.contentRect;
      setSize((s) => (s.width === width && s.height === height ? s : { width, height }));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, size];
}

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable;
}

/** Global editor shortcuts (ignored while typing in a field). */
export function useKeyboard(editor: Editor): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTypingTarget(e.target)) return;
      const meta = e.metaKey || e.ctrlKey;
      const fps = editor.fps;
      const key = e.key;
      if (meta && key.toLowerCase() === 'z') {
        e.preventDefault();
        if (e.shiftKey) editor.redoEdit();
        else editor.undoEdit();
        return;
      }
      if (meta && key.toLowerCase() === 's') {
        e.preventDefault();
        void editor.save(e.shiftKey);
        return;
      }
      if (meta && key.toLowerCase() === 'i') {
        e.preventDefault();
        void editor.importMedia();
        return;
      }
      if (meta && key.toLowerCase() === 'e') {
        e.preventDefault();
        editor.ui.set({ dialog: 'render' });
        return;
      }
      if (meta && key.toLowerCase() === 'a') {
        e.preventDefault();
        editor.select(editor.project.get().project.clips.map((c) => c.id));
        return;
      }
      if (meta && (key === '=' || key === '+')) {
        e.preventDefault();
        editor.zoomBy(1.25);
        return;
      }
      if (meta && key === '-') {
        e.preventDefault();
        editor.zoomBy(0.8);
        return;
      }
      if (meta) return;
      switch (key) {
        case ' ':
          e.preventDefault();
          editor.togglePlay();
          break;
        case 'k':
        case 'K':
          editor.player?.pause();
          break;
        case 'j':
        case 'J':
          editor.stepFrames(-fps);
          break;
        case 'l':
        case 'L':
          editor.stepFrames(fps);
          break;
        case 'ArrowLeft':
          e.preventDefault();
          editor.stepFrames(e.shiftKey ? -fps : -1);
          break;
        case 'ArrowRight':
          e.preventDefault();
          editor.stepFrames(e.shiftKey ? fps : 1);
          break;
        case 'Home':
          editor.seek(0);
          break;
        case 'End':
          editor.seek(Math.max(0, editor.project.get().durationFrames - 1));
          break;
        case 's':
        case 'S':
          editor.splitAtPlayhead();
          break;
        case 'Delete':
        case 'Backspace':
          e.preventDefault();
          if (editor.ui.get().panel === 'script' && editor.ui.get().scriptSelection) void editor.cutScriptSelection();
          else editor.deleteSelection();
          break;
        case 'Escape':
          editor.select([]);
          editor.ui.set({ dialog: null, showStart: false });
          break;
        case 'n':
        case 'N':
          editor.ui.set((u) => ({ snapping: !u.snapping }));
          break;
        case '?':
          editor.ui.set({ dialog: 'shortcuts' });
          break;
        case '=':
        case '+':
          editor.zoomBy(1.25);
          break;
        case '-':
          editor.zoomBy(0.8);
          break;
        default:
          break;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [editor]);
}
