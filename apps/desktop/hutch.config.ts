// Hutch orchestrates Electrobun builds. We delegate package management to pnpm (workspace root)
// so the monorepo has a single lockfile and pnpm's minimumReleaseAge policy applies everywhere.
export default {
  packageManager: 'pnpm',
  electrobun: { version: '2.0.1' },
  scripts: {
    install: ['pnpm', 'install', '--ignore-scripts'],
    dev: 'hutch electrobun prepare && pnpm exec vite build && hutch electrobun dev',
    'dev:watch': 'hutch electrobun prepare && pnpm exec vite build && hutch electrobun dev --watch',
    build: 'hutch electrobun prepare && pnpm exec vite build && hutch electrobun build --env=stable',
  },
};
