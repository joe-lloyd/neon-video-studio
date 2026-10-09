/**
 * Screen capture with ffmpeg: device-list parsers, target resolution and argument builders.
 * Everything here is pure so each OS path is unit-tested on any machine; the main process
 * (apps/desktop/src/main/screen-recorder.ts) runs the commands.
 *
 *   macOS   avfoundation, screen + mic in ONE input ("<screen>:<audio>") for the best A/V sync
 *   Windows gdigrab (desktop / one monitor / region / window by title) + dshow mic as a 2nd input
 *   Linux   x11grab + pulse (Wayland has no x11grab equivalent in ffmpeg: refused up front)
 */
import type { CaptureDevices, CaptureMic, CaptureRect, CaptureSource } from '@neon/core';

export type CapturePlatform = CaptureDevices['platform'];

export function capturePlatform(platform: NodeJS.Platform): CapturePlatform | null {
  return platform === 'darwin' || platform === 'win32' || platform === 'linux' ? platform : null;
}

// ---- device lists -----------------------------------------------------------------------

/** An avfoundation device: `[1] Capture screen 0` → { index: 1, name: 'Capture screen 0' }. */
export interface AvDevice {
  index: number;
  name: string;
}

/** Parse `ffmpeg -f avfoundation -list_devices true -i ""` stderr. */
export function parseAvfoundationDevices(stderr: string): { video: AvDevice[]; audio: AvDevice[] } {
  const video: AvDevice[] = [];
  const audio: AvDevice[] = [];
  let section: AvDevice[] | null = null;
  for (const line of stderr.split(/\r?\n/)) {
    if (/AVFoundation video devices/i.test(line)) section = video;
    else if (/AVFoundation audio devices/i.test(line)) section = audio;
    else {
      const m = /\]\s+\[(\d+)\]\s+(.+?)\s*$/.exec(line);
      if (m && section) section.push({ index: Number(m[1]), name: m[2]! });
    }
  }
  return { video, audio };
}

/** Parse `ffmpeg -list_devices true -f dshow -i dummy` stderr into audio device names. */
export function parseDshowAudioDevices(stderr: string): string[] {
  const out: string[] = [];
  for (const line of stderr.split(/\r?\n/)) {
    const m = /"([^"]+)"\s*\((?:audio|audio, video|video, audio)\)/i.exec(line);
    if (m) out.push(m[1]!);
  }
  return out;
}

/**
 * Prefer an actual microphone by name. NOT /micro/i: that matches "Microsoft Teams Audio"
 * and "Microsoft Sound Mapper" (virtual devices) before the real mic.
 */
export function pickMic<T>(devices: readonly T[], nameOf: (d: T) => string): T | undefined {
  return (
    devices.find((d) => /microphone/i.test(nameOf(d)) && !/^microsoft/i.test(nameOf(d).trim())) ??
    devices.find((d) => /\bmic\b/i.test(nameOf(d))) ??
    devices[0]
  );
}

/** One monitor as Windows reports it, in physical pixels on the virtual desktop. */
export interface WinScreen {
  name: string;
  primary: boolean;
  bounds: CaptureRect;
}

/**
 * PowerShell that prints every monitor as JSON. It marks itself DPI-aware first so the bounds
 * are physical pixels (what gdigrab grabs) rather than 100%-scaled logical ones.
 */
export const WINDOWS_SCREENS_SCRIPT = [
  `Add-Type -Name Dpi -Namespace Neon -MemberDefinition '[DllImport("user32.dll")] public static extern bool SetProcessDPIAware();'`,
  '[void][Neon.Dpi]::SetProcessDPIAware()',
  'Add-Type -AssemblyName System.Windows.Forms',
  'ConvertTo-Json -Compress -InputObject @([System.Windows.Forms.Screen]::AllScreens | ForEach-Object { [pscustomobject]@{ name = $_.DeviceName; primary = $_.Primary; x = $_.Bounds.X; y = $_.Bounds.Y; width = $_.Bounds.Width; height = $_.Bounds.Height } })',
].join('; ');

/** `powershell.exe` argv for WINDOWS_SCREENS_SCRIPT. -EncodedCommand sidesteps Windows command-line quoting. */
export function windowsScreensCommand(): { cmd: string; args: string[] } {
  return { cmd: 'powershell.exe', args: ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(WINDOWS_SCREENS_SCRIPT, 'utf16le').toString('base64')] };
}

/** Parse the PowerShell JSON (an object for one monitor, an array for several). Primary first, then left to right. */
export function parseWindowsScreens(json: string): WinScreen[] {
  let raw: unknown;
  try {
    raw = JSON.parse(json.trim() || '[]');
  } catch {
    throw new Error(`Could not read the monitor list from PowerShell: ${json.trim().slice(0, 200)}`);
  }
  const items: unknown[] = Array.isArray(raw) ? raw : [raw];
  const screens: WinScreen[] = [];
  for (const item of items) {
    if (typeof item !== 'object' || item === null) continue;
    const r = new Map(Object.entries(item));
    const n = (k: string) => {
      const v = r.get(k);
      return typeof v === 'number' && Number.isInteger(v) ? v : null;
    };
    const [x, y, width, height] = [n('x'), n('y'), n('width'), n('height')];
    if (x === null || y === null || width === null || height === null || width <= 0 || height <= 0) continue;
    const name = r.get('name');
    screens.push({ name: typeof name === 'string' ? name.replace(/^\\\\\.\\/, '') : `Display ${screens.length + 1}`, primary: r.get('primary') === true, bounds: { x, y, width, height } });
  }
  return screens.sort((a, b) => Number(b.primary) - Number(a.primary) || a.bounds.x - b.bounds.x || a.bounds.y - b.bounds.y);
}

/** The X display to grab, or why there is none (Wayland sessions only expose XWayland clients to x11grab). */
export function linuxCaptureDisplay(env: Readonly<Record<string, string | undefined>>): string {
  if (env.XDG_SESSION_TYPE === 'wayland' || (env.WAYLAND_DISPLAY && !env.DISPLAY)) {
    throw new Error('Screen capture on Wayland is not supported. Log in with an X11 session ("Ubuntu on Xorg") to record the screen');
  }
  if (!env.DISPLAY) throw new Error('No X display (DISPLAY is not set), so there is no screen to record');
  return env.DISPLAY;
}

/** Everything resolveCaptureTarget needs to know about this machine. */
export type DeviceInventory =
  | { platform: 'darwin'; video: AvDevice[]; audio: AvDevice[] }
  | { platform: 'win32'; screens: WinScreen[]; audio: string[] }
  | { platform: 'linux'; display: string; audio: string[] };

/** avfoundation screens: "Capture screen N" → display N. */
function macScreens(video: readonly AvDevice[]): { display: number; device: number; name: string }[] {
  const out: { display: number; device: number; name: string }[] = [];
  for (const d of video) {
    const m = /^Capture screen (\d+)$/i.exec(d.name);
    if (m) out.push({ display: Number(m[1]), device: d.index, name: d.name });
  }
  return out.sort((a, b) => a.display - b.display);
}

/** The public device summary for GET /api/capture/devices. */
export function summarizeDevices(inv: DeviceInventory): CaptureDevices {
  switch (inv.platform) {
    case 'darwin':
      return {
        platform: 'darwin',
        displays: macScreens(inv.video).map((s) => ({ index: s.display, name: s.name, primary: s.display === 0, bounds: null })),
        mics: inv.audio.map((a) => a.name),
        defaultMic: pickMic(inv.audio, (a) => a.name)?.name ?? null,
        windowCapture: false,
      };
    case 'win32':
      return {
        platform: 'win32',
        displays: inv.screens.map((s, index) => ({ index, name: s.name, primary: s.primary, bounds: s.bounds })),
        mics: inv.audio,
        defaultMic: pickMic(inv.audio, (a) => a) ?? null,
        windowCapture: true,
      };
    case 'linux':
      return { platform: 'linux', displays: [{ index: 0, name: `X display ${inv.display}`, primary: true, bounds: null }], mics: inv.audio, defaultMic: inv.audio[0] ?? null, windowCapture: false };
    default: {
      const exhaustive: never = inv;
      return exhaustive;
    }
  }
}

// ---- target -----------------------------------------------------------------------------

/** What ffmpeg should open, resolved against this machine's devices. */
export type CaptureTarget =
  | { platform: 'darwin'; screenDevice: number; crop: CaptureRect | null; audioDevice: AvDevice | null }
  | { platform: 'win32'; grab: { kind: 'desktop'; area: CaptureRect | null } | { kind: 'window'; title: string }; audioDevice: string | null }
  | { platform: 'linux'; display: string; area: CaptureRect | null; audioDevice: string | null };

/** libx264/NVENC need even dimensions for 4:2:0; shave a pixel rather than fail. */
function even(rect: CaptureRect): CaptureRect {
  return { x: rect.x, y: rect.y, width: rect.width - (rect.width % 2), height: rect.height - (rect.height % 2) };
}

function chooseMic<T>(mic: CaptureMic, devices: readonly T[], nameOf: (d: T) => string): T | null {
  switch (mic.kind) {
    case 'none':
      return null;
    case 'auto': {
      const pick = pickMic(devices, nameOf);
      if (pick === undefined) throw new Error('No microphone found. Record without one (--no-mic) or connect a microphone');
      return pick;
    }
    case 'named': {
      const want = mic.name.toLowerCase();
      const pick = devices.find((d) => nameOf(d).toLowerCase() === want) ?? devices.find((d) => nameOf(d).toLowerCase().includes(want));
      if (pick === undefined) throw new Error(`Microphone "${mic.name}" not found. Available: ${devices.map(nameOf).join(', ') || 'none'}`);
      return pick;
    }
    default: {
      const exhaustive: never = mic;
      return exhaustive;
    }
  }
}

function displayList(names: string[]): string {
  return names.length ? names.map((n, i) => `${i} (${n})`).join(', ') : 'none';
}

/** Map a capture request onto this machine's devices. Throws a message a user can act on. */
export function resolveCaptureTarget(inv: DeviceInventory, source: CaptureSource, mic: CaptureMic): CaptureTarget {
  switch (inv.platform) {
    case 'darwin': {
      if (source.kind === 'window') throw new Error('Window capture is not available on macOS. Record a display, or a part of it with --region x,y,w,h');
      const screens = macScreens(inv.video);
      // ffmpeg lists screens from CoreGraphics; none at all means this process may not see or record them.
      if (screens.length === 0) throw new Error(`ffmpeg sees no screens on this Mac. ${captureFailureHint('darwin', '')}`);
      const screen = screens.find((s) => s.display === source.display);
      if (!screen) throw new Error(`Display ${source.display} not found. Available: ${displayList(screens.map((s) => s.name))}`);
      return { platform: 'darwin', screenDevice: screen.device, crop: source.kind === 'region' ? even(source.rect) : null, audioDevice: chooseMic(mic, inv.audio, (a) => a.name) };
    }
    case 'win32': {
      const audioDevice = chooseMic(mic, inv.audio, (a) => a);
      if (source.kind === 'window') return { platform: 'win32', grab: { kind: 'window', title: source.title }, audioDevice };
      const screen = inv.screens[source.display];
      if (!screen) throw new Error(`Display ${source.display} not found. Available: ${displayList(inv.screens.map((s) => s.name))}`);
      if (source.kind === 'display') {
        // One monitor: plain "desktop" is the most robust grab. Several: cut this monitor out of the virtual desktop.
        return { platform: 'win32', grab: { kind: 'desktop', area: inv.screens.length === 1 ? null : even(screen.bounds) }, audioDevice };
      }
      const r = source.rect;
      if (r.x + r.width > screen.bounds.width || r.y + r.height > screen.bounds.height) {
        throw new Error(`Region ${r.x},${r.y},${r.width},${r.height} does not fit display ${source.display} (${screen.bounds.width}×${screen.bounds.height})`);
      }
      return { platform: 'win32', grab: { kind: 'desktop', area: even({ x: screen.bounds.x + r.x, y: screen.bounds.y + r.y, width: r.width, height: r.height }) }, audioDevice };
    }
    case 'linux': {
      if (source.kind === 'window') throw new Error('Window capture is not available on Linux. Record the screen, or a part of it with --region x,y,w,h');
      if (source.display !== 0) throw new Error('On Linux the whole X screen is display 0; pick a monitor with --region x,y,w,h');
      return { platform: 'linux', display: inv.display, area: source.kind === 'region' ? even(source.rect) : null, audioDevice: chooseMic(mic, inv.audio, (a) => a) };
    }
    default: {
      const exhaustive: never = inv;
      return exhaustive;
    }
  }
}

// ---- encoders ---------------------------------------------------------------------------

export type VideoEncoder = 'h264_videotoolbox' | 'h264_nvenc' | 'h264_qsv' | 'h264_amf' | 'libx264';

/** Hardware first, software last. A compiled-in encoder still needs the GPU: probe each one. */
export function encoderCandidates(platform: CapturePlatform): VideoEncoder[] {
  switch (platform) {
    case 'darwin':
      return ['h264_videotoolbox', 'libx264'];
    case 'win32':
      return ['h264_nvenc', 'h264_qsv', 'h264_amf', 'libx264'];
    case 'linux':
      return ['libx264'];
    default: {
      const exhaustive: never = platform;
      return exhaustive;
    }
  }
}

/** Output video codec args, tuned for crisp screen text at real-time speed. */
export function encoderArgs(encoder: VideoEncoder): string[] {
  switch (encoder) {
    case 'h264_videotoolbox':
      return ['-c:v', 'h264_videotoolbox', '-realtime', '1', '-b:v', '12M', '-pix_fmt', 'yuv420p'];
    case 'h264_nvenc':
      return ['-c:v', 'h264_nvenc', '-preset', 'p4', '-rc', 'vbr', '-cq', '21', '-b:v', '0', '-pix_fmt', 'yuv420p'];
    case 'h264_qsv':
      // QSV takes NV12, not yuv420p (same 4:2:0 picture, different memory layout).
      return ['-c:v', 'h264_qsv', '-preset', 'veryfast', '-global_quality', '21', '-pix_fmt', 'nv12'];
    case 'h264_amf':
      return ['-c:v', 'h264_amf', '-quality', 'speed', '-rc', 'cqp', '-qp_i', '21', '-qp_p', '21', '-pix_fmt', 'yuv420p'];
    case 'libx264':
      return ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p'];
    default: {
      const exhaustive: never = encoder;
      return exhaustive;
    }
  }
}

/**
 * A one-frame test encode: exits 0 only when the encoder really works on this machine.
 * 720p because hardware encoders refuse tiny frames (Intel VideoToolbox fails 320×240 with -12903).
 */
export function encoderProbeArgs(encoder: VideoEncoder): string[] {
  return ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=black:s=1280x720:r=30', '-frames:v', '1', ...encoderArgs(encoder), '-f', 'null', '-'];
}

// ---- capture + remux --------------------------------------------------------------------

export interface CaptureOutput {
  fps: number;
  /** Draw the pointer (and, on macOS, click highlights). */
  cursor: boolean;
  encoder: VideoEncoder;
  /** A .mkv path: a crash still leaves a playable file. */
  output: string;
}

const AUDIO_OUT = ['-c:a', 'aac', '-b:a', '192k', '-ar', '48000'];

function cropFilter(r: CaptureRect): string {
  return `crop=${r.width}:${r.height}:${r.x}:${r.y}`;
}

/** The full ffmpeg argv (without the binary) that records `target` into `out.output`. */
export function buildCaptureArgs(target: CaptureTarget, out: CaptureOutput): string[] {
  const fps = String(out.fps);
  const cursor = out.cursor ? '1' : '0';
  const head = ['-hide_banner', '-y'];
  const tail = [...encoderArgs(out.encoder), out.output];
  switch (target.platform) {
    case 'darwin': {
      const audio = target.audioDevice ? String(target.audioDevice.index) : 'none';
      return [
        ...head,
        ...['-f', 'avfoundation', '-capture_cursor', cursor, '-capture_mouse_clicks', cursor, '-framerate', fps, '-i', `${target.screenDevice}:${audio}`],
        ...(target.crop ? ['-vf', cropFilter(target.crop)] : []),
        ...['-map', '0:v'],
        ...(target.audioDevice ? ['-map', '0:a', ...AUDIO_OUT] : []),
        ...tail,
      ];
    }
    case 'win32': {
      const grab = target.grab;
      const area = grab.kind === 'desktop' && grab.area ? ['-offset_x', String(grab.area.x), '-offset_y', String(grab.area.y), '-video_size', `${grab.area.width}x${grab.area.height}`] : [];
      const input = grab.kind === 'window' ? `title=${grab.title}` : 'desktop';
      return [
        ...head,
        ...['-f', 'gdigrab', '-thread_queue_size', '1024', '-draw_mouse', cursor, '-framerate', fps, ...area, '-i', input],
        // dshow buffers 500 ms of audio by default, which shows up as audio lagging the picture.
        ...(target.audioDevice ? ['-f', 'dshow', '-thread_queue_size', '1024', '-audio_buffer_size', '50', '-i', `audio=${target.audioDevice}`] : []),
        // A window can have an odd size; 4:2:0 encoders need even dimensions.
        ...(grab.kind === 'window' ? ['-vf', 'crop=trunc(iw/2)*2:trunc(ih/2)*2'] : []),
        ...['-map', '0:v'],
        ...(target.audioDevice ? ['-map', '1:a', ...AUDIO_OUT] : []),
        ...tail,
      ];
    }
    case 'linux': {
      const area = target.area ? ['-video_size', `${target.area.width}x${target.area.height}`] : [];
      const input = target.area ? `${target.display}+${target.area.x},${target.area.y}` : target.display;
      return [
        ...head,
        ...['-f', 'x11grab', '-thread_queue_size', '1024', '-draw_mouse', cursor, '-framerate', fps, ...area, '-i', input],
        ...(target.audioDevice ? ['-f', 'pulse', '-thread_queue_size', '1024', '-i', target.audioDevice] : []),
        ...['-map', '0:v'],
        ...(target.audioDevice ? ['-map', '1:a', ...AUDIO_OUT] : []),
        ...tail,
      ];
    }
    default: {
      const exhaustive: never = target;
      return exhaustive;
    }
  }
}

/** Repackage the crash-safe .mkv as a streamable .mp4 without re-encoding. */
export function buildRemuxArgs(input: string, output: string): string[] {
  return ['-hide_banner', '-y', '-i', input, '-map', '0', '-c', 'copy', '-movflags', '+faststart', output];
}

/** Why ffmpeg could not capture, with the OS setting that usually fixes it. */
export function captureFailureHint(platform: CapturePlatform, stderr: string): string {
  switch (platform) {
    case 'darwin':
      return 'macOS needs Screen Recording permission: System Settings → Privacy & Security → Screen Recording, turn on Neon Video Studio (or the terminal that runs `neon-cli serve`), then quit and reopen it. The app must also run in the logged-in desktop session, not over SSH. Recording a microphone also needs Privacy & Security → Microphone';
    case 'win32':
      if (/could not find window/i.test(stderr)) return 'No window has that exact title. Copy the title from the window\'s title bar, or record the display instead';
      return 'For the microphone, turn on Settings → Privacy & security → Microphone → "Let desktop apps access your microphone". Protected (DRM) windows record as black';
    case 'linux':
      return 'Screen capture needs an X11 session (Wayland is not supported) and a working PulseAudio/PipeWire source for the microphone';
    default: {
      const exhaustive: never = platform;
      return exhaustive;
    }
  }
}
