import React from 'react';
import { AbsoluteFill } from '@neon/motion';
import type { SolidColorProps } from '@neon/core';

type Props = SolidColorProps;

export const SolidColor: React.FC<Props> = ({ color, opacity }) => <AbsoluteFill style={{ background: color, opacity }} />;
