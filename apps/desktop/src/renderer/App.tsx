import { useEffect, useState } from 'react';
import { NeonGlowDefs, NeonLogo } from '@neon/icon-kit';
import { connectBridge } from './lib/bridge.ts';
import { EditorContext } from './lib/context.ts';
import { useKeyboard } from './lib/hooks.ts';
import { Editor, useStoreValue } from './lib/store.ts';
import { TitleBar } from './components/TitleBar.tsx';
import { Preview } from './components/Preview.tsx';
import { Transport } from './components/Transport.tsx';
import { Timeline } from './components/Timeline.tsx';
import { SidePanels } from './components/SidePanels.tsx';
import { StatusBar } from './components/StatusBar.tsx';
import { Toasts } from './components/Toasts.tsx';
import { Dialogs } from './components/Dialogs.tsx';

export function App() {
  const [editor, setEditor] = useState<Editor | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    connectBridge()
      .then((bridge) => {
        if (!alive) return;
        const ed = new Editor(bridge);
        (window as unknown as { neon: Editor }).neon = ed; // handy for debugging in the webview inspector
        setEditor(ed);
      })
      .catch((err: Error) => alive && setError(err.message));
    return () => {
      alive = false;
    };
  }, []);

  if (error) {
    return (
      <div className="splash">
        <div>
          <NeonLogo size={40} withText />
          <p className="err">{error}</p>
        </div>
      </div>
    );
  }
  if (!editor) {
    return (
      <div className="splash">
        <div>
          <NeonLogo size={40} withText />
          <div className="logo-line">CONNECTING…</div>
        </div>
      </div>
    );
  }
  return (
    <EditorContext.Provider value={editor}>
      <NeonGlowDefs />
      <Shell />
    </EditorContext.Provider>
  );
}

function Shell() {
  const editor = useEditorFromContext();
  useKeyboard(editor);
  const [timelineH, setTimelineH] = useState(300);
  const ready = useStoreValue(editor.project).ready;
  return (
    <div className="app" style={{ ['--timeline-h' as string]: `${timelineH}px` }}>
      <TitleBar />
      <div className="preview-area">
        <Preview />
        <Transport />
      </div>
      <SidePanels />
      <div className="timeline-area">
        <TimelineResizer height={timelineH} onChange={setTimelineH} />
        <Timeline />
      </div>
      <StatusBar />
      <Toasts />
      <Dialogs />
      {!ready ? <div className="preview-overlay" style={{ position: 'fixed', pointerEvents: 'none' }} /> : null}
    </div>
  );
}

function TimelineResizer({ height, onChange }: { height: number; onChange: (h: number) => void }) {
  return (
    <div
      className="timeline-resize"
      onPointerDown={(e) => {
        const startY = e.clientY;
        const startH = height;
        const target = e.currentTarget;
        target.setPointerCapture(e.pointerId);
        const move = (ev: PointerEvent) => onChange(Math.max(160, Math.min(window.innerHeight * 0.7, startH - (ev.clientY - startY))));
        const up = () => {
          target.removeEventListener('pointermove', move);
          target.removeEventListener('pointerup', up);
        };
        target.addEventListener('pointermove', move);
        target.addEventListener('pointerup', up);
      }}
    />
  );
}

import { useEditor as useEditorFromContext } from './lib/context.ts';
