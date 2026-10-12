import React from 'react';
import { AbsoluteFill, Audio, Sequence, Video } from '../../src/index.ts';

/** E2E fixture: a brightness-coded video (trimmed, delayed) over black, plus a tone. */
export function E2EComposition({ video, audio }: { video: string; audio: string }): React.ReactElement {
  return (
    <AbsoluteFill style={{ background: '#000' }}>
      <Sequence from={3}>
        <Video src={video} trimBefore={5} style={{ width: '100%', height: '100%' }} />
      </Sequence>
      <Sequence from={10} durationInFrames={10}>
        <Audio src={audio} volume={(f) => (f < 5 ? f / 5 : 1)} />
      </Sequence>
    </AbsoluteFill>
  );
}
