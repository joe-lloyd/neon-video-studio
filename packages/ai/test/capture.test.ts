import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CaptureStartRequestSchema } from '@neon/core';
import {
  buildCaptureArgs,
  buildRemuxArgs,
  encoderCandidates,
  encoderProbeArgs,
  linuxCaptureDisplay,
  parseAvfoundationDevices,
  parseDshowAudioDevices,
  parseWindowsScreens,
  resolveCaptureTarget,
  summarizeDevices,
  windowsScreensCommand,
  WINDOWS_SCREENS_SCRIPT,
  type DeviceInventory,
} from '../src/capture.ts';

const AVFOUNDATION_LIST = `[AVFoundation indev @ 0x7fb1c8704a40] AVFoundation video devices:
[AVFoundation indev @ 0x7fb1c8704a40] [0] FaceTime HD Camera
[AVFoundation indev @ 0x7fb1c8704a40] [1] Capture screen 0
[AVFoundation indev @ 0x7fb1c8704a40] [2] Capture screen 1
[AVFoundation indev @ 0x7fb1c8704a40] AVFoundation audio devices:
[AVFoundation indev @ 0x7fb1c8704a40] [0] Microsoft Teams Audio
[AVFoundation indev @ 0x7fb1c8704a40] [1] MacBook Pro Microphone
[AVFoundation indev @ 0x7fb1c8704a40] [2] ZoomAudioDevice
: Input/output error`;

const DSHOW_LIST = `[dshow @ 000001c0a3d4e5c0] "Integrated Camera" (video)
[dshow @ 000001c0a3d4e5c0]   Alternative name "@device_pnp_\\\\?\\usb#vid_04f2"
[dshow @ 000001c0a3d4e5c0] "Microsoft Sound Mapper - Input" (audio)
[dshow @ 000001c0a3d4e5c0] "Microphone (RODE NT-USB)" (audio)
[dshow @ 000001c0a3d4e5c0]   Alternative name "@device_cm_{33D9A762-90C8-11D0-BD43-00A0C911CE86}\\wave_{1}"
[dshow @ 000001c0a3d4e5c0] "Stereo Mix (Realtek(R) Audio)" (audio)
dummy: Immediate exit requested`;

const mac = (): DeviceInventory => ({ platform: 'darwin', ...parseAvfoundationDevices(AVFOUNDATION_LIST) });
const win = (screens = '[{"name":"\\\\\\\\.\\\\DISPLAY2","primary":false,"x":-2560,"y":0,"width":2560,"height":1440},{"name":"\\\\\\\\.\\\\DISPLAY1","primary":true,"x":0,"y":0,"width":3840,"height":2160}]'): DeviceInventory => ({
  platform: 'win32',
  screens: parseWindowsScreens(screens),
  audio: parseDshowAudioDevices(DSHOW_LIST),
});
const linux: DeviceInventory = { platform: 'linux', display: ':0.0', audio: ['default'] };
const out = { fps: 30, cursor: true, output: '/tmp/take.mkv' } as const;
const start = (body: unknown) => CaptureStartRequestSchema.parse(body);

test('avfoundation listing splits video and audio devices', () => {
  assert.deepEqual(parseAvfoundationDevices(AVFOUNDATION_LIST), {
    video: [
      { index: 0, name: 'FaceTime HD Camera' },
      { index: 1, name: 'Capture screen 0' },
      { index: 2, name: 'Capture screen 1' },
    ],
    audio: [
      { index: 0, name: 'Microsoft Teams Audio' },
      { index: 1, name: 'MacBook Pro Microphone' },
      { index: 2, name: 'ZoomAudioDevice' },
    ],
  });
});

test('dshow listing keeps audio devices and skips alternative names', () => {
  assert.deepEqual(parseDshowAudioDevices(DSHOW_LIST), ['Microsoft Sound Mapper - Input', 'Microphone (RODE NT-USB)', 'Stereo Mix (Realtek(R) Audio)']);
});

test('Windows monitors: primary first, device prefix stripped, single object accepted', () => {
  assert.deepEqual(parseWindowsScreens('[{"name":"\\\\\\\\.\\\\DISPLAY2","primary":false,"x":-2560,"y":0,"width":2560,"height":1440},{"name":"\\\\\\\\.\\\\DISPLAY1","primary":true,"x":0,"y":0,"width":3840,"height":2160}]'), [
    { name: 'DISPLAY1', primary: true, bounds: { x: 0, y: 0, width: 3840, height: 2160 } },
    { name: 'DISPLAY2', primary: false, bounds: { x: -2560, y: 0, width: 2560, height: 1440 } },
  ]);
  assert.deepEqual(parseWindowsScreens('{"name":"\\\\\\\\.\\\\DISPLAY1","primary":true,"x":0,"y":0,"width":1920,"height":1080}\r\n'), [
    { name: 'DISPLAY1', primary: true, bounds: { x: 0, y: 0, width: 1920, height: 1080 } },
  ]);
  assert.throws(() => parseWindowsScreens('Add-Type : Cannot add type'), /Could not read the monitor list/);
});

test('the PowerShell monitor query is passed encoded, so quotes survive the Windows command line', () => {
  const { cmd, args } = windowsScreensCommand();
  assert.equal(cmd, 'powershell.exe');
  assert.deepEqual(args.slice(0, 3), ['-NoProfile', '-NonInteractive', '-EncodedCommand']);
  assert.equal(Buffer.from(args[3]!, 'base64').toString('utf16le'), WINDOWS_SCREENS_SCRIPT);
  assert.match(WINDOWS_SCREENS_SCRIPT, /SetProcessDPIAware\(\).*AllScreens/);
});

test('device summary per platform', () => {
  assert.deepEqual(summarizeDevices(mac()), {
    platform: 'darwin',
    displays: [
      { index: 0, name: 'Capture screen 0', primary: true, bounds: null },
      { index: 1, name: 'Capture screen 1', primary: false, bounds: null },
    ],
    mics: ['Microsoft Teams Audio', 'MacBook Pro Microphone', 'ZoomAudioDevice'],
    defaultMic: 'MacBook Pro Microphone',
    windowCapture: false,
  });
  assert.deepEqual(summarizeDevices(win()).displays, [
    { index: 0, name: 'DISPLAY1', primary: true, bounds: { x: 0, y: 0, width: 3840, height: 2160 } },
    { index: 1, name: 'DISPLAY2', primary: false, bounds: { x: -2560, y: 0, width: 2560, height: 1440 } },
  ]);
  assert.equal(summarizeDevices(win()).defaultMic, 'Microphone (RODE NT-USB)');
});

test('macOS: screen and mic share one avfoundation input', () => {
  const req = start({});
  const target = resolveCaptureTarget(mac(), req.source, req.mic);
  assert.deepEqual(buildCaptureArgs(target, { ...out, encoder: 'h264_videotoolbox' }), [
    '-hide_banner', '-y',
    '-f', 'avfoundation', '-capture_cursor', '1', '-capture_mouse_clicks', '1', '-framerate', '30', '-i', '1:1',
    '-map', '0:v', '-map', '0:a', '-c:a', 'aac', '-b:a', '192k', '-ar', '48000',
    '-c:v', 'h264_videotoolbox', '-realtime', '1', '-b:v', '12M', '-pix_fmt', 'yuv420p',
    '/tmp/take.mkv',
  ]);
});

test('macOS: second display, region crop (evened), no mic, no cursor, software encoder', () => {
  const req = start({ display: 1, region: '100,50,1281,721', mic: false, cursor: false, fps: 60 });
  const target = resolveCaptureTarget(mac(), req.source, req.mic);
  assert.deepEqual(buildCaptureArgs(target, { ...out, fps: req.fps, cursor: req.cursor, encoder: 'libx264' }), [
    '-hide_banner', '-y',
    '-f', 'avfoundation', '-capture_cursor', '0', '-capture_mouse_clicks', '0', '-framerate', '60', '-i', '2:none',
    '-vf', 'crop=1280:720:100:50',
    '-map', '0:v',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p',
    '/tmp/take.mkv',
  ]);
});

test('macOS: named mic matches by substring; errors name what exists', () => {
  const req = start({ mic: 'zoom' });
  const target = resolveCaptureTarget(mac(), req.source, req.mic);
  const args = buildCaptureArgs(target, { ...out, encoder: 'libx264' });
  assert.equal(args[args.indexOf('-i') + 1], '1:2');
  assert.throws(() => resolveCaptureTarget(mac(), start({ mic: 'Shure' }).source, start({ mic: 'Shure' }).mic), /Microphone "Shure" not found\. Available: Microsoft Teams Audio, MacBook Pro Microphone, ZoomAudioDevice/);
  assert.throws(() => resolveCaptureTarget(mac(), { kind: 'display', display: 4 }, { kind: 'none' }), /Display 4 not found\. Available: 0 \(Capture screen 0\), 1 \(Capture screen 1\)/);
  assert.throws(() => resolveCaptureTarget(mac(), { kind: 'window', title: 'Code' }, { kind: 'none' }), /Window capture is not available on macOS/);
  // Real listing from a process without Screen Recording access: the camera only, no "Capture screen N".
  const blind: DeviceInventory = { platform: 'darwin', ...parseAvfoundationDevices('[AVFoundation indev @ 0x7fe635005bc0] AVFoundation video devices:\n[AVFoundation indev @ 0x7fe635005bc0] [0] FaceTime HD Camera (Built-in)\n[AVFoundation indev @ 0x7fe635005bc0] AVFoundation audio devices:\n[AVFoundation indev @ 0x7fe635005bc0] [0] MacBook Pro Microphone') };
  assert.throws(() => resolveCaptureTarget(blind, { kind: 'display', display: 0 }, { kind: 'none' }), /ffmpeg sees no screens on this Mac\. macOS needs Screen Recording permission: System Settings → Privacy & Security → Screen Recording/);
});

test('Windows: primary of two monitors is cut from the virtual desktop, dshow mic as second input', () => {
  const req = start({});
  const target = resolveCaptureTarget(win(), req.source, req.mic);
  assert.deepEqual(buildCaptureArgs(target, { ...out, output: 'C:\\Temp\\take.mkv', encoder: 'h264_nvenc' }), [
    '-hide_banner', '-y',
    '-f', 'gdigrab', '-thread_queue_size', '1024', '-draw_mouse', '1', '-framerate', '30',
    '-offset_x', '0', '-offset_y', '0', '-video_size', '3840x2160', '-i', 'desktop',
    '-f', 'dshow', '-thread_queue_size', '1024', '-audio_buffer_size', '50', '-i', 'audio=Microphone (RODE NT-USB)',
    '-map', '0:v', '-map', '1:a', '-c:a', 'aac', '-b:a', '192k', '-ar', '48000',
    '-c:v', 'h264_nvenc', '-preset', 'p4', '-rc', 'vbr', '-cq', '21', '-b:v', '0', '-pix_fmt', 'yuv420p',
    'C:\\Temp\\take.mkv',
  ]);
});

test('Windows: a single monitor grabs the plain desktop', () => {
  const single = win('{"name":"\\\\\\\\.\\\\DISPLAY1","primary":true,"x":0,"y":0,"width":1920,"height":1080}');
  const target = resolveCaptureTarget(single, { kind: 'display', display: 0 }, { kind: 'none' });
  assert.deepEqual(buildCaptureArgs(target, { ...out, encoder: 'h264_qsv' }), [
    '-hide_banner', '-y',
    '-f', 'gdigrab', '-thread_queue_size', '1024', '-draw_mouse', '1', '-framerate', '30', '-i', 'desktop',
    '-map', '0:v',
    '-c:v', 'h264_qsv', '-preset', 'veryfast', '-global_quality', '21', '-pix_fmt', 'nv12',
    '/tmp/take.mkv',
  ]);
});

test('Windows: a region on the left monitor is offset into negative virtual-desktop space', () => {
  const req = start({ display: 1, region: { x: 10, y: 20, width: 1280, height: 720 }, mic: 'stereo mix', cursor: false });
  const target = resolveCaptureTarget(win(), req.source, req.mic);
  assert.deepEqual(buildCaptureArgs(target, { ...out, cursor: req.cursor, encoder: 'h264_amf' }), [
    '-hide_banner', '-y',
    '-f', 'gdigrab', '-thread_queue_size', '1024', '-draw_mouse', '0', '-framerate', '30',
    '-offset_x', '-2550', '-offset_y', '20', '-video_size', '1280x720', '-i', 'desktop',
    '-f', 'dshow', '-thread_queue_size', '1024', '-audio_buffer_size', '50', '-i', 'audio=Stereo Mix (Realtek(R) Audio)',
    '-map', '0:v', '-map', '1:a', '-c:a', 'aac', '-b:a', '192k', '-ar', '48000',
    '-c:v', 'h264_amf', '-quality', 'speed', '-rc', 'cqp', '-qp_i', '21', '-qp_p', '21', '-pix_fmt', 'yuv420p',
    '/tmp/take.mkv',
  ]);
  assert.throws(() => resolveCaptureTarget(win(), { kind: 'region', display: 1, rect: { x: 2000, y: 0, width: 1280, height: 720 } }, { kind: 'none' }), /does not fit display 1 \(2560×1440\)/);
});

test('Windows: a window by title, cropped to even dimensions', () => {
  const req = start({ window: 'Visual Studio Code', mic: false });
  const target = resolveCaptureTarget(win(), req.source, req.mic);
  assert.deepEqual(buildCaptureArgs(target, { ...out, encoder: 'libx264' }), [
    '-hide_banner', '-y',
    '-f', 'gdigrab', '-thread_queue_size', '1024', '-draw_mouse', '1', '-framerate', '30', '-i', 'title=Visual Studio Code',
    '-vf', 'crop=trunc(iw/2)*2:trunc(ih/2)*2',
    '-map', '0:v',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p',
    '/tmp/take.mkv',
  ]);
});

test('Linux: x11grab plus pulse, region as input offset', () => {
  const req = start({ region: '0,0,1920,1080' });
  const target = resolveCaptureTarget(linux, req.source, req.mic);
  assert.deepEqual(buildCaptureArgs(target, { ...out, encoder: 'libx264' }), [
    '-hide_banner', '-y',
    '-f', 'x11grab', '-thread_queue_size', '1024', '-draw_mouse', '1', '-framerate', '30', '-video_size', '1920x1080', '-i', ':0.0+0,0',
    '-f', 'pulse', '-thread_queue_size', '1024', '-i', 'default',
    '-map', '0:v', '-map', '1:a', '-c:a', 'aac', '-b:a', '192k', '-ar', '48000',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p',
    '/tmp/take.mkv',
  ]);
  assert.throws(() => linuxCaptureDisplay({ XDG_SESSION_TYPE: 'wayland', DISPLAY: ':0', WAYLAND_DISPLAY: 'wayland-0' }), /Wayland is not supported/);
  assert.equal(linuxCaptureDisplay({ XDG_SESSION_TYPE: 'x11', DISPLAY: ':1' }), ':1');
});

test('encoders: hardware first, probed with a one-frame encode', () => {
  assert.deepEqual(encoderCandidates('win32'), ['h264_nvenc', 'h264_qsv', 'h264_amf', 'libx264']);
  assert.deepEqual(encoderCandidates('darwin'), ['h264_videotoolbox', 'libx264']);
  assert.deepEqual(encoderCandidates('linux'), ['libx264']);
  assert.deepEqual(encoderProbeArgs('h264_nvenc'), [
    '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=black:s=1280x720:r=30', '-frames:v', '1',
    '-c:v', 'h264_nvenc', '-preset', 'p4', '-rc', 'vbr', '-cq', '21', '-b:v', '0', '-pix_fmt', 'yuv420p',
    '-f', 'null', '-',
  ]);
});

test('remux copies streams into a faststart mp4', () => {
  assert.deepEqual(buildRemuxArgs('/tmp/a.mkv', '/tmp/a.mp4'), ['-hide_banner', '-y', '-i', '/tmp/a.mkv', '-map', '0', '-c', 'copy', '-movflags', '+faststart', '/tmp/a.mp4']);
});

test('start request: flags become a source and a mic choice', () => {
  assert.deepEqual(start({}), { source: { kind: 'display', display: 0 }, mic: { kind: 'auto' }, fps: 30, cursor: true });
  assert.deepEqual(start({ window: 'Chrome', mic: 'USB' }).source, { kind: 'window', title: 'Chrome' });
  assert.deepEqual(start({ mic: 'USB' }).mic, { kind: 'named', name: 'USB' });
  assert.throws(() => start({ window: 'Chrome', display: 1 }), /window cannot be combined/);
  assert.throws(() => start({ region: '1,2,3' }), /x,y,width,height/);
  assert.throws(() => start({ region: '0,0,8,8' }), /Too small: expected number to be >=16/);
});
