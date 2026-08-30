/**
 * Spawn the render worker as a Node child process and stream its events. Works from Bun
 * (desktop main process) and Node (CLI).
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RenderJobSpec, WorkerEvent } from './types.ts';

export interface RunRenderOptions {
  workerPath: string;
  nodeBinary?: string;
  onEvent?: (event: WorkerEvent) => void;
  onLog?: (line: string) => void;
  env?: Record<string, string>;
}

export interface RunningRender {
  promise: Promise<{ outputPath: string; durationMs: number }>;
  cancel(): void;
  pid: number | undefined;
}

export function runRenderWorker(spec: RenderJobSpec, opts: RunRenderOptions): RunningRender {
  let child: ChildProcess | undefined;
  let cancelled = false;

  const promise = (async () => {
    const dir = await mkdtemp(join(tmpdir(), 'neon-render-'));
    const jobFile = join(dir, 'job.json');
    await writeFile(jobFile, JSON.stringify(spec));
    try {
      return await new Promise<{ outputPath: string; durationMs: number }>((resolve, reject) => {
        let done: { outputPath: string; durationMs: number } | null = null;
        let failure: Error | null = null;
        const runtime = opts.nodeBinary ?? 'node';
        const isBun = /(^|\/)bun(\.exe)?$/.test(runtime);
        child = spawn(runtime, [...(isBun ? ['run'] : ['--no-warnings']), opts.workerPath, '--job', jobFile], {
          stdio: ['ignore', 'pipe', 'pipe'],
          env: { ...process.env, ...opts.env },
        });
        child.on('error', (err) => reject(new Error(`Could not start render worker (${opts.nodeBinary ?? 'node'}): ${err.message}`)));

        let buffer = '';
        child.stdout?.setEncoding('utf8');
        child.stdout?.on('data', (chunk: string) => {
          buffer += chunk;
          let nl: number;
          while ((nl = buffer.indexOf('\n')) >= 0) {
            const line = buffer.slice(0, nl).trim();
            buffer = buffer.slice(nl + 1);
            if (!line) continue;
            if (line.startsWith('{"neon":1')) {
              try {
                const event = JSON.parse(line) as WorkerEvent;
                if (event.type === 'done') done = { outputPath: event.outputPath, durationMs: event.durationMs };
                if (event.type === 'error') failure = new Error(event.message);
                opts.onEvent?.(event);
                continue;
              } catch {
                /* fall through to log */
              }
            }
            opts.onLog?.(line);
          }
        });
        child.stderr?.setEncoding('utf8');
        child.stderr?.on('data', (chunk: string) => {
          for (const line of chunk.split('\n')) if (line.trim()) opts.onLog?.(line.trim());
        });
        child.on('close', (code) => {
          if (cancelled) return reject(new Error('Render cancelled'));
          if (done) return resolve(done);
          reject(failure ?? new Error(`Render worker exited with code ${code}`));
        });
      });
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  })();

  return {
    promise,
    get pid() {
      return child?.pid;
    },
    cancel() {
      cancelled = true;
      child?.kill('SIGTERM');
      setTimeout(() => child?.kill('SIGKILL'), 5000).unref?.();
    },
  };
}
