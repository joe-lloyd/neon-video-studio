/**
 * Installed FX packs: discovery, validation, compilation and install/uninstall.
 *
 *   ~/.neon-video/packs/<name>/        the pack folder (pack.json + index.tsx + …)
 *   ~/.neon-video/packs-build/<name>.<hash>.js   browser bundle for the renderer's previews/player
 *
 * The bundle is produced by Bun's bundler with the host modules (react, remotion, @neon/core,
 * @neon/fx-kit) redirected to `globalThis.__neonPackHost` — the renderer fills that object with its
 * own module instances before importing the bundle, so hooks and Remotion context are shared.
 * Exports use the render worker instead: it webpack-bundles the pack source straight from the
 * folder (see packages/render/src/worker.ts), so the compiled JS here is UI-only.
 */
import { createHash } from 'node:crypto';
import { cp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, normalize, resolve } from 'node:path';
import { listPacks as listRegisteredPacks, listTemplates, registerPack, unregisterPack, type PackManifest } from '@neon/core';
import { discoverInstalledPacks, neonHome, packsDir, readPackDir, type DiscoveredPack } from '@neon/core/node';
import type { PackInfo } from '../shared/rpc.ts';

/** Bare specifiers a pack may import; everything else must be a relative file inside the pack. */
export const HOST_MODULES = ['react', 'react/jsx-runtime', 'react/jsx-dev-runtime', 'react-dom', 'remotion', '@neon/core', '@neon/fx-kit'] as const;

export interface RenderPack {
  name: string;
  dir: string;
  entry: string;
}

interface LoadedPack {
  discovered: DiscoveredPack;
  status: 'ready' | 'error';
  error?: string;
  bundleFile?: string;
  bundleHash?: string;
}

export class PackManager {
  private readonly packs = new Map<string, LoadedPack>();
  private readonly examplesDir: string | null;
  private readonly onChange: (packs: PackInfo[]) => void;

  constructor(opts: { examplesDir: string | null; onChange: (packs: PackInfo[]) => void }) {
    this.examplesDir = opts.examplesDir;
    this.onChange = opts.onChange;
  }

  get buildDir(): string {
    return join(neonHome(), 'packs-build');
  }

  /** Scan the packs folder and (re)activate everything. */
  async load(): Promise<PackInfo[]> {
    const found = await discoverInstalledPacks();
    for (const name of [...this.packs.keys()]) if (!found.some((p) => p.name === name)) this.deactivate(name);
    for (const p of found) await this.activate(p);
    return this.list();
  }

  async list(): Promise<PackInfo[]> {
    const templatesOf = (pack: string) => listTemplates().filter((t) => t.pack === pack).map((t) => t.name);
    const builtin: PackInfo[] = listRegisteredPacks()
      .filter((r) => r.source === 'builtin')
      .map((r) => ({ ...summary(r.manifest), source: 'builtin', status: 'ready', manifest: r.manifest, templates: r.manifest.templates.length ? r.manifest.templates.map((t) => t.name) : templatesOf(r.manifest.name) }));
    const installed: PackInfo[] = [...this.packs.values()].map((p) => ({
      ...summary(p.discovered.manifest, p.discovered.name),
      source: 'installed',
      dir: p.discovered.dir,
      status: p.status,
      error: p.error,
      bundlePath: p.bundleFile ? `/packs/${p.discovered.name}.js?v=${p.bundleHash}` : undefined,
      manifest: p.discovered.manifest,
      templates: p.discovered.manifest?.templates.map((t) => t.name) ?? [],
    }));
    const examples: PackInfo[] = [];
    if (this.examplesDir) {
      for (const p of await discoverInstalledPacks(this.examplesDir)) {
        if (this.packs.has(p.name)) continue;
        examples.push({ ...summary(p.manifest, p.name), source: 'example', dir: p.dir, status: p.error ? 'error' : 'ready', error: p.error, manifest: p.manifest, templates: p.manifest?.templates.map((t) => t.name) ?? [] });
      }
    }
    return [...builtin, ...installed, ...examples];
  }

  /** Copy a pack folder into ~/.neon-video/packs and activate it (replacing any previous version). */
  async install(sourceDir: string): Promise<PackInfo> {
    const src = resolve(sourceDir);
    const probe = await readPackDir(src);
    if (!probe.manifest) throw new Error(probe.error ?? 'not a pack folder');
    const name = probe.manifest.name;
    const dest = join(packsDir(), name);
    if (resolve(dest) !== src) {
      await mkdir(packsDir(), { recursive: true });
      await rm(dest, { recursive: true, force: true });
      await cp(src, dest, { recursive: true, filter: (p) => !/(^|\/)(node_modules|\.git)(\/|$)/.test(p) });
    }
    const info = await this.activate(await readPackDir(dest));
    await this.broadcast();
    return info;
  }

  /** Install from in-memory files (a folder dropped onto the Library panel). Paths are relative and start with the folder name. */
  async installFiles(files: { path: string; content: string }[]): Promise<PackInfo> {
    if (files.length === 0) throw new Error('No files received');
    const root = files[0]!.path.split('/')[0]!;
    if (!root || root.startsWith('.')) throw new Error('Drop the pack folder itself (the one containing pack.json)');
    const staging = join(this.buildDir, 'staging', `${root}-${Date.now()}`);
    try {
      for (const f of files) {
        const rel = normalize(f.path);
        if (rel.startsWith('..') || rel.includes('/../') || !rel.startsWith(root)) throw new Error(`Unsafe path in dropped folder: ${f.path}`);
        if (/(^|\/)(node_modules|\.git)(\/|$)/.test(rel)) continue;
        const target = join(staging, rel);
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, f.content);
      }
      return await this.install(join(staging, root));
    } finally {
      await rm(staging, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  async uninstall(name: string): Promise<boolean> {
    const pack = this.packs.get(name);
    if (!pack) return false;
    this.deactivate(name);
    await rm(pack.discovered.dir, { recursive: true, force: true });
    await this.broadcast();
    return true;
  }

  /** Path of the compiled browser bundle for the control server. */
  bundleFile(name: string): string | null {
    return this.packs.get(name)?.bundleFile ?? null;
  }

  /** Packs the render worker must bundle for a project (enabled + ready). */
  renderPacks(enabled: readonly string[] | undefined): RenderPack[] {
    const out: RenderPack[] = [];
    for (const name of enabled ?? []) {
      const pack = this.packs.get(name);
      if (pack?.status === 'ready') out.push({ name, dir: pack.discovered.dir, entry: pack.discovered.entry });
    }
    return out;
  }

  // ---- internals -----------------------------------------------------------------------

  private async activate(discovered: DiscoveredPack): Promise<PackInfo> {
    const name = discovered.name;
    const previous = this.packs.get(name);
    const loaded: LoadedPack = { discovered, status: 'error' };
    this.packs.set(name, loaded);
    if (!discovered.manifest || discovered.error) {
      loaded.error = discovered.error ?? 'invalid pack';
      if (previous) unregisterPack(name);
      return (await this.list()).find((p) => p.name === name)!;
    }
    try {
      const built = await this.compile(discovered).catch((err: unknown) => {
        const e = err as { message?: string; errors?: { message: string }[]; logs?: { message: string }[] };
        const details = [...(e.errors ?? []), ...(e.logs ?? [])].map((m) => m.message).filter(Boolean);
        throw new Error(details.length ? `Compile failed: ${details.slice(0, 3).join('; ')}` : e.message ?? 'Compile failed');
      });
      loaded.bundleFile = built.file;
      loaded.bundleHash = built.hash;
      const { conflicts } = registerPack(discovered.manifest, 'installed', discovered.dir);
      if (conflicts.length) throw new Error(`Template name clash — ${conflicts.join(', ')}`);
      loaded.status = 'ready';
    } catch (err) {
      loaded.error = (err as Error).message;
      unregisterPack(name);
      console.warn(`[packs] ${name}: ${loaded.error}`);
    }
    return (await this.list()).find((p) => p.name === name)!;
  }

  private deactivate(name: string): void {
    unregisterPack(name);
    this.packs.delete(name);
  }

  private async broadcast(): Promise<void> {
    this.onChange(await this.list());
  }

  private async compile(pack: DiscoveredPack): Promise<{ file: string; hash: string }> {
    await mkdir(this.buildDir, { recursive: true });
    const result = await Bun.build({
      entrypoints: [pack.entry],
      target: 'browser',
      format: 'esm',
      minify: false,
      sourcemap: 'inline',
      define: { 'process.env.NODE_ENV': '"production"' },
      plugins: [
        {
          name: 'neon-pack-host',
          setup(build) {
            const host = new RegExp(`^(${HOST_MODULES.map((m) => m.replace(/[/@]/g, '\\$&')).join('|')})$`);
            build.onResolve({ filter: host }, (args) => ({ path: args.path, namespace: 'neon-host' }));
            build.onLoad({ filter: /.*/, namespace: 'neon-host' }, (args) => ({
              contents: `module.exports = globalThis.__neonPackHost && globalThis.__neonPackHost[${JSON.stringify(args.path)}];\nif (!module.exports) throw new Error("FX pack host module missing: ${args.path}");`,
              loader: 'js',
            }));
            // Any other bare specifier is a dependency we cannot provide — fail loudly at compile time.
            build.onResolve({ filter: /^[^./]/ }, (args) => {
              if (host.test(args.path) || args.path.startsWith('data:')) return undefined;
              throw new Error(`"${args.path}" is not available to FX packs (allowed: ${HOST_MODULES.join(', ')} and relative files)`);
            });
          },
        },
      ],
    });
    if (!result.success) {
      const msg = result.logs.map((l) => l.message).filter(Boolean).slice(0, 3).join('; ');
      throw new Error(`Compile failed: ${msg || 'unknown error'}`);
    }
    const artifact = result.outputs.find((o) => o.kind === 'entry-point') ?? result.outputs[0];
    if (!artifact) throw new Error('Compile produced no output');
    const code = await artifact.text();
    const hash = createHash('sha1').update(code).digest('hex').slice(0, 12);
    const file = join(this.buildDir, `${pack.name}.${hash}.js`);
    await writeFile(file, code);
    // Drop stale builds of this pack.
    for (const f of await readdir(this.buildDir).catch(() => [] as string[])) {
      if (f.startsWith(`${pack.name}.`) && f.endsWith('.js') && f !== basename(file)) await rm(join(this.buildDir, f), { force: true }).catch(() => undefined);
    }
    return { file, hash };
  }
}

function summary(manifest: PackManifest | null, fallbackName = ''): Pick<PackInfo, 'name' | 'label' | 'version' | 'description' | 'author' | 'category' | 'tags'> {
  return {
    name: manifest?.name ?? fallbackName,
    label: manifest?.label ?? fallbackName,
    version: manifest?.version ?? '',
    description: manifest?.description,
    author: manifest?.author,
    category: manifest?.category,
    tags: manifest?.tags,
  };
}
