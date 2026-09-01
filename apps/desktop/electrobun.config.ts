import type { ElectrobunConfig } from 'electrobun';

export default {
  app: {
    name: 'Neon Video Studio',
    identifier: 'com.hypersolid.neon-video-studio',
    version: '0.6.6',
  },
  build: {
    // Bun (not Cottontail): we rely on Bun.serve (HTTP + WebSocket), node:dgram multicast and
    // node:child_process — all verified against Electrobun 2.0.1 + Bun 1.4.0.
    mainProcess: 'bun',
    bun: {
      entrypoint: 'src/main/index.ts',
    },
    // Vite builds the renderer to dist/; Electrobun copies it into the bundle as views://mainview
    copy: {
      'dist/index.html': 'views/mainview/index.html',
      'dist/assets': 'views/mainview/assets',
    },
    watchIgnore: ['dist/**', 'build/**'],
    mac: { bundleCEF: false, icons: 'icons/icon.iconset' },
    linux: { bundleCEF: false, icon: 'icons/icon.png' },
    win: { bundleCEF: false, icon: 'icons/icon-win.png' },
  },
  release: {
    // Auto-update feed: the updater fetches stable-<os>-<arch>-update.json + the .tar.zst bundle
    // from here. CI uploads apps/desktop/artifacts/* to every GitHub release, and `latest` always
    // points at the newest one. Patches are off — full-bundle updates only, no cross-release state.
    baseUrl: 'https://github.com/joe-lloyd/neon-video-studio/releases/latest/download',
    generatePatch: false,
  },
} satisfies ElectrobunConfig;
