import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { hostname, userInfo } from 'node:os';
import { newId } from '@neon/core';
import { paths } from './paths.ts';

export interface Settings {
  peerId: string;
  peerName: string;
  lastProjectPath: string | null;
  recent: string[];
  /**
   * Override where the self-contained render runtime lives. Normally absent: the app uses the
   * dev repo when running from source, otherwise ~/.neon-video/render-runtime/v<version>
   * (downloaded automatically on first render). NEON_RENDER_RUNTIME_DIR beats this.
   */
  renderRuntimeDir?: string;
}

function defaults(): Settings {
  let user = 'editor';
  try {
    user = userInfo().username;
  } catch {
    /* ignore */
  }
  return { peerId: newId('peer'), peerName: `${user}@${hostname().split('.')[0]}`, lastProjectPath: null, recent: [] };
}

export async function loadSettings(): Promise<Settings> {
  try {
    const raw = JSON.parse(await readFile(paths.settingsFile(), 'utf8')) as Partial<Settings>;
    return { ...defaults(), ...raw };
  } catch {
    const s = defaults();
    await saveSettings(s);
    return s;
  }
}

export async function saveSettings(settings: Settings): Promise<void> {
  await mkdir(paths.home(), { recursive: true, mode: 0o700 });
  await writeFile(paths.settingsFile(), JSON.stringify(settings, null, 2), { mode: 0o600 });
}
