/**
 * Microphone recording in the main process via ffmpeg/avfoundation. The webview cannot record:
 * views:// is not a secure context, so navigator.mediaDevices does not exist in WKWebView.
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

export class VoiceRecorder {
  private child: ChildProcess | null = null;
  private file: string | null = null;
  private dir: string | null = null;
  private device: string | null = null;
  private startedAt = 0;

  state(): RecorderState {
    return this.child ? { recording: true, device: this.device ?? undefined, startedAt: this.startedAt } : { recording: false };
  }

  /** Pick the default input: first avfoundation audio device whose name mentions "microphone", else index 0. */
  private async pickDevice(ffmpeg: string): Promise<{ index: number; name: string }> {
    const r = await run(ffmpeg, ['-hide_banner', '-f', 'avfoundation', '-list_devices', 'true', '-i', '']);
    const lines = r.stderr.split('\n');
    const audioStart = lines.findIndex((l) => /audio devices/i.test(l));
    const devices: { index: number; name: string }[] = [];
    for (const line of lines.slice(Math.max(0, audioStart))) {
      const m = /\[(\d+)\]\s+(.+)$/.exec(line);
      if (m) devices.push({ index: Number(m[1]), name: m[2]!.trim() });
    }
    if (devices.length === 0) throw new Error('No audio input devices found (check microphone permission in System Settings → Privacy & Security → Microphone)');
    return devices.find((d) => /microphone|micro/i.test(d.name)) ?? devices[0]!;
  }

  async start(): Promise<{ device: string }> {
    if (this.child) throw new Error('Already recording');
    const ffmpeg = (await which('ffmpeg')) ?? 'ffmpeg';
    const device = await this.pickDevice(ffmpeg);
    this.dir = await mkdtemp(join(tmpdir(), 'neon-vo-'));
    this.file = join(this.dir, `voiceover-${new Date().toISOString().slice(11, 19).replace(/:/g, '')}.wav`);
    const child = spawn(ffmpeg, ['-hide_banner', '-y', '-f', 'avfoundation', '-i', `:${device.index}`, '-ac', '1', '-ar', '48000', '-c:a', 'pcm_s16le', this.file], {
      stdio: ['pipe', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr?.on('data', (d: Buffer) => (stderr += d.toString()));
    this.child = child;
    this.device = device.name;
    this.startedAt = Date.now();
    // Fail fast when TCC denies the mic (ffmpeg exits immediately).
    await new Promise((r) => setTimeout(r, 700));
    if (child.exitCode !== null) {
      this.child = null;
      const hint = /not permitted|permission|abort/i.test(stderr) ? ' — grant microphone access to Neon Video Studio in System Settings → Privacy & Security → Microphone, then try again' : '';
      throw new Error(`Recording failed to start (${stderr.trim().split('\n').pop() ?? 'ffmpeg exited'})${hint}`);
    }
    return { device: device.name };
  }

  /** Stop and return the recorded file path (caller imports + cleans up with discard()). */
  async stop(): Promise<{ file: string; durationMs: number }> {
    const child = this.child;
    if (!child || !this.file) throw new Error('Not recording');
    this.child = null;
    const done = new Promise<void>((resolve) => child.once('close', () => resolve()));
    child.stdin?.write('q'); // graceful finish writes the WAV header
    child.stdin?.end();
    const timeout = setTimeout(() => child.kill('SIGINT'), 1500);
    await done;
    clearTimeout(timeout);
    const info = await stat(this.file).catch(() => null);
    if (!info || info.size < 4000) {
      await this.discard();
      throw new Error('Recording was empty');
    }
    return { file: this.file, durationMs: Date.now() - this.startedAt };
  }

  async discard(): Promise<void> {
    this.child?.kill('SIGINT');
    this.child = null;
    if (this.dir) await rm(this.dir, { recursive: true, force: true }).catch(() => undefined);
    this.dir = null;
    this.file = null;
  }
}
