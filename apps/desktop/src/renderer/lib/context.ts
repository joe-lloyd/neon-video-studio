import { createContext, useContext } from 'react';
import type { Editor } from './store.ts';

export const EditorContext = createContext<Editor | null>(null);

export function useEditor(): Editor {
  const editor = useContext(EditorContext);
  if (!editor) throw new Error('EditorContext missing');
  return editor;
}
