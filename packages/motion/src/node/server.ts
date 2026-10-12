/**
 * One HTTP server per render: the bundle directory as static files, and the frame server at
 * `/frame` on the same origin (so the page never needs CORS for video stills).
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import { FrameServer, type FrameServerOptions } from './frames.ts';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.ogg': 'audio/ogg',
};

export function mimeType(file: string): string {
  return MIME[extname(file).toLowerCase()] ?? 'application/octet-stream';
}

export interface RenderServer {
  /** http://127.0.0.1:<port> */
  url: string;
  frames: FrameServer;
  server: Server;
  close(): Promise<void>;
}

export interface RenderServerOptions {
  /** Directory with index.html (from bundleComposition). */
  bundleDir: string;
  frames?: FrameServerOptions;
}

async function serveStatic(root: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  let pathname: string;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    res.writeHead(400).end();
    return;
  }
  if (pathname.endsWith('/')) pathname += 'index.html';
  const file = normalize(join(root, pathname));
  if (file !== root && !file.startsWith(root.endsWith(sep) ? root : root + sep)) {
    res.writeHead(403).end();
    return;
  }
  const s = await stat(file).catch(() => null);
  if (!s || !s.isFile()) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end(`Not found: ${pathname}`);
    return;
  }
  res.writeHead(200, {
    'Content-Type': mimeType(file),
    'Content-Length': String(s.size),
    'Cache-Control': 'no-cache',
    'Access-Control-Allow-Origin': '*',
  });
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  createReadStream(file).on('error', () => res.destroy()).pipe(res);
}

export async function startRenderServer(opts: RenderServerOptions): Promise<RenderServer> {
  const root = normalize(opts.bundleDir);
  const frames = new FrameServer(opts.frames);
  const server = createServer((req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405).end();
      return;
    }
    if (req.url?.startsWith('/frame?') || req.url === '/frame') {
      frames.handle(req, res);
      return;
    }
    serveStatic(root, req, res).catch((err: unknown) => {
      if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(err instanceof Error ? err.message : String(err));
    });
  });
  server.keepAliveTimeout = 60_000;
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  let closing: Promise<void> | null = null;
  return {
    url: `http://127.0.0.1:${port}`,
    frames,
    server,
    close() {
      closing ??= new Promise<void>((resolve) => {
        frames.close();
        server.closeAllConnections();
        server.close(() => resolve());
      });
      return closing;
    },
  };
}
