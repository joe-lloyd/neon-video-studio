/**
 * Headless entry: the full main process (control API, renders, AI, recording, sync) without a
 * window. Started by `neon-cli serve`; runs on plain Bun. The renderer can still attach from a
 * browser: http://localhost:5173/?port=<port>&token=<token> with `pnpm dev:renderer`.
 *
 *   bun apps/desktop/src/main/headless.ts [--project <dir.neon>] [--exit-with-stdin]
 */
import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { bootCore } from './core.ts';
import { ProjectStore } from './project-store.ts';

const { values } = parseArgs({ options: { project: { type: 'string' }, 'exit-with-stdin': { type: 'boolean', default: false } }, strict: true });

const core = await bootCore({ headless: true });
const { ctx } = core;
if (values.project) await ctx.store.adopt(await ProjectStore.openDir(resolve(values.project)));

let stopping = false;
const stop = () => {
  if (stopping) return;
  stopping = true;
  core.shutdown();
  void ctx.store.flush().finally(() => process.exit(0));
};
ctx.requestExit = stop;
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
if (values['exit-with-stdin']) {
  // Foreground `neon-cli serve` pipes our stdin: when that parent dies, stdin closes and we follow.
  process.stdin.on('end', stop);
  process.stdin.resume();
}

ctx.events.activity('system', 'app.ready', `Neon Video Studio ${ctx.version} ready (headless) · project “${ctx.store.doc.getMeta().name}” · API :${core.local.port}`);
// One machine-readable line so wrappers can wait for readiness.
console.log(JSON.stringify({ neon: 'ready', port: core.local.port, pid: process.pid, project: ctx.store.dir }));
