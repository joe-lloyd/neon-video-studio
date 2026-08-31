import type { ElectrobunConfig } from 'electrobun';

export default {
  app: {
    name: 'Neon Video Studio',
    identifier: 'com.hypersolid.neon-video-studio',
    version: '0.3.1',
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
} satisfies ElectrobunConfig;
