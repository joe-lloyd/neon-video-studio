/**
 * Drive the app on another machine (`--on <host>` / NEON_HOST) through an SSH tunnel.
 *
 * The control API stays loopback-only on the remote machine; SSH is the authentication. The CLI
 * reads the remote instance file over SSH, forwards a local port to the remote API with `ssh -N -L`,
 * and keeps that tunnel running between commands (state in <NEON_HOME>/remotes/<host>.json). When
 * the remote app restarts on a new port the tunnel is rebuilt on the next command.
 */
import { spawn, spawnSync } from 'node:child_process';
import { openAsBlob } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { basename, dirname, join } from 'node:path';
import { isProcessAlive, neonHome } from '@neon/core/node';
import { ApiError, type ClientOptions } from './client.ts';

/** The remote host from --on or NEON_HOST (an ssh destination: alias, host or user@host). */
export function remoteHost(on: string | undefined): string | null {
  const host = on ?? process.env.NEON_HOST;
  return host && host.trim() ? host.trim() : null;
}

interface TunnelState {
  host: string;
  localPort: number;
  remotePort: number;
  remotePid: number;
  token: string;
  sshPid: number;
}

interface RemoteInstance {
  port: number;
  token: string;
  pid: number;
}

function stateFile(host: string): string {
  return join(neonHome(), 'remotes', `${host.replace(/[^\w.@-]/g, '_')}.json`);
}

function ssh(host: string, command: string): { ok: boolean; stdout: string; stderr: string } {
  const r = spawnSync('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', host, command], { encoding: 'utf8', timeout: 30_000 });
  return { ok: r.status === 0, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

/** The remote shell is POSIX (macOS/Linux), cmd or PowerShell (Windows): try each way to read the instance file. */
function readRemoteInstance(host: string): RemoteInstance | null {
  const attempts = ['cat ~/.neon-video/instance.json', 'type "%USERPROFILE%\\.neon-video\\instance.json"', 'Get-Content "$env:USERPROFILE\\.neon-video\\instance.json"'];
  let lastError = '';
  for (const cmd of attempts) {
    const r = ssh(host, cmd);
    if (r.stderr.includes('Permission denied') || r.stderr.includes('Could not resolve') || r.stderr.includes('timed out')) {
      throw new ApiError('SSH_FAILED', `ssh ${host} failed: ${r.stderr.trim().split('\n').pop()}`);
    }
    const start = r.stdout.indexOf('{');
    if (!r.ok || start < 0) {
      lastError = r.stderr.trim();
      continue;
    }
    try {
      const info = JSON.parse(r.stdout.slice(start)) as Partial<RemoteInstance>;
      if (typeof info.port === 'number' && typeof info.token === 'string' && typeof info.pid === 'number') return { port: info.port, token: info.token, pid: info.pid };
    } catch {
      /* try the next shell */
    }
  }
  if (lastError && process.env.NEON_VERBOSE) process.stderr.write(`remote instance read: ${lastError}\n`);
  return null;
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

async function answers(endpoint: string, token: string, timeoutMs = 2500): Promise<boolean> {
  try {
    const res = await fetch(`${endpoint}/api/status`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(timeoutMs) });
    return res.ok;
  } catch {
    return false;
  }
}

async function readState(host: string): Promise<TunnelState | null> {
  try {
    return JSON.parse(await readFile(stateFile(host), 'utf8')) as TunnelState;
  } catch {
    return null;
  }
}

/** Endpoint + token for the app on `host`, opening (or reusing) the SSH tunnel. */
export async function connectRemote(host: string): Promise<ClientOptions> {
  const cached = await readState(host);
  if (cached && isProcessAlive(cached.sshPid)) {
    const endpoint = `http://127.0.0.1:${cached.localPort}`;
    if (await answers(endpoint, cached.token)) return { endpoint, token: cached.token };
  }
  if (cached) await disconnectRemote(host);

  const instance = readRemoteInstance(host);
  if (!instance) throw new ApiError('NOT_RUNNING', `Neon Video Studio is not running on ${host}. Start it there, or run: neon-cli --on ${host} launch`);
  const localPort = await freePort();
  const tunnel = spawn('ssh', ['-N', '-o', 'BatchMode=yes', '-o', 'ExitOnForwardFailure=yes', '-o', 'ServerAliveInterval=30', '-L', `127.0.0.1:${localPort}:127.0.0.1:${instance.port}`, host], {
    detached: true,
    stdio: 'ignore',
  });
  tunnel.unref();
  const endpoint = `http://127.0.0.1:${localPort}`;
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (tunnel.exitCode !== null) break;
    if (await answers(endpoint, instance.token, 1500)) {
      await mkdir(join(neonHome(), 'remotes'), { recursive: true });
      const state: TunnelState = { host, localPort, remotePort: instance.port, remotePid: instance.pid, token: instance.token, sshPid: tunnel.pid ?? -1 };
      await writeFile(stateFile(host), JSON.stringify(state, null, 2), { mode: 0o600 });
      return { endpoint, token: instance.token };
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  tunnel.kill();
  throw new ApiError('UNREACHABLE', `Found the app on ${host} (port ${instance.port}) but could not reach it through an SSH tunnel. Is it still running? The instance file may be stale.`);
}

/** Close the tunnel to `host`. Returns false when there was none. */
export async function disconnectRemote(host: string): Promise<boolean> {
  const state = await readState(host);
  if (!state) return false;
  if (isProcessAlive(state.sshPid)) {
    try {
      process.kill(state.sshPid);
    } catch {
      /* already gone */
    }
  }
  await rm(stateFile(host), { force: true });
  return true;
}

/** Start the desktop app in the remote user's desktop session and wait for its control API. */
export async function launchRemote(host: string): Promise<ClientOptions> {
  const probe = ssh(host, 'uname -s');
  if (probe.ok && /Darwin/.test(probe.stdout)) {
    const r = ssh(host, "open -a 'Neon Video Studio'");
    if (!r.ok) throw new ApiError('LAUNCH_FAILED', `Could not open the app on ${host}: ${r.stderr.trim()}`);
  } else if (probe.ok && /Linux/.test(probe.stdout)) {
    throw new ApiError('LAUNCH_FAILED', `Start the app on ${host} yourself (or run neon-cli serve there); launching a Linux desktop app over SSH is not supported`);
  } else {
    // Windows: processes started from SSH live in a session with no desktop. A one-off scheduled
    // task with /IT runs in the signed-in user's session, so the window (and screen capture) work.
    const launcher = '%LOCALAPPDATA%\\com.hypersolid.neon-video-studio\\stable\\app\\bin\\launcher.exe';
    const r = ssh(host, `schtasks /create /tn NeonVideoStudioLaunch /tr "${launcher}" /sc once /st 00:00 /it /f >nul && schtasks /run /tn NeonVideoStudioLaunch`);
    if (!r.ok) throw new ApiError('LAUNCH_FAILED', `Could not start the app on ${host}: ${(r.stderr || r.stdout).trim()}. Is someone signed in at the desktop?`);
  }
  const deadline = Date.now() + 60_000;
  let lastPid: number | null = null;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 2000));
    const instance = readRemoteInstance(host);
    if (instance && instance.pid !== lastPid) {
      lastPid = instance.pid;
      try {
        return await connectRemote(host);
      } catch {
        /* the app may still be starting; the instance file can be a stale one */
      }
    }
  }
  throw new ApiError('LAUNCH_TIMEOUT', `The app on ${host} did not answer within 60 s`);
}

/** Upload a local file into the remote project (POST /api/assets/upload). */
export async function uploadAsset(api: ClientOptions, file: string, opts: { at?: string; trackId?: string }): Promise<unknown> {
  const params = new URLSearchParams({ name: basename(file) });
  if (opts.at !== undefined) params.set('at', opts.at);
  if (opts.trackId) params.set('track', opts.trackId);
  const res = await fetch(`${api.endpoint}/api/assets/upload?${params}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${api.token}`, 'Content-Type': 'application/octet-stream' },
    // A file-backed Blob streams from disk: screen recordings can be gigabytes.
    body: await openAsBlob(file),
  });
  const json = (await res.json().catch(() => null)) as { ok: boolean; data?: unknown; error?: { code: string; message: string } } | null;
  if (!json) throw new ApiError('BAD_RESPONSE', `Upload of ${basename(file)} failed (${res.status})`);
  if (!json.ok) throw new ApiError(json.error?.code ?? 'UPLOAD_FAILED', json.error?.message ?? 'upload failed');
  return json.data;
}

/** Download a file the remote app produced (a render, still or sheet) to a local path. */
export async function downloadOutput(api: ClientOptions, remotePath: string, localPath: string): Promise<string> {
  const res = await fetch(`${api.endpoint}/api/files?path=${encodeURIComponent(remotePath)}`, { headers: { Authorization: `Bearer ${api.token}` } });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: { message: string } } | null;
    throw new ApiError('DOWNLOAD_FAILED', `Could not fetch ${remotePath}: ${body?.error?.message ?? res.status}`);
  }
  await mkdir(dirname(localPath), { recursive: true });
  await writeFile(localPath, new Uint8Array(await res.arrayBuffer()));
  return localPath;
}
