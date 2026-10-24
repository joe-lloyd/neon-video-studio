import { spawn, type ChildProcess } from 'node:child_process';
import { AsyncLocalStorage } from 'node:async_hooks';

const cancellation = new AsyncLocalStorage<AbortSignal>();

/** Carry one job's cancellation through every nested analysis/subprocess without global state. */
export function withAiCancellation<T>(signal: AbortSignal, work: () => T): T {
  return cancellation.run(signal, work);
}

export function aiAbortSignal(): AbortSignal | undefined { return cancellation.getStore(); }
export function throwIfCancelled(): void { aiAbortSignal()?.throwIfAborted(); }

/** Kill the process tree and keep the caller waiting for exit/pipe closure before cleanup. */
export function watchAiProcess(child: ChildProcess): AbortSignal | undefined {
  const signal = aiAbortSignal();
  if (!signal) return undefined;
  let force: ReturnType<typeof setTimeout> | undefined;
  const kill = (hard: boolean) => {
    if (!child.pid) return;
    if (process.platform !== 'win32') {
      try { process.kill(-child.pid, hard ? 'SIGKILL' : 'SIGTERM'); return; } catch { /* already exited */ }
    }
    child.kill(hard ? 'SIGKILL' : 'SIGTERM');
  };
  const abort = () => {
    if (process.platform === 'win32' && child.pid) {
      const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      killer.on('error', () => kill(true));
      killer.on('close', code => { if (code !== 0) kill(true); });
    } else kill(false);
    force = setTimeout(() => kill(true), 1000);
    force.unref();
  };
  signal.addEventListener('abort', abort, { once: true });
  child.once('close', () => {
    signal.removeEventListener('abort', abort);
    if (force) clearTimeout(force);
  });
  if (signal.aborted) abort();
  return signal;
}

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Run a binary, collecting stdout/stderr; `onStderr` receives lines as they arrive (progress). */
export function run(
  cmd: string,
  args: string[],
  opts: { onStderr?: (line: string) => void; onStdout?: (line: string) => void; cwd?: string; maxBuffer?: number; env?: Record<string, string> } = {},
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    throwIfCancelled();
    const child = spawn(cmd, args, { detached: process.platform !== 'win32', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], cwd: opts.cwd, env: opts.env ? { ...process.env, ...opts.env } : undefined });
    const signal = watchAiProcess(child);
    let stdout = '';
    let stderr = '';
    let errBuf = '';
    let outBuf = '';
    child.on('error', (err) => reject(new Error(`${cmd}: ${err.message}`)));
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (d: string) => {
      stdout += d;
      if (opts.onStdout) {
        outBuf += d;
        let i: number;
        while ((i = outBuf.indexOf('\n')) >= 0) {
          opts.onStdout(outBuf.slice(0, i));
          outBuf = outBuf.slice(i + 1);
        }
      }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (d: string) => {
      stderr += d;
      if (stderr.length > (opts.maxBuffer ?? 2_000_000)) stderr = stderr.slice(-500_000);
      if (opts.onStderr) {
        errBuf += d;
        let i: number;
        while ((i = errBuf.search(/[\r\n]/)) >= 0) {
          const line = errBuf.slice(0, i);
          errBuf = errBuf.slice(i + 1);
          if (line.trim()) opts.onStderr(line);
        }
      }
    });
    child.on('close', (code) => {
      if (signal?.aborted) reject(signal.reason);
      else resolve({ code: code ?? -1, stdout, stderr });
    });
  });
}

export async function runOrThrow(cmd: string, args: string[], opts: Parameters<typeof run>[2] = {}): Promise<RunResult> {
  const r = await run(cmd, args, opts);
  if (r.code !== 0) throw new Error(`${cmd} exited with ${r.code}: ${r.stderr.trim().split('\n').slice(-3).join(' | ')}`);
  return r;
}

/** Parse "time=00:00:12.34" from ffmpeg stderr into seconds. */
export function ffmpegTime(line: string): number | null {
  const m = /time=(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(line);
  if (!m) return null;
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
}

/**
 * A file path as an ffmpeg filter option value (e.g. arnndn=m=…). Filter args are escaped twice:
 * the option level splits on ':' (so a Windows drive letter must become 'C\:'), then the whole value
 * is single-quoted for the filtergraph level. Forward slashes work on every OS.
 */
export function filterPath(path: string): string {
  const option = path.replace(/\\/g, '/').replace(/[\\':]/g, (c) => `\\${c}`);
  return `'${option.replace(/'/g, "'\\''")}'`;
}
