import React, { useState } from 'react';
import { AbsoluteFill, Video, delayRender } from '../../src/index.ts';

function Hang(): null {
  // Never released; its own timeout is longer than the renderer's per-frame limit in the test.
  useState(() => delayRender('waiting for a webhook that never comes', { timeoutInMilliseconds: 120_000 }));
  return null;
}

/** E2E fixture for renderer error reporting. */
export function FailingComposition({ mode, video }: { mode: 'hang' | 'missing-video'; video: string }): React.ReactElement {
  return <AbsoluteFill>{mode === 'hang' ? <Hang /> : <Video src={video} />}</AbsoluteFill>;
}
