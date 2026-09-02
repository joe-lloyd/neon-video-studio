/**
 * Host modules for compiled FX packs. The main process bundles a pack with `react`, `remotion`,
 * `@neon/core` and `@neon/fx-kit` rewritten to `globalThis.__neonPackHost[...]`; we fill that
 * object with THIS bundle's module instances so pack components share our React (hooks work) and
 * our Remotion (useCurrentFrame/useVideoConfig read the Player's context).
 */
import * as React from 'react';
import * as JsxRuntime from 'react/jsx-runtime';
import * as JsxDevRuntime from 'react/jsx-dev-runtime';
import * as ReactDOM from 'react-dom';
import * as Remotion from 'remotion';
import * as Core from '@neon/core';
import * as FxKit from '@neon/fx-kit';

let installed = false;

export function installPackHost(): void {
  if (installed) return;
  installed = true;
  const g = globalThis as { __neonPackHost?: Record<string, unknown> };
  g.__neonPackHost = {
    ...g.__neonPackHost,
    react: React,
    'react/jsx-runtime': JsxRuntime,
    'react/jsx-dev-runtime': JsxDevRuntime,
    'react-dom': ReactDOM,
    remotion: Remotion,
    '@neon/core': Core,
    '@neon/fx-kit': FxKit,
  };
}

/** Import a compiled pack bundle served by the control server. */
export async function importPackBundle(url: string): Promise<Record<string, unknown>> {
  installPackHost();
  return (await import(/* @vite-ignore */ url)) as Record<string, unknown>;
}
