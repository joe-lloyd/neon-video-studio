/**
 * Microphone recording in the main process via ffmpeg. The webview cannot record: views:// is
 * not a secure context, so navigator.mediaDevices does not exist in the embedded browser.
 * Capture backend per OS: avfoundation (macOS), dshow (Windows), pulse → alsa (Linux).
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run, which } from '@neon/ai';

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

/**
 * Prefer an actual microphone by name. NOT /micro/i — that matches “Microsoft Teams Audio”
 * and “Microsoft Sound Mapper” (virtual devices) before the real mic.
 */
function pickMic<T>(devices: T[], nameOf: (d: T) => string): T {
  return (
    devices.find((d) => /microphone/i.test(nameOf(d)) && !/^microsoft/i.test(nameOf(d).trim())) ??
    devices.find((d) => /\bmic\b/i.test(nameOf(d))) ??
    devices[0]!
  );
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

  state(): RecorderState {
    return this.child ? { recording: true, device: this.device ?? undefined, startedAt: this.startedAt } : { recording: false };
  }

  /** Ordered capture candidates for this platform (first one that opens wins). */
  private async pickCandidates(ffmpeg: string): Promise<CaptureCandidate[]> {
    if (process.platform === 'darwin') {
      const r = await run(ffmpeg, ['-hide_banner', '-f', 'avfoundation', '-list_devices', 'true', '-i', '']);
      const lines = r.stderr.split('\n');
      const audioStart = lines.findIndex((l) => /audio devices/i.test(l));
      const devices: { index: number; name: string }[] = [];
      for (const line of lines.slice(Math.max(0, audioStart))) {
        const m = /\[(\d+)\]\s+(.+)$/.exec(line);
        if (m) devices.push({ index: Number(m[1]), name: m[2]!.trim() });
      }
      if (devices.length === 0) throw new Error(`No audio input devices found${permissionHint()}`);
      const pick = pickMic(devices, (d) => d.name);
      return [{ inputArgs: ['-f', 'avfoundation', '-i', `:${pick.index}`], name: pick.name }];
    }
    if (process.platform === 'win32') {
      // DirectShow: stderr lists lines like  [dshow @ …] "Microphone (Realtek…)" (audio)
      const r = await run(ffmpeg, ['-hide_banner', '-list_devices', 'true', '-f', 'dshow', '-i', 'dummy']);
      const devices: string[] = [];
      for (const line of r.stderr.split('\n')) {
        const m = /"([^"]+)"\s*\((?:audio|audio, video)\)/i.exec(line);
        if (m) devices.push(m[1]!);
      }
      if (devices.length === 0) throw new Error(`No audio input devices found${permissionHint()}`);
      const pick = pickMic(devices, (d) => d);
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
