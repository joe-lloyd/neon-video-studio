/**
 * Tiny static server for content-addressed assets (used by headless CLI renders and tests).
 * Files are stored as <dir>/<sha256>.<ext>; requests are GET /assets/<sha256>. Supports Range.
 */
import { createServer, type Server } from 'node:http';
import { createReadStream } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { mediaTypeForFile } from '@neon/core/node';

export async function findAssetFile(dir: string, hash: string): Promise<string | null> {
  if (!/^[a-f0-9]{64}$/.test(hash)) return null;
  const entries = await readdir(dir).catch(() => [] as string[]);
  const match = entries.find((f) => f.startsWith(`${hash}.`) || f === hash);
  return match ? join(dir, match) : null;
}

export function parseRange(header: string | undefined, size: number): { start: number; end: number } | null {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m) return null;
  const startStr = m[1] ?? '';
  const endStr = m[2] ?? '';
  if (startStr === '' && endStr === '') return null;
  let start = startStr === '' ? Math.max(0, size - Number(endStr)) : Number(startStr);
  let end = endStr === '' || startStr === '' ? size - 1 : Math.min(Number(endStr), size - 1);
  if (Number.isNaN(start) || Number.isNaN(end) || start > end || start >= size) return { start: -1, end: -1 };
  return { start, end };
}

export async function startAssetServer(dir: string, port = 0): Promise<{ server: Server; baseUrl: string; close(): Promise<void> }> {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const match = /^\/assets\/([a-f0-9]{64})$/.exec(url.pathname);
    if (!match || (req.method !== 'GET' && req.method !== 'HEAD')) {
      res.writeHead(404).end();
      return;
    }
    const file = await findAssetFile(dir, match[1]!);
    if (!file) {
      res.writeHead(404).end();
      return;
    }
    const s = await stat(file);
    const mime = mediaTypeForFile(file)?.mime ?? 'application/octet-stream';
    const range = parseRange(req.headers.range, s.size);
    const headers: Record<string, string> = {
      'Content-Type': mime,
      'Accept-Ranges': 'bytes',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'public, max-age=31536000, immutable',
    };
    if (range && range.start === -1) {
      res.writeHead(416, { 'Content-Range': `bytes */${s.size}` }).end();
      return;
    }
    if (range) {
      headers['Content-Range'] = `bytes ${range.start}-${range.end}/${s.size}`;
      headers['Content-Length'] = String(range.end - range.start + 1);
      res.writeHead(206, headers);
      if (req.method === 'HEAD') return res.end();
      createReadStream(file, { start: range.start, end: range.end }).pipe(res);
      return;
    }
    headers['Content-Length'] = String(s.size);
    res.writeHead(200, headers);
    if (req.method === 'HEAD') return res.end();
    createReadStream(file).pipe(res);
  });
  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
  const address = server.address();
  const actualPort = typeof address === 'object' && address ? address.port : port;
  return {
    server,
    baseUrl: `http://127.0.0.1:${actualPort}/assets`,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
