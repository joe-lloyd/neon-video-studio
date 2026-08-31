import { existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { defineConfig, type Alias } from 'vite';
import react from '@vitejs/plugin-react';

const devkit = resolve(__dirname, '.hutch/devkit');

/**
 * `electrobun/view` lives in the Hutch devkit (created by `electrobun prepare`). When it is
 * absent (plain browser development) we alias it to a stub so the UI still runs and falls
 * back to the HTTP control API.
 */
async function electrobunAlias(): Promise<Alias[]> {
  if (existsSync(resolve(devkit, 'package.json'))) {
    // Windows ESM loader requires file:// URLs for absolute-path dynamic imports.
    const mod = (await import(pathToFileURL(resolve(devkit, 'api/config/electrobun-vite.ts')).href)) as {
      electrobunViteAliases: (root: string) => Alias[];
    };
    return mod.electrobunViteAliases(devkit);
  }
  return [{ find: /^electrobun\/view$/, replacement: resolve(__dirname, 'src/renderer/lib/electrobun-stub.ts') }];
}

export default defineConfig(async () => ({
  plugins: [react()],
  root: 'src/renderer',
  base: './',
  resolve: {
    alias: await electrobunAlias(),
    // One copy of these at runtime is essential (Yjs docs and React hooks break otherwise).
    dedupe: ['react', 'react-dom', 'yjs', 'remotion', '@remotion/player'],
  },
  build: {
    outDir: '../../dist',
    emptyOutDir: true,
    target: 'safari16',
    sourcemap: true,
  },
  server: {
    port: 5173,
    strictPort: true,
    fs: { allow: [resolve(__dirname, '../..')] },
  },
  optimizeDeps: {
    // Workspace packages are consumed as TS source; let Vite pre-bundle their deps.
    include: ['react', 'react-dom', 'yjs', 'y-websocket', 'y-webrtc', 'remotion', '@remotion/player', 'lucide-react', 'zod'],
  },
}));
