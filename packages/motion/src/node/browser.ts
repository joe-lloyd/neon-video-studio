/**
 * Find, download and launch a headless Chrome for rendering.
 *
 * Resolution order: explicit path → $NEON_CHROME_PATH → an installed Chrome / Chromium / Edge →
 * a chrome-headless-shell previously downloaded to ~/.neon-video/browser → download the current
 * stable chrome-headless-shell from Chrome for Testing.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { mkdir, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { CdpConnection, type CdpSession } from './cdp.ts';

export type LogFn = (line: string) => void;

const CFT_ENDPOINT = 'https://googlechromelabs.github.io/chrome-for-testing/last-known-good-versions-with-downloads.json';

export function browserCacheDir(): string {
  return join(homedir(), '.neon-video', 'browser');
}

function cftPlatform(): string | null {
  if (process.platform === 'darwin') return process.arch === 'arm64' ? 'mac-arm64' : 'mac-x64';
  if (process.platform === 'win32') return process.arch === 'x64' || process.arch === 'arm64' ? 'win64' : 'win32';
  if (process.platform === 'linux' && process.arch === 'x64') return 'linux64';
  return null;
}

function shellBinaryName(): string {
  return process.platform === 'win32' ? 'chrome-headless-shell.exe' : 'chrome-headless-shell';
}

/** Well-known install locations of Chrome-family browsers on this platform. */
export function systemBrowserCandidates(): string[] {
  if (process.platform === 'darwin') {
    const apps = [
      'Google Chrome.app/Contents/MacOS/Google Chrome',
      'Chromium.app/Contents/MacOS/Chromium',
      'Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
      'Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      'Brave Browser.app/Contents/MacOS/Brave Browser',
    ];
    return [...apps.map((a) => join('/Applications', a)), ...apps.map((a) => join(homedir(), 'Applications', a))];
  }
  if (process.platform === 'win32') {
    const roots = [process.env['PROGRAMFILES'], process.env['PROGRAMFILES(X86)'], process.env['LOCALAPPDATA']].filter((r): r is string => Boolean(r));
    const rel = ['Google\\Chrome\\Application\\chrome.exe', 'Chromium\\Application\\chrome.exe', 'Microsoft\\Edge\\Application\\msedge.exe'];
    return roots.flatMap((root) => rel.map((r) => join(root, r)));
  }
  return [
    '/usr/bin/google-chrome-stable',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/snap/bin/chromium',
    '/usr/bin/microsoft-edge',
    '/opt/google/chrome/chrome',
  ];
}

function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/** Newest chrome-headless-shell under ~/.neon-video/browser/<version>/chrome-headless-shell-<platform>/. */
export async function findDownloadedShell(cacheDir = browserCacheDir()): Promise<string | null> {
  const platform = cftPlatform();
  if (!platform) return null;
  const versions = (await readdir(cacheDir).catch(() => [] as string[])).filter((v) => /^\d+(\.\d+)+$/.test(v)).sort(compareVersions).reverse();
  for (const version of versions) {
    const bin = join(cacheDir, version, `chrome-headless-shell-${platform}`, shellBinaryName());
    if (existsSync(bin)) return bin;
  }
  return null;
}

/** Download (once) the current stable chrome-headless-shell into `cacheDir`; returns the binary path. */
export async function downloadChromeHeadlessShell(cacheDir = browserCacheDir(), onLog?: LogFn): Promise<string> {
  const platform = cftPlatform();
  if (!platform) throw new Error(`No chrome-headless-shell build for ${process.platform}/${process.arch}; install Chrome or set NEON_CHROME_PATH`);
  const res = await fetch(CFT_ENDPOINT);
  if (!res.ok) throw new Error(`Chrome for Testing index: HTTP ${res.status}`);
  const index = (await res.json()) as {
    channels: Record<string, { version: string; downloads: Record<string, { platform: string; url: string }[]> }>;
  };
  const stable = index.channels['Stable'];
  const entry = stable?.downloads['chrome-headless-shell']?.find((d) => d.platform === platform);
  if (!stable || !entry) throw new Error(`Chrome for Testing has no chrome-headless-shell for ${platform}`);
  const target = join(cacheDir, stable.version);
  const bin = join(target, `chrome-headless-shell-${platform}`, shellBinaryName());
  if (existsSync(bin)) return bin;

  onLog?.(`Downloading chrome-headless-shell ${stable.version} (${platform})…`);
  await mkdir(cacheDir, { recursive: true });
  const staging = join(cacheDir, `.staging-${stable.version}-${process.pid}-${Date.now()}`);
  await mkdir(staging, { recursive: true });
  try {
    const zip = await fetch(entry.url);
    if (!zip.ok || !zip.body) throw new Error(`Download failed: HTTP ${zip.status} for ${entry.url}`);
    const zipPath = join(staging, 'shell.zip');
    await writeFile(zipPath, Buffer.from(await zip.arrayBuffer()));
    const extract = process.platform === 'win32'
      ? spawnSync('tar', ['-xf', zipPath, '-C', staging], { stdio: 'pipe' })
      : spawnSync('unzip', ['-q', '-o', zipPath, '-d', staging], { stdio: 'pipe' });
    if (extract.status !== 0) throw new Error(`Could not extract chrome-headless-shell: ${extract.stderr?.toString() || extract.error?.message || `exit ${extract.status}`}`);
    await rm(zipPath, { force: true });
    try {
      await rename(staging, target);
    } catch (err) {
      // Another process finished the same download first.
      if (!existsSync(bin)) throw err;
    }
    if (!existsSync(bin)) throw new Error(`Downloaded chrome-headless-shell has no ${shellBinaryName()} where expected`);
    onLog?.(`chrome-headless-shell installed at ${bin}`);
    return bin;
  } finally {
    await rm(staging, { recursive: true, force: true }).catch(() => undefined);
  }
}

export interface ResolveBrowserOptions {
  executablePath?: string | null;
  /** Download chrome-headless-shell when nothing is installed (default true). */
  allowDownload?: boolean;
  cacheDir?: string;
  onLog?: LogFn;
}

export async function resolveBrowserExecutable(opts: ResolveBrowserOptions = {}): Promise<string> {
  if (opts.executablePath) {
    if (!existsSync(opts.executablePath)) throw new Error(`Browser executable not found: ${opts.executablePath}`);
    return opts.executablePath;
  }
  const fromEnv = process.env['NEON_CHROME_PATH'];
  if (fromEnv) {
    if (!existsSync(fromEnv)) throw new Error(`NEON_CHROME_PATH points at a missing file: ${fromEnv}`);
    return fromEnv;
  }
  for (const candidate of systemBrowserCandidates()) if (existsSync(candidate)) return candidate;
  const cacheDir = opts.cacheDir ?? browserCacheDir();
  const downloaded = await findDownloadedShell(cacheDir);
  if (downloaded) return downloaded;
  if (opts.allowDownload === false) throw new Error('No Chrome found; install Google Chrome or set NEON_CHROME_PATH');
  return downloadChromeHeadlessShell(cacheDir, opts.onLog);
}

// ---- process lifetime ---------------------------------------------------------------------

interface LiveBrowser {
  child: ChildProcess;
  profileDir: string;
}

const live = new Set<LiveBrowser>();
let hooksInstalled = false;

function killAllSync(): void {
  for (const b of live) {
    try {
      b.child.kill('SIGKILL');
    } catch {
      /* already gone */
    }
    try {
      rmSync(b.profileDir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
  live.clear();
}

/**
 * Make sure Chrome never outlives this process: kill on exit, and on SIGTERM/SIGINT/SIGHUP when
 * nothing else handles the signal (then re-raise it so the default behaviour still applies).
 */
function installExitHooks(): void {
  if (hooksInstalled) return;
  hooksInstalled = true;
  process.on('exit', killAllSync);
  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) {
    const handler = () => {
      killAllSync();
      if (process.listenerCount(signal) === 1) {
        process.removeListener(signal, handler);
        process.kill(process.pid, signal);
      }
    };
    process.on(signal, handler);
  }
}

// ---- launch -------------------------------------------------------------------------------

export interface LaunchOptions extends ResolveBrowserOptions {
  extraArgs?: string[];
  /** How long to wait for the DevTools endpoint (default 30 s). */
  timeoutMs?: number;
}

export interface Page {
  targetId: string;
  session: CdpSession;
}

export interface Browser {
  executablePath: string;
  connection: CdpConnection;
  /** Open a blank page in its own window and attach a flattened session to it. */
  newPage(): Promise<Page>;
  close(): Promise<void>;
  /** Resolves when the browser process has exited (for any reason). */
  exited: Promise<number | null>;
}

export function chromeArgs(executablePath: string, profileDir: string, extra: string[] = []): string[] {
  const isShell = basename(executablePath).startsWith('chrome-headless-shell');
  const args = [
    ...(isShell ? [] : ['--headless=new']),
    `--user-data-dir=${profileDir}`,
    '--remote-debugging-port=0',
    '--force-color-profile=srgb',
    '--hide-scrollbars',
    '--mute-audio',
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
    '--disable-backgrounding-occluded-windows',
    '--autoplay-policy=no-user-gesture-required',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--disable-component-update',
    '--disable-default-apps',
    '--disable-sync',
    '--disable-ipc-flooding-protection',
    '--disable-features=Translate,MediaRouter,OptimizationHints,DialMediaRouteProvider',
    '--password-store=basic',
    '--use-mock-keychain',
  ];
  if (process.platform === 'linux') {
    args.push('--disable-dev-shm-usage');
    if (process.getuid?.() === 0) args.push('--no-sandbox');
  }
  args.push(...extra, 'about:blank');
  return args;
}

export async function launchBrowser(opts: LaunchOptions = {}): Promise<Browser> {
  const executablePath = await resolveBrowserExecutable(opts);
  const profileDir = mkdtempSync(join(tmpdir(), 'neon-chrome-'));
  installExitHooks();
  const child = spawn(executablePath, chromeArgs(executablePath, profileDir, opts.extraArgs), { stdio: ['ignore', 'ignore', 'pipe'] });
  const entry: LiveBrowser = { child, profileDir };
  live.add(entry);

  const exited = new Promise<number | null>((resolve) => {
    child.once('exit', (code) => resolve(code));
    child.once('error', () => resolve(null));
  });
  void exited.then(() => {
    live.delete(entry);
    rmSync(profileDir, { recursive: true, force: true });
  });

  let wsUrl: string;
  try {
    wsUrl = await new Promise<string>((resolve, reject) => {
      let stderr = '';
      const timer = setTimeout(() => fail(new Error(`Chrome did not expose a DevTools endpoint within ${opts.timeoutMs ?? 30_000} ms`)), opts.timeoutMs ?? 30_000);
      const onData = (chunk: Buffer) => {
        stderr += chunk.toString('utf8');
        const m = /DevTools listening on (ws:\/\/\S+)/.exec(stderr);
        if (m) {
          cleanup();
          // Keep draining stderr so Chrome never blocks on a full pipe.
          child.stderr?.on('data', () => undefined);
          resolve(m[1]!);
        }
      };
      const onExit = (code: number | null) => fail(new Error(`Chrome exited (code ${code}) before DevTools was ready:\n${stderr.slice(-2000)}`));
      const onError = (err: Error) => fail(new Error(`Could not start Chrome at ${executablePath}: ${err.message}`));
      const fail = (err: Error) => {
        cleanup();
        reject(err);
      };
      const cleanup = () => {
        clearTimeout(timer);
        child.stderr?.off('data', onData);
        child.off('exit', onExit);
        child.off('error', onError);
      };
      child.stderr?.on('data', onData);
      child.once('exit', onExit);
      child.once('error', onError);
    });
  } catch (err) {
    child.kill('SIGKILL');
    throw err;
  }

  let connection: CdpConnection;
  try {
    connection = await CdpConnection.connect(wsUrl);
  } catch (err) {
    child.kill('SIGKILL');
    throw err;
  }

  let closing: Promise<void> | null = null;
  return {
    executablePath,
    connection,
    exited,
    async newPage() {
      // Its own window: background tabs of one window are hidden and get no animation frames.
      const { targetId } = await connection.send<{ targetId: string }>('Target.createTarget', { url: 'about:blank', newWindow: true });
      const { sessionId } = await connection.send<{ sessionId: string }>('Target.attachToTarget', { targetId, flatten: true });
      return { targetId, session: connection.session(sessionId) };
    },
    close() {
      closing ??= (async () => {
        if (child.exitCode === null && child.signalCode === null) {
          await connection.send('Browser.close', {}, undefined, 2_000).catch(() => undefined);
          const timer = setTimeout(() => child.kill('SIGKILL'), 3_000);
          await exited;
          clearTimeout(timer);
        }
        connection.close();
        live.delete(entry);
        await rm(profileDir, { recursive: true, force: true }).catch(() => undefined);
      })();
      return closing;
    },
  };
}
