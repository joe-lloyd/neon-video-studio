import { useEditor } from '../lib/context.ts';
import { useSelector } from '../lib/store.ts';

export function Toasts() {
  const editor = useEditor();
  const toasts = useSelector(editor.ui, (u) => u.toasts);
  if (toasts.length === 0) return null;
  return (
    <div className="toasts">
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.kind}`} onClick={() => editor.ui.set((u) => ({ toasts: u.toasts.filter((x) => x.id !== t.id) }))}>
          {t.message}
        </div>
      ))}
    </div>
  );
}
