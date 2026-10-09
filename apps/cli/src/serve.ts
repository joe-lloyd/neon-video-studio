/**
 * `neon-cli serve` / `neon-cli stop`: run the app's main process headless (no window) on Bun so the
 * CLI works without the desktop app — on a server, in CI, or when an agent drives the edit.
 */
import { spawn } from 'node:child_process';
import { existsSync, openSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isProcessAlive, neonHome, readInstanceInfo } from '@neon/core/node';
import { ApiError } from './client.ts';

const HEADLESS_ENTRY = fileURLToPath(new URL('../../desktop/src/main/headless.ts', import.meta.url));

/** Bun is required (the main process uses Bun.serve / Bun.build). NEON_BUN wins, then PATH, then ~/.bun. */
function findBun(): string {
  if (process.env.NEON_BUN) return process.env.NEON_BUN;
  const exe = process.platform === 'win32' ? 'bun.exe' : 'bun';
  const sep = process.platform === 'win32' ? ';' : ':';
  for (const dir of (process.env.PATH ?? '').split(sep)) if (dir && existsSync(join(dir, exe))) return join(dir, exe);
  const home = join(homedir(), '.bun', 'bin', exe);
  if (existsSync(home)) return home;
  throw new ApiError('NO_BUN', 'neon-cli serve needs Bun (https://bun.sh): install it or set NEON_BUN=/path/to/bun');
}

async function liveInstance() {
  const info = await readInstanceInfo();
  return info && isProcessAlive(info.pid) ? info : null;
}

export interface ServeResult {
  pid: number;
  port: number;
  endpoint: string;
  project: string | null;
  log: string | null;
}

/**
 * Start the headless main process. Foreground (default) streams its log and exits with it;
 * detached returns once the control API answers.
 */
export async function serve(opts: { project?: string; detach: boolean; onReady?: (r: ServeResult) => void }): Promise<ServeResult> {
  const existing = await liveInstance();
  if (existing) throw new ApiError('ALREADY_RUNNING', `Neon Video Studio is already running (pid ${existing.pid}, ${existing.headless ? 'headless' : 'desktop'}, port ${existing.port})`);
  if (!existsSync(HEADLESS_ENTRY)) throw new ApiError('NO_SOURCE', `Headless mode runs from a source checkout; ${HEADLESS_ENTRY} is missing`);
  const bun = findBun();
  const args = [HEADLESS_ENTRY, ...(opts.project ? ['--project', opts.project] : [])];

  if (!opts.detach) {
    const child = spawn(bun, [...args, '--exit-with-stdin'], { stdio: ['pipe', 'inherit', 'inherit'] });
    const forward = () => child.kill('SIGTERM');
    process.on('SIGINT', forward);
    process.on('SIGTERM', forward);
    const ready = await waitForReady(child.pid ?? -1, () => child.exitCode !== null);
    opts.onReady?.({ ...ready, log: null });
    await new Promise<void>((resolve) => child.on('exit', () => resolve()));
    return { ...ready, log: null };
  }

  await mkdir(neonHome(), { recursive: true });
  const log = join(neonHome(), 'headless.log');
  const fd = openSync(log, 'a');
  const child = spawn(bun, args, { detached: true, stdio: ['ignore', fd, fd], windowsHide: true });
  child.unref();
  const ready = await waitForReady(child.pid ?? -1, () => child.exitCode !== null);
  return { ...ready, log };
}

async function waitForReady(pid: number, exited: () => boolean): Promise<Omit<ServeResult, 'log'>> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (exited()) throw new ApiError('SERVE_FAILED', `The headless app exited during startup — see ${join(neonHome(), 'headless.log')} or run \`neon-cli serve\` in the foreground`);
    const info = await readInstanceInfo();
    if (info && info.pid === pid) {
      const endpoint = `http://127.0.0.1:${info.port}`;
      const res = await fetch(`${endpoint}/api/status`, { headers: { Authorization: `Bearer ${info.token}` } }).catch(() => null);
      if (res?.ok) return { pid, port: info.port, endpoint, project: info.projectPath };
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new ApiError('SERVE_TIMEOUT', 'The headless app did not become ready within 60 s');
}
