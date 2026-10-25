import React from 'react';
import { useCurrentFrame } from '@neon/motion';

export function FixtureTitle({ title }: { title: string }) {
  const frame = useCurrentFrame();
  return <div style={{ position: 'absolute', left: 20, top: 20, color: '#ffffff', fontSize: 32 }}>{title} {frame}</div>;
}
