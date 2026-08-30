import { spawn } from 'node:child_process';

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Run a binary, collecting stdout/stderr; `onStderr` receives lines as they arrive (progress). */
export function run(
  cmd: string,
  args: string[],
  opts: { onStderr?: (line: string) => void; onStdout?: (line: string) => void; cwd?: string; maxBuffer?: number } = {},
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], cwd: opts.cwd });
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
    child.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr }));
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
