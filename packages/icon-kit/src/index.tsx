import React from 'react';
import type { LucideIcon, LucideProps } from 'lucide-react';
import { NEON } from '@neon/core';

export {
  Play,
  Pause,
  SkipBack,
  SkipForward,
  Square,
  Scissors,
  Trash2,
  Plus,
  Minus,
  Undo2,
  Redo2,
  Film,
  Music,
  Image as ImageIcon,
  Sparkles,
  Type,
  Layers,
  Upload,
  Download,
  FolderOpen,
  Save,
  Settings,
  Users,
  Wifi,
  WifiOff,
  Radio,
  Copy,
  Check,
  X,
  ChevronDown,
  ChevronRight,
  Lock,
  Unlock,
  Eye,
  EyeOff,
  Volume2,
  VolumeX,
  Magnet,
  ZoomIn,
  ZoomOut,
  Clapperboard,
  Terminal,
  Loader2,
  AlertTriangle,
  Info,
  CircleDot,
  Maximize2,
  Minimize2,
  Hash,
  Timer,
  BarChart3,
  Stamp,
  PaintBucket,
  MousePointer2,
  Link,
  Mic,
  AudioLines,
  Captions,
  Crop,
  Eraser,
  UserRound,
  Wind,
  Tag,
  Flower2,
  Brain,
  MessageSquareText,
} from 'lucide-react';

export type NeonTone = 'magenta' | 'cyan' | 'green' | 'amber' | 'red' | 'muted' | 'white';

const TONE_COLOR: Record<NeonTone, string> = {
  magenta: NEON.magenta,
  cyan: NEON.cyan,
  green: NEON.success,
  amber: NEON.warning,
  red: NEON.danger,
  muted: NEON.textMuted,
  white: NEON.text,
};

export interface NeonIconProps extends Omit<LucideProps, 'ref'> {
  icon: LucideIcon;
  tone?: NeonTone;
  /** 0 = flat, 1 = default glow, 2 = strong bloom */
  glow?: 0 | 1 | 2;
}

/** Lucide icon rendered with a neon bloom (CSS drop-shadow, cheap and crisp at any size). */
export const NeonIcon: React.FC<NeonIconProps> = ({ icon: Icon, tone = 'white', glow = 1, style, size = 18, strokeWidth = 1.75, ...rest }) => {
  const color = TONE_COLOR[tone];
  const filter =
    glow === 0 || tone === 'muted' || tone === 'white'
      ? undefined
      : glow === 2
        ? `drop-shadow(0 0 4px ${color}) drop-shadow(0 0 12px ${color})`
        : `drop-shadow(0 0 4px ${color}aa)`;
  return <Icon size={size} strokeWidth={strokeWidth} color={color} style={{ filter, flexShrink: 0, ...style }} {...rest} />;
};

/** SVG filter definitions for stronger bloom on custom SVG artwork (`filter="url(#neon-bloom)"`). */
export const NeonGlowDefs: React.FC = () => (
  <svg width="0" height="0" style={{ position: 'absolute' }} aria-hidden>
    <defs>
      <filter id="neon-bloom" x="-50%" y="-50%" width="200%" height="200%">
        <feGaussianBlur in="SourceGraphic" stdDeviation="2" result="blur1" />
        <feGaussianBlur in="SourceGraphic" stdDeviation="6" result="blur2" />
        <feMerge>
          <feMergeNode in="blur2" />
          <feMergeNode in="blur1" />
          <feMergeNode in="SourceGraphic" />
        </feMerge>
      </filter>
    </defs>
  </svg>
);

/** The Neon Video Studio mark: a play triangle inside a broken ring. */
export const NeonLogo: React.FC<{ size?: number; withText?: boolean }> = ({ size = 22, withText = false }) => (
  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 10 }}>
    <svg width={size} height={size} viewBox="0 0 32 32" fill="none" aria-label="Neon Video Studio">
      <circle cx="16" cy="16" r="13" stroke={NEON.magenta} strokeWidth="2.5" strokeDasharray="60 22" strokeLinecap="round" style={{ filter: `drop-shadow(0 0 5px ${NEON.magenta})` }} />
      <path d="M13 10.5v11l9-5.5-9-5.5z" fill={NEON.cyan} style={{ filter: `drop-shadow(0 0 5px ${NEON.cyan})` }} />
    </svg>
    {withText ? (
      <span style={{ fontFamily: NEON.fontMono, fontWeight: 700, letterSpacing: 3, fontSize: size * 0.6, color: NEON.text }}>
        NEON<span style={{ color: NEON.magenta }}>·</span>STUDIO
      </span>
    ) : null}
  </span>
);
