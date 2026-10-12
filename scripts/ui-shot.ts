#!/usr/bin/env node
/**
 * Screenshot the renderer UI on a machine without a desktop session (or for an agent): runs the
 * same headless Chrome the renderer uses (@neon/motion/node), opens a URL, runs optional steps, saves PNGs.
 * Talks the DevTools protocol over Node's built-in WebSocket — no dependencies. A fake microphone
 * is granted, so voice-over recording (and the prompter it shows) can be shot too.
 *
 *   node scripts/ui-shot.ts <url> <out.png> [--size 1480x900] [--wait 4000]
 *        [--step "js expression"]... [--shot-after-each]
 *
 * Steps run in order with the wait in between; with --shot-after-each every step also saves
 * out-1.png, out-2.png, … Start the renderer with `pnpm dev:renderer` and point it at a headless
 * app: http://localhost:5173/?port=<port>&token=<token> (both in $NEON_HOME/instance.json).
 */
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { findDownloadedShell, resolveBrowserExecutable } from '../packages/motion/src/node/browser.ts';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { size: { type: 'string', default: '1480x900' }, wait: { type: 'string', default: '4000' }, step: { type: 'string', multiple: true, default: [] }, 'shot-after-each': { type: 'boolean', default: false } },
});
const [url, out] = positionals;
if (!url || !out) {
  process.stderr.write('usage: node scripts/ui-shot.ts <url> <out.png> [--size WxH] [--wait ms] [--step js]... [--shot-after-each]\n');
  process.exit(2);
}
const [width, height] = values.size.split('x').map(Number);
const wait = Number(values.wait);

/** $NEON_CHROME, else the renderer's own choice: a downloaded Chrome Headless Shell, an installed Chrome, or a fresh download. */
async function findChrome(): Promise<string> {
  if (process.env.NEON_CHROME) return process.env.NEON_CHROME;
  return (await findDownloadedShell()) ?? (await resolveBrowserExecutable());
}

const chrome = spawn(await findChrome(), ['--headless', '--remote-debugging-port=0', `--window-size=${width},${height}`, '--hide-scrollbars', '--autoplay-policy=no-user-gesture-required', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
const wsUrl = await new Promise<string>((resolve, reject) => {
  let buf = '';
  chrome.stderr.on('data', (d: Buffer) => {
    buf += d.toString();
    const m = /DevTools listening on (ws:\/\/\S+)/.exec(buf);
    if (m) resolve(m[1]!);
  });
  chrome.on('exit', (code) => reject(new Error(`chrome exited (${code}): ${buf}`)));
});
const browser = new WebSocket(wsUrl);
await new Promise((r) => browser.addEventListener('open', r, { once: true }));
let nextId = 1;
const pending = new Map<number, (v: { result?: Record<string, unknown>; error?: { message: string } }) => void>();
browser.addEventListener('message', (ev) => {
  const msg = JSON.parse(String(ev.data)) as { id?: number; result?: Record<string, unknown>; error?: { message: string } };
  if (msg.id !== undefined) pending.get(msg.id)?.(msg);
});
async function send(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<Record<string, unknown>> {
  const id = nextId++;
  browser.send(JSON.stringify({ id, method, params, sessionId }));
  const res = await new Promise<{ result?: Record<string, unknown>; error?: { message: string } }>((r) => pending.set(id, r));
  if (res.error) throw new Error(`${method}: ${res.error.message}`);
  return res.result ?? {};
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

try {
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  const s = String(sessionId);
  await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false }, s);
  await send('Page.navigate', { url }, s);
  await sleep(wait);
  const shoot = async (file: string) => {
    const { data } = await send('Page.captureScreenshot', { format: 'png' }, s);
    writeFileSync(file, Buffer.from(String(data), 'base64'));
    process.stdout.write(`${file}\n`);
  };
  for (const [i, step] of values.step.entries()) {
    const r = await send('Runtime.evaluate', { expression: step, awaitPromise: true, returnByValue: true }, s);
    const detail = r.exceptionDetails as { text?: string; exception?: { description?: string } } | undefined;
    if (detail) throw new Error(`step ${i + 1} threw: ${detail.exception?.description ?? detail.text}`);
    process.stdout.write(`step ${i + 1}: ${JSON.stringify((r.result as { value?: unknown }).value ?? null)}\n`);
    await sleep(wait);
    if (values['shot-after-each']) await shoot(out.replace(/\.png$/, `-${i + 1}.png`));
  }
  await shoot(out);
} finally {
  browser.close();
  chrome.kill();
}
