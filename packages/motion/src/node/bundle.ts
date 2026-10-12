/**
 * Bundle a composition entry for the render page with esbuild: one ESM file for the browser plus
 * an index.html the renderer navigates to. Bundles are cached by a caller-provided key.
 */
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { createRequire } from 'node:module';
import type { BuildOptions, Loader } from 'esbuild';

export type BundleEntry =
  | { file: string }
  /** Source text; bare and relative imports resolve from `resolveDir`. */
  | { source: string; resolveDir: string; sourcefile?: string };

export interface BundleOptions {
  entry: BundleEntry;
  /** Directory that receives one sub-directory per bundle (named by `cacheKey`). */
  outDir: string;
  /** Reuse an existing bundle with this key; omit to always rebuild into `outDir/<random>`. */
  cacheKey?: string;
  /** Extra node_modules directories for bare imports (packs living outside the workspace). */
  nodePaths?: string[];
  /** Package aliases; `remotion` → `@neon/motion` is always included. */
  alias?: Record<string, string>;
  minify?: boolean;
  title?: string;
}

export interface BundleResult {
  /** Directory containing index.html. */
  dir: string;
  cached: boolean;
}

const ASSET_LOADERS: Record<string, Loader> = {
  '.css': 'css',
  '.woff': 'file',
  '.woff2': 'file',
  '.ttf': 'file',
  '.otf': 'file',
  '.eot': 'file',
  '.png': 'file',
  '.jpg': 'file',
  '.jpeg': 'file',
  '.gif': 'file',
  '.webp': 'file',
  '.avif': 'file',
  '.svg': 'file',
  '.mp4': 'file',
  '.webm': 'file',
  '.mov': 'file',
  '.mp3': 'file',
  '.wav': 'file',
  '.m4a': 'file',
  '.aac': 'file',
  '.ogg': 'file',
  '.json': 'json',
  '.txt': 'text',
};

export const DEFAULT_ALIAS: Record<string, string> = { remotion: '@neon/motion' };

/** Version of this package (part of bundle cache keys: an engine update must invalidate bundles). */
export function motionVersion(): string {
  try {
    const require = createRequire(import.meta.url);
    return (require('../../package.json') as { version: string }).version;
  } catch {
    return 'unknown';
  }
}

/** Short hash over every file's path, size and mtime in `dirs` plus `extra`. */
export async function fingerprint(dirs: string[], extra = ''): Promise<string> {
  const hash = createHash('sha256');
  hash.update(extra);
  for (const dir of dirs) {
    hash.update(`\n#${dir}\n`);
    if (!existsSync(dir)) continue;
    const entries = await readdir(dir, { recursive: true, withFileTypes: true });
    const files = entries
      .filter((e) => e.isFile() && !e.name.endsWith('.test.ts') && !e.name.endsWith('.test.tsx'))
      .map((e) => join(e.parentPath, e.name))
      .filter((f) => !f.split(/[\\/]/).includes('node_modules'))
      .sort();
    for (const file of files) {
      const s = await stat(file);
      hash.update(`${relative(dir, file)}:${s.size}:${Math.floor(s.mtimeMs)}\n`);
    }
  }
  return hash.digest('hex').slice(0, 16);
}

/** node_modules directories from `dir` upwards. */
export function nodeModulesAbove(dir: string): string[] {
  const out: string[] = [];
  let current = dir;
  for (let i = 0; i < 16; i++) {
    const candidate = join(current, 'node_modules');
    if (existsSync(candidate)) out.push(candidate);
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return out;
}

function htmlPage(title: string, css: string | null): string {
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title.replace(/[<&]/g, '')}</title>
<style>html, body { margin: 0; padding: 0; background: transparent; overflow: hidden; }</style>
${css ? `<link rel="stylesheet" href="./${css}">\n` : ''}</head>
<body>
<div id="root"></div>
<script type="module" src="./index.js"></script>
</body>
</html>
`;
}

function entryOptions(entry: BundleEntry): Pick<BuildOptions, 'entryPoints' | 'stdin'> {
  if ('file' in entry) return { entryPoints: [entry.file] };
  return { stdin: { contents: entry.source, resolveDir: entry.resolveDir, sourcefile: entry.sourcefile ?? 'neon-entry.tsx', loader: 'tsx' } };
}

async function esbuild(): Promise<typeof import('esbuild')> {
  try {
    return await import('esbuild');
  } catch (err) {
    throw new Error(`esbuild is not available (${err instanceof Error ? err.message : String(err)}); reinstall with pnpm install --ignore-scripts`);
  }
}

/** Bundle the render page (browser ESM + index.html). */
export async function bundleComposition(opts: BundleOptions): Promise<BundleResult> {
  const key = opts.cacheKey ?? `tmp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const dir = join(opts.outDir, key);
  if (opts.cacheKey && existsSync(join(dir, 'index.html'))) return { dir, cached: true };

  await mkdir(opts.outDir, { recursive: true });
  const staging = join(opts.outDir, `.staging-${key}-${process.pid}-${Date.now().toString(36)}`);
  const { build } = await esbuild();
  try {
    const result = await build({
      ...entryOptions(opts.entry),
      outfile: join(staging, 'index.js'),
      bundle: true,
      format: 'esm',
      platform: 'browser',
      target: 'chrome120',
      jsx: 'automatic',
      loader: ASSET_LOADERS,
      assetNames: 'assets/[name]-[hash]',
      define: { 'process.env.NODE_ENV': '"production"', global: 'globalThis' },
      alias: { ...DEFAULT_ALIAS, ...opts.alias },
      nodePaths: opts.nodePaths ?? [],
      minify: opts.minify ?? true,
      sourcemap: 'linked',
      legalComments: 'none',
      logLevel: 'silent',
      metafile: true,
      write: true,
    });
    const outputs = Object.keys(result.metafile.outputs).map((p) => relative(staging, p));
    const css = outputs.find((p) => p.endsWith('.css') && !p.startsWith('assets')) ?? null;
    await writeFile(join(staging, 'index.html'), htmlPage(opts.title ?? 'Neon render', css));
    if (existsSync(dir)) {
      // A concurrent build with the same key finished first; keep that one.
      if (existsSync(join(dir, 'index.html'))) return { dir, cached: true };
      await rm(dir, { recursive: true, force: true });
    }
    await rename(staging, dir);
    return { dir, cached: false };
  } catch (err) {
    throw formatBuildError(err);
  } finally {
    await rm(staging, { recursive: true, force: true }).catch(() => undefined);
  }
}

export interface NodeBundleOptions {
  entry: BundleEntry;
  /** Output .mjs file. */
  outFile: string;
  nodePaths?: string[];
  alias?: Record<string, string>;
}

/**
 * Bundle a module for Node itself (e.g. to evaluate a composition's metadata function, which may
 * live in .tsx files Node cannot load). Styles and media imports are stubbed out.
 */
export async function bundleNodeModule(opts: NodeBundleOptions): Promise<string> {
  const { build } = await esbuild();
  await mkdir(dirname(opts.outFile), { recursive: true });
  const loader: Record<string, Loader> = {};
  for (const [ext, l] of Object.entries(ASSET_LOADERS)) loader[ext] = l === 'file' || l === 'css' ? 'empty' : l;
  try {
    await build({
      ...entryOptions(opts.entry),
      outfile: opts.outFile,
      bundle: true,
      format: 'esm',
      platform: 'node',
      target: 'node22',
      jsx: 'automatic',
      loader,
      define: { 'process.env.NODE_ENV': '"production"' },
      alias: { ...DEFAULT_ALIAS, ...opts.alias },
      nodePaths: opts.nodePaths ?? [],
      logLevel: 'silent',
      write: true,
    });
  } catch (err) {
    throw formatBuildError(err);
  }
  return opts.outFile;
}

function formatBuildError(err: unknown): Error {
  const errors = (err as { errors?: { text: string; location?: { file: string; line: number; column: number } | null }[] }).errors;
  if (Array.isArray(errors) && errors.length) {
    const lines = errors.slice(0, 8).map((e) => (e.location ? `${e.location.file}:${e.location.line}:${e.location.column}: ${e.text}` : e.text));
    return new Error(`Bundling failed:\n${lines.join('\n')}${errors.length > 8 ? `\n… and ${errors.length - 8} more` : ''}`);
  }
  return err instanceof Error ? err : new Error(String(err));
}
