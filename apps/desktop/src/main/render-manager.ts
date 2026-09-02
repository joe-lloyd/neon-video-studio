/** Sequential render queue driving @neon/render's Node worker. */
import { join, resolve } from 'node:path';
import { newId, getPreset, projectPreset, type Project, type RenderJob, type RenderPreset } from '@neon/core';
import { runRenderWorker, type RunningRender } from '@neon/render';
import { paths } from './paths.ts';
import type { RenderRuntime } from './render-runtime.ts';

export interface RenderManagerDeps {
  getProject(): Project;
  projectDir(): string;
  assetBaseUrl(): string;
  /** Resolve (or download on first use) the render runtime; log lines land in the job log. */
  renderRuntime(onLog: (line: string) => void): Promise<RenderRuntime>;
  /** Installed FX packs a project needs (enabled in project.meta.packs and compiled fine). */
  packsFor(project: Project): { name: string; dir: string; entry: string }[];
  onUpdate(job: RenderJob): void;
}

export interface StartRenderOptions {
  outputPath?: string;
  presetId?: string;
  frameRange?: [number, number] | null;
}

const MAX_LOG = 40;

export class RenderManager {
  private readonly jobs = new Map<string, RenderJob>();
  private readonly running = new Map<string, RunningRender>();
  private queue: { job: RenderJob; opts: Required<Pick<StartRenderOptions, 'frameRange'>> & { preset: RenderPreset; project: Project } }[] = [];
  private active = false;

  private readonly deps: RenderManagerDeps;

  constructor(deps: RenderManagerDeps) {
    this.deps = deps;
  }

  list(): RenderJob[] {
    return [...this.jobs.values()].sort((a, b) => b.startedAt.localeCompare(a.startedAt)).slice(0, 20);
  }

  get(id: string): RenderJob | undefined {
    return this.jobs.get(id);
  }

  start(opts: StartRenderOptions): RenderJob {
    const project = this.deps.getProject();
    const preset = !opts.presetId || opts.presetId === 'project' ? projectPreset(project.meta) : getPreset(opts.presetId);
    if (project.clips.length === 0) throw new Error('Timeline is empty — nothing to render');
    const defaultName = `${project.meta.name.replace(/[^a-zA-Z0-9-_]+/g, '-')}-${preset.id}-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.mp4`;
    const outputPath = opts.outputPath
      ? resolve(this.deps.projectDir(), opts.outputPath)
      : join(paths.renders(), defaultName);
    const job: RenderJob = {
      id: newId('render'),
      status: 'queued',
      progress: 0,
      renderedFrames: 0,
      totalFrames: 0,
      outputPath,
      presetId: preset.id,
      startedAt: new Date().toISOString(),
      log: [],
    };
    this.jobs.set(job.id, job);
    this.queue.push({ job, opts: { frameRange: opts.frameRange ?? null, preset, project } });
    this.deps.onUpdate(job);
    void this.pump();
    return job;
  }

  cancel(id: string): RenderJob | undefined {
    const job = this.jobs.get(id);
    if (!job) return undefined;
    const running = this.running.get(id);
    if (running) running.cancel();
    else if (job.status === 'queued') {
      this.queue = this.queue.filter((q) => q.job.id !== id);
      this.update(job, { status: 'cancelled', finishedAt: new Date().toISOString() });
    }
    return job;
  }

  cancelAll(): void {
    for (const id of [...this.running.keys()]) this.cancel(id);
    for (const q of this.queue) this.update(q.job, { status: 'cancelled' });
    this.queue = [];
  }

  private update(job: RenderJob, patch: Partial<RenderJob>): void {
    Object.assign(job, patch);
    this.deps.onUpdate({ ...job, log: [...job.log] });
  }

  private async pump(): Promise<void> {
    if (this.active) return;
    const next = this.queue.shift();
    if (!next) return;
    this.active = true;
    const { job, opts } = next;
    try {
      this.update(job, { status: 'bundling' });
      const runtime = await this.deps.renderRuntime((line) => {
        job.log.push(line);
        this.update(job, {});
      });
      const rp = runtime.paths;
      const packs = this.deps.packsFor(opts.project);
      if (packs.length) job.log.push(`FX packs: ${packs.map((p) => p.name).join(', ')}`);
      const run = runRenderWorker(
        {
          project: opts.project,
          outputPath: job.outputPath,
          preset: opts.preset,
          assetBaseUrl: this.deps.assetBaseUrl(),
          frameRange: opts.frameRange,
          bundleCacheDir: paths.bundleCache(),
          entryPoint: rp.entryPoint,
          watchDirs: [...rp.watchDirs, ...packs.map((p) => p.dir)],
          packs: packs.map((p) => ({ name: p.name, entry: p.entry })),
          licenseKey: process.env.REMOTION_LICENSE_KEY,
        },
        {
          workerPath: rp.workerPath,
          cwd: runtime.cwd,
          // Run the worker on the Bun runtime that ships inside the app bundle (verified with
          // Electrobun 2.0.1 / Bun 1.4.0 + Remotion 4.0.515) so packaged builds do not need Node.
          // NEON_RENDER_RUNTIME=node forces Node (useful when debugging Remotion issues).
          nodeBinary: process.env.NEON_RENDER_RUNTIME === 'node' ? 'node' : process.execPath,
          onEvent: (event) => {
            switch (event.type) {
              case 'stage':
                this.update(job, { status: event.stage === 'bundling' ? 'bundling' : 'rendering' });
                break;
              case 'bundle':
                job.log.push(`bundle ${event.cached ? 'cache hit' : 'built'}: ${event.location}`);
                break;
              case 'start':
                this.update(job, { status: 'rendering', totalFrames: event.totalFrames });
                break;
              case 'progress':
                this.update(job, { progress: event.progress, renderedFrames: event.renderedFrames });
                break;
              default:
                break;
            }
          },
          onLog: (line) => {
            job.log.push(line);
            if (job.log.length > MAX_LOG) job.log.splice(0, job.log.length - MAX_LOG);
          },
        },
      );
      this.running.set(job.id, run);
      const result = await run.promise;
      this.update(job, { status: 'done', progress: 1, finishedAt: new Date().toISOString(), outputPath: result.outputPath });
    } catch (err) {
      const message = (err as Error).message;
      this.update(job, {
        status: message === 'Render cancelled' ? 'cancelled' : 'failed',
        error: message,
        finishedAt: new Date().toISOString(),
      });
    } finally {
      this.running.delete(job.id);
      this.active = false;
      void this.pump();
    }
  }
}
