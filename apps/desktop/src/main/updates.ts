/**
 * Auto-update via Electrobun's built-in Updater. Artifacts are flat files on GitHub Releases
 * (release.baseUrl → …/releases/latest/download); the updater fetches
 * `stable-<os>-<arch>-update.json`, downloads the full bundle (patches are disabled) and swaps
 * the app in place. Dev-channel builds never see updates.
 */
import { Updater } from 'electrobun/main';
import type { MainContext } from './context.ts';
import type { UpdateState } from '../shared/rpc.ts';

const BOOT_CHECK_DELAY_MS = 8_000;
const RECHECK_INTERVAL_MS = 4 * 60 * 60 * 1000;

export class UpdateManager {
  private state: UpdateState;
  private promptedVersion: string | null = null;
  private busy = false;
  private ctx: MainContext;

  constructor(ctx: MainContext) {
    this.ctx = ctx;
    this.state = { phase: 'idle', currentVersion: ctx.version };
    Updater.onStatusChange((entry) => {
      if (entry.status === 'download-progress' && typeof entry.details?.progress === 'number') {
        this.set({ phase: 'downloading', progress: entry.details.progress / 100 });
      } else if (entry.status === 'applying' || entry.status === 'replacing-app' || entry.status === 'launching-new-version') {
        this.set({ phase: 'installing', progress: undefined });
      }
    });
  }

  current(): UpdateState {
    return this.state;
  }

  /** Boot check (quiet unless an update exists) + periodic re-check. Timers stay unref'd-less: the app lives as long as the window anyway. */
  start(): void {
    setTimeout(() => void this.check().catch(() => undefined), BOOT_CHECK_DELAY_MS);
    setInterval(() => void this.check().catch(() => undefined), RECHECK_INTERVAL_MS);
  }

  private set(patch: Partial<UpdateState>): void {
    this.state = { ...this.state, ...patch };
    this.ctx.rpc?.send.updateStatus({ state: this.state });
  }

  async check(): Promise<UpdateState> {
    if (this.busy) return this.state;
    let channel = 'dev';
    try {
      channel = await Updater.localInfo.channel();
    } catch {
      /* no version.json → dev */
    }
    if (channel === 'dev' || !channel) {
      this.set({ phase: 'unsupported', error: 'dev build — updates come from git' });
      return this.state;
    }
    this.set({ phase: 'checking', error: undefined });
    const info = await Updater.checkForUpdate();
    if (info.error) {
      this.set({ phase: 'error', error: info.error });
    } else if (info.updateAvailable) {
      this.set({ phase: 'available', version: info.version });
      if (this.promptedVersion !== info.version) {
        this.promptedVersion = info.version;
        this.ctx.rpc?.send.toast({ kind: 'info', message: `Update ${info.version} is available — click “Update” in the title bar to install and restart.` });
        this.ctx.events.activity('system', 'update.available', `Update ${info.version} available (running ${this.ctx.version})`);
      }
    } else {
      this.set({ phase: 'up-to-date', version: undefined });
    }
    return this.state;
  }

  /** Download (if needed) and restart into the new version. Resolves only on failure — success replaces the process. */
  async apply(): Promise<UpdateState> {
    if (this.busy) return this.state;
    this.busy = true;
    try {
      if (this.state.phase !== 'available') {
        this.busy = false;
        const checked = await this.check();
        if (checked.phase !== 'available') return checked;
        this.busy = true;
      }
      this.set({ phase: 'downloading', progress: 0 });
      await Updater.downloadUpdate();
      if (!Updater.updateInfo().updateReady) {
        throw new Error(Updater.updateInfo().error || 'update bundle did not become ready');
      }
      // Don't lose edits: the store autosaves, but flush explicitly before the process is replaced.
      await this.ctx.store.flush();
      this.set({ phase: 'installing' });
      this.ctx.events.activity('system', 'update.installing', `Installing ${this.state.version ?? 'update'} and restarting`);
      await Updater.applyUpdate();
      return this.state;
    } catch (err) {
      this.set({ phase: 'error', error: (err as Error).message });
      return this.state;
    } finally {
      this.busy = false;
    }
  }
}
