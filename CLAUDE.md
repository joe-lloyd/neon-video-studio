# Neon Video Studio — notes for AI assistants

- pnpm workspace; install with `pnpm install --ignore-scripts`. `minimumReleaseAge: 10080` (7 days) is enforced in pnpm-workspace.yaml — a freshly published version will silently resolve to an older one.
- All workspace packages are consumed as TypeScript **source** (package.json `exports` point at `.ts`). Node runs them via type stripping, so: relative imports carry `.ts`/`.tsx` extensions, and `erasableSyntaxOnly` is on (no enums, no constructor parameter properties).
- Desktop main process is **Bun** (Electrobun 2 `mainProcess: "bun"`), renderer is React 19 + Vite. `electrobun/*` types come from `apps/desktop/.hutch/devkit` (created by `pnpm exec electrobun prepare`, git-ignored).
- Typecheck: `pnpm typecheck`. Unit tests: `pnpm test` (node --test). E2E: `node scripts/e2e.ts` (boots a headless app in a temp NEON_HOME; needs Bun; `--no-render` on Intel macs, whose Remotion compositor needs macOS 15). CI runs it on macOS, Windows and Linux.
- Headless mode: `neon-cli serve [--detach]` runs the main process without a window (`apps/desktop/src/main/headless.ts` on Bun); `core.ts` holds everything window-free and must never import `electrobun/*`.
- The Remotion render worker (`packages/render/src/worker.ts`) must run under **Node**, not Bun.
- Time is always integer frames at project fps; parse user input with `parseTimecode()` from `@neon/core`.
- Every mutation goes through `ProjectDoc` (packages/core/src/doc.ts) so CRDT sync, undo and the CLI stay consistent. Use `ORIGIN_LOCAL` for UI edits (undoable) and `ORIGIN_API` for CLI/agent edits.
- FX packs: `pack.json` manifests (packages/core/src/packs.ts). Built-in packs: `apps/remotion-workspace/src/templates/packs`; installed packs: `~/.neon-video/packs`, compiled by `apps/desktop/src/main/packs.ts` (Bun.build + host modules) and webpack-bundled for exports via a generated entry in `packages/render/src/worker.ts`; example packs are workspace packages under `examples/packs/`. Anything the UI can do must also be reachable from `neon-cli` (control API in `apps/desktop/src/main/control-server.ts`, docs in `docs/cli.md`).
- AI features live in `packages/ai` (engines are subprocesses: ffmpeg, whisper-cli, `~/.neon-video/tools/neon-vision`); jobs run in `apps/desktop/src/main/ai-manager.ts`. whisper.cpp: never pass `-nt` (it degrades JSON timestamps).
