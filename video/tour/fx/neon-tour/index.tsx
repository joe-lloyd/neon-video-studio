import React from 'react';
import { AbsoluteFill, useCurrentFrame, useVideoConfig } from '@neon/motion';

// Neon Video Studio's own look (apps/desktop/src/renderer/styles/neon.css): void black,
// magenta and cyan glows, mono timecodes and a timeline ruler.
const C = {
  void: '#09090b',
  surface: '#0f0f13',
  raised: '#15151b',
  magenta: '#ff007f',
  cyan: '#00f3ff',
  green: '#39ff14',
  amber: '#ffb800',
  text: '#f4f4f5',
  muted: '#a1a1aa',
  faint: '#52525b',
  edge: 'rgba(255,255,255,0.08)',
};
const ACCENTS = [C.magenta, C.cyan, C.green, C.amber];
const SANS = 'Inter, "SF Pro Display", "Segoe UI", system-ui, sans-serif';
const MONO = '"JetBrains Mono", "SFMono-Regular", Menlo, Consolas, monospace';
const glow = (c: string, r = 18) => `0 0 ${r}px ${c}aa, 0 0 ${r * 2.4}px ${c}44`;
const ease = (n: number) => 1 - Math.pow(1 - Math.min(1, Math.max(0, n)), 3);
const lines = (s: string) => s.split('\n').map((l) => l.trimEnd()).filter((l) => l.trim());
/** "Name: detail" entries split at the first colon. */
const pair = (line: string): [string, string] => {
  const at = line.indexOf(':');
  return at < 0 ? [line.trim(), ''] : [line.slice(0, at).trim(), line.slice(at + 1).trim()];
};
const timecode = (frame: number, fps: number) => {
  const s = Math.floor(frame / fps);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(Math.floor(s / 3600))}:${p(Math.floor(s / 60) % 60)}:${p(s % 60)}:${p(frame % fps)}`;
};

/** Frame, seconds, a 1080p-relative scale and a fade over the clip's last third of a second. */
const useClock = () => {
  const frame = useCurrentFrame();
  const { fps, width, height, durationInFrames } = useVideoConfig();
  const enter = (startSec: number, lengthSec = 0.5) => ease((frame / fps - startSec) / lengthSec);
  return { frame, fps, t: frame / fps, scale: Math.min(width / 1920, height / 1080), enter, out: Math.min(1, Math.max(0, (durationInFrames - frame) / (fps / 3))) };
};

const Canvas: React.FC<{ scale: number; opacity?: number; children: React.ReactNode }> = ({ scale, opacity = 1, children }) => (
  <AbsoluteFill style={{ color: C.text, fontFamily: SANS, overflow: 'hidden' }}>
    <div style={{ width: 1920, height: 1080, position: 'absolute', transformOrigin: 'top left', transform: `scale(${scale})`, opacity }}>{children}</div>
  </AbsoluteFill>
);

/** The app's mark: a play triangle inside a broken ring. `build` 0..1 draws the ring in. */
const Mark: React.FC<{ size: number; build?: number }> = ({ size, build = 1 }) => (
  <svg width={size} height={size} viewBox="0 0 32 32" fill="none">
    <circle cx="16" cy="16" r="13" stroke={C.magenta} strokeWidth="2.5" strokeLinecap="round" strokeDasharray={`${60 * build} ${82 - 60 * build}`} style={{ filter: `drop-shadow(0 0 3px ${C.magenta})` }} />
    <path d="M13 10.5v11l9-5.5-9-5.5z" fill={C.cyan} opacity={ease(build * 1.4 - 0.4)} style={{ filter: `drop-shadow(0 0 3px ${C.cyan})` }} />
  </svg>
);

/** Grid, glows and a ruler with a sweeping playhead and running timecode. */
const Backdrop: React.FC<{ frame: number; fps: number }> = ({ frame, fps }) => {
  const sweep = ((frame / fps) * 70) % 2100 - 90;
  return (
    <>
      <AbsoluteFill style={{ background: C.void }} />
      <AbsoluteFill style={{ background: `radial-gradient(ellipse at 85% 0%, ${C.magenta}26, transparent 55%), radial-gradient(ellipse at 0% 100%, ${C.cyan}1f, transparent 50%)` }} />
      <svg width="1920" height="1080" style={{ position: 'absolute', opacity: 0.07 }}>
        <defs><pattern id="neon-grid" width="96" height="96" patternUnits="userSpaceOnUse"><path d="M 96 0 L 0 0 0 96" fill="none" stroke={C.cyan} strokeWidth="1" /></pattern></defs>
        <rect width="1920" height="1080" fill="url(#neon-grid)" />
      </svg>
      <div style={{ position: 'absolute', left: 0, right: 0, bottom: 0, height: 64, borderTop: `1px solid ${C.edge}`, opacity: 0.6 }}>
        {Array.from({ length: 81 }, (_, i) => <div key={i} style={{ position: 'absolute', left: i * 24, bottom: 0, width: 1, height: i % 5 ? 10 : 22, background: C.faint }} />)}
        <div style={{ position: 'absolute', right: 48, bottom: 24, fontFamily: MONO, fontSize: 18, color: C.muted }}>{timecode(frame, fps)}</div>
      </div>
      <div style={{ position: 'absolute', left: sweep, top: 0, width: 2, height: 1080, background: C.magenta, boxShadow: glow(C.magenta, 8), opacity: 0.35 }} />
    </>
  );
};

export const NeonTitle: React.FC<{ title: string; subtitle: string; footer: string }> = ({ title, subtitle, footer }) => {
  const { frame, fps, scale, enter, out } = useClock();
  const rise = (v: number, by: number): React.CSSProperties => ({ opacity: v, transform: `translateY(${(1 - v) * by}px)` });
  const mark = enter(0.1, 1.1);
  return (
    <Canvas scale={scale} opacity={out}>
      <Backdrop frame={frame} fps={fps} />
      <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', paddingBottom: 40 }}>
        <div style={{ opacity: enter(0, 0.3), transform: `scale(${0.85 + 0.15 * mark})` }}><Mark size={230} build={mark} /></div>
        <div style={{ marginTop: 44, fontSize: 132, fontWeight: 800, letterSpacing: -4, lineHeight: 1, textShadow: glow(C.magenta, 26), ...rise(enter(0.7), 30) }}>{title}</div>
        {subtitle ? <div style={{ marginTop: 30, fontSize: 44, color: C.muted, ...rise(enter(1.1), 24) }}>{subtitle}</div> : null}
      </div>
      {footer ? <div style={{ position: 'absolute', left: 0, right: 0, bottom: 112, textAlign: 'center', fontFamily: MONO, fontSize: 28, letterSpacing: 3, color: C.cyan, textShadow: glow(C.cyan, 8), opacity: enter(1.6) }}>{footer}</div> : null}
    </Canvas>
  );
};

export const NeonChapter: React.FC<{ number: number; title: string }> = ({ number, title }) => {
  const { scale, enter, out } = useClock();
  const inT = enter(0, 0.5);
  return (
    <Canvas scale={scale}>
      <div style={{ position: 'absolute', left: 56, bottom: 64, display: 'flex', alignItems: 'center', gap: 20, padding: '14px 34px 14px 14px', borderRadius: 16, background: 'rgba(15,15,19,0.94)', border: `1px solid ${C.magenta}88`, boxShadow: `0 16px 50px rgba(0,0,0,0.55), ${glow(C.magenta, 10)}`, opacity: Math.min(inT, out), transform: `translateX(${(1 - inT) * -40}px)` }}>
        <div style={{ width: 60, height: 60, borderRadius: 12, background: C.magenta, color: '#160010', display: 'grid', placeItems: 'center', fontFamily: MONO, fontSize: 30, fontWeight: 800 }}>{String(number).padStart(2, '0')}</div>
        <div style={{ fontSize: 38, fontWeight: 650 }}>{title}</div>
      </div>
    </Canvas>
  );
};

type StageProps = { scene: string; chapter: string; title: string; items: string };

export const NeonStage: React.FC<StageProps> = ({ scene, chapter, title, items }) => {
  const { frame, fps, t, scale, enter, out } = useClock();
  const list = lines(items);
  const at = (i: number, gapSec = 0.4) => enter(0.35 + i * gapSec, 0.6);
  let body: React.ReactNode = null;

  if (scene === 'flow') {
    // A box per line with arrows between; the highlight walks along the flow.
    const n = Math.max(1, list.length);
    const arrow = 64;
    const w = (1680 - (n - 1) * arrow) / n;
    const lit = Math.floor(t / 1.6) % n;
    body = list.map(pair).map(([name, detail], i) => {
      const on = i === lit && t > 0.35 + n * 0.4;
      const a = ACCENTS[i % ACCENTS.length]!;
      return (
        <React.Fragment key={i}>
          <div style={{ position: 'absolute', left: 120 + i * (w + arrow), top: 470, width: w, height: 230, boxSizing: 'border-box', padding: 26, borderRadius: 18, background: C.raised, border: `2px solid ${on ? a : C.edge}`, boxShadow: on ? glow(a, 14) : '0 20px 50px #0008', opacity: at(i), transform: `translateY(${(1 - at(i)) * 30}px)`, display: 'flex', flexDirection: 'column', justifyContent: 'center', textAlign: 'center' }}>
            <div style={{ fontSize: 36, fontWeight: 750, color: a }}>{name}</div>
            {detail ? <div style={{ fontSize: 25, color: C.muted, marginTop: 14, lineHeight: 1.4 }}>{detail}</div> : null}
          </div>
          {i < n - 1 ? <div style={{ position: 'absolute', left: 120 + i * (w + arrow) + w, width: arrow, top: 470, height: 230, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 40, color: C.muted, opacity: at(i + 0.5) }}>→</div> : null}
        </React.Fragment>
      );
    });
  } else if (scene === 'hub') {
    // The first line in the centre; the others around it, with packets running along the links.
    const [centre, ...spokes] = list.map(pair);
    const cx = 960;
    const cy = 650;
    // Spread the spokes over both sides: even ones left, odd ones right, top to bottom.
    const placed = spokes.map((_, i) => {
      const side = i % 2 === 0 ? -1 : 1;
      const row = Math.floor(i / 2);
      const rows = Math.ceil(spokes.length / 2);
      return [cx + side * 600, 400 + (rows === 1 ? 250 : (row * 500) / Math.max(1, rows - 1))] as const;
    });
    body = (
      <>
        <svg width="1920" height="1080" style={{ position: 'absolute' }}>
          {placed.map(([x, y], i) => {
            const p = (t * 0.55 + i * 0.29) % 1;
            const a = ACCENTS[(i + 1) % ACCENTS.length]!;
            return (
              <g key={i} opacity={at(i + 1)}>
                <line x1={cx} y1={cy} x2={x} y2={y} stroke="rgba(255,255,255,0.14)" strokeWidth="2" />
                <circle cx={cx + (x - cx) * p} cy={cy + (y - cy) * p} r="7" fill={a} style={{ filter: `drop-shadow(0 0 6px ${a})` }} />
              </g>
            );
          })}
        </svg>
        {centre ? (
          <div style={{ position: 'absolute', left: cx - 230, top: cy - 85, width: 460, height: 170, boxSizing: 'border-box', borderRadius: 22, background: C.raised, border: `2px solid ${C.magenta}`, boxShadow: glow(C.magenta, 18), display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', textAlign: 'center', opacity: at(0) }}>
            <div style={{ fontSize: 38, fontWeight: 800 }}>{centre[0]}</div>
            {centre[1] ? <div style={{ fontSize: 23, color: C.muted, marginTop: 10 }}>{centre[1]}</div> : null}
          </div>
        ) : null}
        {spokes.map(([name, detail], i) => {
          const [x, y] = placed[i]!;
          const a = ACCENTS[(i + 1) % ACCENTS.length]!;
          return (
            <div key={i} style={{ position: 'absolute', left: x - 230, top: y - 62, width: 460, minHeight: 124, boxSizing: 'border-box', padding: '20px 24px', borderRadius: 16, background: C.raised, border: `1px solid ${a}`, boxShadow: '0 20px 50px #0009', textAlign: 'center', opacity: at(i + 1), transform: `translateY(${(1 - at(i + 1)) * 24}px)` }}>
              <div style={{ fontSize: 32, fontWeight: 750, color: a, fontFamily: name.startsWith('@') || name.includes('-') ? MONO : SANS }}>{name}</div>
              {detail ? <div style={{ fontSize: 23, color: C.muted, marginTop: 8 }}>{detail}</div> : null}
            </div>
          );
        })}
      </>
    );
  } else if (scene === 'code') {
    // The first line names the file; the rest is revealed a line at a time.
    const [file = '', ...code] = list;
    body = (
      <div style={{ position: 'absolute', left: 260, right: 260, top: 330, bottom: 120, background: C.surface, border: `1px solid ${C.magenta}55`, borderRadius: 18, overflow: 'hidden', boxShadow: `0 30px 80px #000b, ${glow(C.magenta, 6)}`, opacity: enter(0.2) }}>
        <div style={{ height: 52, display: 'flex', alignItems: 'center', gap: 9, padding: '0 20px', borderBottom: `1px solid ${C.edge}`, fontFamily: MONO, fontSize: 20, color: C.muted }}>
          {['#ff5f57', '#febc2e', '#28c840'].map((c) => <span key={c} style={{ width: 13, height: 13, borderRadius: 13, background: c }} />)}
          <span style={{ marginLeft: 14 }}>{file}</span>
        </div>
        <div style={{ padding: '22px 30px', fontFamily: MONO, fontSize: 29, lineHeight: 1.6 }}>
          {code.map((l, i) => (
            <div key={i} style={{ display: 'flex', gap: 28, opacity: enter(0.5 + i * 0.18, 0.3), whiteSpace: 'pre' }}>
              <span style={{ color: C.faint, width: 36, textAlign: 'right' }}>{i + 1}</span>
              <span style={{ color: l.trim().startsWith('//') ? C.muted : /"\w+":/.test(l) ? C.text : C.cyan }}>{l}</span>
            </div>
          ))}
        </div>
      </div>
    );
  } else if (list.length) {
    // cards: "Name: detail" per card.
    const cols = list.length > 4 ? 3 : 2;
    body = (
      <div style={{ position: 'absolute', left: 120, right: 120, top: 400, display: 'grid', gridTemplateColumns: `repeat(${cols}, 1fr)`, gap: 24 }}>
        {list.map(pair).map(([name, detail], i) => (
          <div key={i} style={{ background: C.raised, border: `1px solid ${C.edge}`, borderLeft: `4px solid ${ACCENTS[i % ACCENTS.length]}`, borderRadius: 16, padding: '26px 30px', opacity: at(i), transform: `translateY(${(1 - at(i)) * 24}px)` }}>
            <div style={{ fontSize: 32, fontWeight: 700 }}>{name}</div>
            {detail ? <div style={{ fontSize: 24, color: C.muted, marginTop: 10, lineHeight: 1.4 }}>{detail}</div> : null}
          </div>
        ))}
      </div>
    );
  }

  return (
    <Canvas scale={scale} opacity={out}>
      <Backdrop frame={frame} fps={fps} />
      {chapter ? <div style={{ position: 'absolute', top: 64, right: 120, fontFamily: MONO, fontSize: 22, letterSpacing: 3, color: C.cyan, textTransform: 'uppercase', opacity: enter(0) }}>{chapter}</div> : null}
      <div style={{ position: 'absolute', left: 120, top: 150, display: 'flex', alignItems: 'center', gap: 26, opacity: enter(0), transform: `translateY(${(1 - enter(0)) * 24}px)` }}>
        <Mark size={74} />
        <div style={{ fontSize: 84, fontWeight: 800, letterSpacing: -2.5, lineHeight: 1.05 }}>{title}</div>
      </div>
      {body}
    </Canvas>
  );
};

/** Static on purpose: every frame of the clip is the same picture. */
export const NeonThumbnail: React.FC<{ title: string; kicker: string }> = ({ title, kicker }) => {
  const { scale } = useClock();
  const words = title.split(' ');
  return (
    <Canvas scale={scale}>
      <div style={{ position: 'absolute', inset: 0, background: `linear-gradient(90deg, ${C.void} 0%, ${C.void} 44%, rgba(9,9,11,0.82) 58%, rgba(9,9,11,0.2) 82%, rgba(9,9,11,0) 100%)` }} />
      <div style={{ position: 'absolute', inset: 0, background: `radial-gradient(900px 700px at 16% 50%, ${C.magenta}2e, transparent 70%)` }} />
      <div style={{ position: 'absolute', left: 120, top: 120, display: 'flex', alignItems: 'center', gap: 24 }}>
        <Mark size={110} />
        <div style={{ fontFamily: MONO, fontSize: 44, fontWeight: 700, letterSpacing: 8 }}>NEON<span style={{ color: C.magenta }}>·</span>STUDIO</div>
      </div>
      <div style={{ position: 'absolute', left: 120, top: 330, width: 1150, fontSize: 168, fontWeight: 900, lineHeight: 0.98, letterSpacing: -5, textShadow: '0 6px 30px rgba(0,0,0,0.7)' }}>
        {words.map((w, i) => (
          <span key={i} style={{ color: i === 0 ? C.magenta : C.text, textShadow: i === 0 ? glow(C.magenta, 24) : undefined }}>{w}{i < words.length - 1 ? ' ' : ''}</span>
        ))}
      </div>
      <div style={{ position: 'absolute', left: 120, bottom: 120, padding: '14px 30px', borderRadius: 16, border: `2px solid ${C.cyan}`, color: C.cyan, fontSize: 50, fontWeight: 700, background: 'rgba(9,9,11,0.85)', boxShadow: glow(C.cyan, 12) }}>{kicker}</div>
    </Canvas>
  );
};
