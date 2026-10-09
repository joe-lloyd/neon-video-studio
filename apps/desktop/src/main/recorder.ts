/**
 * Microphone recording in the main process via ffmpeg. The webview cannot record: views:// is
 * not a secure context, so navigator.mediaDevices does not exist in the embedded browser.
 * Capture backend per OS: avfoundation (macOS), dshow (Windows), pulse → alsa (Linux).
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseAvfoundationDevices, parseDshowAudioDevices, pickMic, run, which } from '@neon/ai';

export interface RecorderState {
  recording: boolean;
  device?: string;
  startedAt?: number;
}

/** One way of opening the microphone: ffmpeg input args + a human-readable name. */
interface CaptureCandidate {
  inputArgs: string[];
  name: string;
}

function permissionHint(): string {
  switch (process.platform) {
    case 'darwin':
      return ' — grant microphone access to Neon Video Studio in System Settings → Privacy & Security → Microphone, then try again';
    case 'win32':
      // Desktop apps never appear in Windows' per-app microphone list — only the global toggles apply.
      return ' — in Settings → Privacy & security → Microphone, turn ON both “Microphone access” and “Let desktop apps access your microphone” (desktop apps like Neon Video Studio don’t show up in the per-app list), then try again';
    default:
      return ' — check your audio input (pactl list sources); note that a distro ffmpeg (sudo apt install ffmpeg) has PulseAudio support, static builds may not';
  }
}

export class VoiceRecorder {
  private child: ChildProcess | null = null;
  private file: string | null = null;
  private dir: string | null = null;
  private device: string | null = null;
  private startedAt = 0;
  /** Why recording is not possible right now (a screen capture owns the mic), or null. */
  private readonly blockedBy: () => string | null;

  constructor(blockedBy: () => string | null = () => null) {
    this.blockedBy = blockedBy;
  }

  state(): RecorderState {
    return this.child ? { recording: true, device: this.device ?? undefined, startedAt: this.startedAt } : { recording: false };
  }

  /** Ordered capture candidates for this platform (first one that opens wins). */
  private async pickCandidates(ffmpeg: string): Promise<CaptureCandidate[]> {
    if (process.platform === 'darwin') {
      const r = await run(ffmpeg, ['-hide_banner', '-f', 'avfoundation', '-list_devices', 'true', '-i', '']);
      const devices = parseAvfoundationDevices(r.stderr).audio;
      const pick = pickMic(devices, (d) => d.name);
      if (pick === undefined) throw new Error(`No audio input devices found${permissionHint()}`);
      return [{ inputArgs: ['-f', 'avfoundation', '-i', `:${pick.index}`], name: pick.name }];
    }
    if (process.platform === 'win32') {
      // DirectShow: stderr lists lines like  [dshow @ …] "Microphone (Realtek…)" (audio)
      const r = await run(ffmpeg, ['-hide_banner', '-list_devices', 'true', '-f', 'dshow', '-i', 'dummy']);
      const devices = parseDshowAudioDevices(r.stderr);
      const pick = pickMic(devices, (d) => d);
      if (pick === undefined) throw new Error(`No audio input devices found${permissionHint()}`);
      return [{ inputArgs: ['-f', 'dshow', '-i', `audio=${pick}`], name: pick }];
    }
    // Linux: PulseAudio/PipeWire first, raw ALSA as fallback (static ffmpeg builds may lack pulse).
    return [
      { inputArgs: ['-f', 'pulse', '-i', 'default'], name: 'default (pulse)' },
      { inputArgs: ['-f', 'alsa', '-i', 'default'], name: 'default (alsa)' },
    ];
  }

  async start(): Promise<{ device: string }> {
    if (this.child) throw new Error('Already recording');
    const blocked = this.blockedBy();
    if (blocked) throw new Error(blocked);
    const ffmpeg = (await which('ffmpeg')) ?? 'ffmpeg';
    const candidates = await this.pickCandidates(ffmpeg);
    this.dir = await mkdtemp(join(tmpdir(), 'neon-vo-'));
    this.file = join(this.dir, `voiceover-${new Date().toISOString().slice(11, 19).replace(/:/g, '')}.wav`);

    let lastError = 'ffmpeg exited';
    for (const candidate of candidates) {
      const child = spawn(ffmpeg, ['-hide_banner', '-y', ...candidate.inputArgs, '-ac', '1', '-ar', '48000', '-c:a', 'pcm_s16le', this.file], {
        stdio: ['pipe', 'ignore', 'pipe'],
      });
      let stderr = '';
      child.stderr?.on('data', (d: Buffer) => (stderr += d.toString()));
      // Fail fast when the OS denies the mic or the input format is unsupported (ffmpeg exits immediately).
      await new Promise((r) => setTimeout(r, 700));
      if (child.exitCode === null) {
        this.child = child;
        this.device = candidate.name;
        this.startedAt = Date.now();
        return { device: candidate.name };
      }
      lastError = stderr.trim().split('\n').pop() ?? lastError;
    }
    const hint = /not permitted|permission|denied|i\/o error|could not|abort/i.test(lastError) ? permissionHint() : '';
    throw new Error(`Recording failed to start (${lastError})${hint}`);
  }

  /** Stop and return the recorded file path (caller imports + cleans up with discard()). */
  async stop(): Promise<{ file: string; durationMs: number }> {
    const child = this.child;
    if (!child || !this.file) throw new Error('Not recording');
    this.child = null;
    const done = new Promise<void>((resolve) => child.once('close', () => resolve()));
    child.stdin?.write('q'); // graceful finish writes the WAV header (works on all platforms)
    child.stdin?.end();
    const timeout = setTimeout(() => child.kill(process.platform === 'win32' ? undefined : 'SIGINT'), 1500);
    await done;
    clearTimeout(timeout);
    const info = await stat(this.file).catch(() => null);
    if (!info || info.size < 4000) {
      await this.discard();
      throw new Error(`Recording was empty${permissionHint()}`);
    }
    return { file: this.file, durationMs: Date.now() - this.startedAt };
  }

  async discard(): Promise<void> {
    this.child?.kill(process.platform === 'win32' ? undefined : 'SIGINT');
    this.child = null;
    if (this.dir) await rm(this.dir, { recursive: true, force: true }).catch(() => undefined);
    this.dir = null;
    this.file = null;
  }
}
