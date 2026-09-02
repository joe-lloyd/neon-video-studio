/**
 * Persistent edit history — survives closing the project and rebooting the machine.
 *
 * The renderer's Y.UndoManager gives fine-grained, per-peer undo while the app runs, but its
 * stack cannot be serialised. So alongside it we keep a ring of whole-project snapshots in
 * `<project>.neon/history/`, one file per checkpoint plus an index with the cursor:
 *
 *   history/index.json   { version, cursor, entries: [{ id, at }] }
 *   history/<id>.json    materialised Project (validated with ProjectSchema on restore)
 *
 * The renderer drives it: `push()` after each local edit burst, `move()` when it undoes/redoes
 * in-memory (so the cursor stays aligned), and `restore()` for the cold-start case where the
 * in-memory stack is empty. Restores are applied as minimal diffs under ORIGIN_SYSTEM, so they
 * are never captured by the live undo manager.
 */
import { cp, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ProjectSchema, newId, stableStringify, type HistoryStatus, type Project } from '@neon/core';
import type { ProjectStore } from './project-store.ts';

export type { HistoryStatus };

export const HISTORY_MAX_ENTRIES = 30;
const INDEX_VERSION = 1;

interface HistoryIndex {
  version: number;
  cursor: number;
  entries: { id: string; at: string }[];
}

export class HistoryStore {
  private readonly store: ProjectStore;
  private index: HistoryIndex = { version: INDEX_VERSION, cursor: -1, entries: [] };
  private queue: Promise<unknown> = Promise.resolve();
  private dir: string;

  constructor(store: ProjectStore) {
    this.store = store;
    this.dir = join(store.dir, 'history');
  }

  status(): HistoryStatus {
    return { count: this.index.entries.length, cursor: this.index.cursor };
  }

  /** (Re)load the index for the store's current directory; seeds a baseline checkpoint if none exists. */
  load(): Promise<HistoryStatus> {
    return this.enqueue(async () => {
      this.dir = join(this.store.dir, 'history');
      this.index = { version: INDEX_VERSION, cursor: -1, entries: [] };
      try {
        const raw = JSON.parse(await readFile(join(this.dir, 'index.json'), 'utf8')) as HistoryIndex;
        if (raw.version === INDEX_VERSION && Array.isArray(raw.entries)) {
          const files = new Set(await readdir(this.dir).catch(() => [] as string[]));
          const entries = raw.entries.filter((e) => files.has(`${e.id}.json`));
          this.index = { version: INDEX_VERSION, entries, cursor: Math.min(entries.length - 1, Math.max(-1, raw.cursor)) };
        }
      } catch {
        /* no history yet */
      }
      if (this.index.entries.length === 0 && this.store.doc.isInitialized) await this.append(this.store.toJSON());
      return this.status();
    });
  }

  /** Record the current document as a new checkpoint after the cursor (dropping any redo tail). */
  push(): Promise<HistoryStatus> {
    return this.enqueue(async () => {
      if (!this.store.doc.isInitialized) return this.status();
      const project = this.store.toJSON();
      const current = await this.readEntry(this.index.cursor);
      if (current && sameState(current, project)) return this.status();
      await this.append(project);
      return this.status();
    });
  }

  /** The renderer undid/redid in memory — keep the cursor aligned without touching the document. */
  move(delta: number): Promise<HistoryStatus> {
    return this.enqueue(async () => {
      const max = this.index.entries.length - 1;
      this.index.cursor = Math.min(max, Math.max(this.index.entries.length ? 0 : -1, this.index.cursor + delta));
      await this.writeIndex();
      return this.status();
    });
  }

  /** Apply checkpoint `target` to the live document. */
  restore(target: number): Promise<HistoryStatus> {
    return this.enqueue(async () => {
      if (target < 0 || target >= this.index.entries.length || target === this.index.cursor) return this.status();
      const snapshot = await this.readEntry(target);
      if (!snapshot) return this.status();
      // Edits that never became a checkpoint (CLI/agent, or a crash before push) would be lost on
      // redo — fold the live state into the cursor entry first so stepping forward returns here.
      const live = this.store.toJSON();
      const atCursor = await this.readEntry(this.index.cursor);
      if (this.index.cursor >= 0 && atCursor && !sameState(atCursor, live)) await this.writeEntry(this.index.entries[this.index.cursor]!.id, live);
      this.store.doc.applySnapshot(snapshot);
      this.index.cursor = target;
      await this.writeIndex();
      return this.status();
    });
  }

  /** Copy history alongside a project that is being saved to a new directory. */
  static async copy(fromDir: string, toDir: string): Promise<void> {
    await cp(join(fromDir, 'history'), join(toDir, 'history'), { recursive: true, force: true }).catch(() => undefined);
  }

  // ---- internals -----------------------------------------------------------------------

  private async append(project: Project): Promise<void> {
    const keep = this.index.entries.slice(0, this.index.cursor + 1);
    const dropped = this.index.entries.slice(this.index.cursor + 1);
    const entry = { id: newId('h'), at: new Date().toISOString() };
    keep.push(entry);
    while (keep.length > HISTORY_MAX_ENTRIES) dropped.push(keep.shift()!);
    await mkdir(this.dir, { recursive: true });
    await this.writeEntry(entry.id, project);
    this.index = { version: INDEX_VERSION, cursor: keep.length - 1, entries: keep };
    await this.writeIndex();
    for (const d of dropped) await rm(join(this.dir, `${d.id}.json`), { force: true }).catch(() => undefined);
  }

  private async readEntry(index: number): Promise<Project | null> {
    const entry = this.index.entries[index];
    if (!entry) return null;
    try {
      const parsed = ProjectSchema.safeParse(JSON.parse(await readFile(join(this.dir, `${entry.id}.json`), 'utf8')));
      return parsed.success ? parsed.data : null;
    } catch {
      return null;
    }
  }

  private async writeEntry(id: string, project: Project): Promise<void> {
    await writeAtomic(join(this.dir, `${id}.json`), JSON.stringify(project));
  }

  private async writeIndex(): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    await writeAtomic(join(this.dir, 'index.json'), JSON.stringify(this.index));
  }

  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch((err) => console.error('[history]', (err as Error).message));
    return run;
  }
}

/** Equality that ignores the bookkeeping timestamp every mutation bumps. */
function sameState(a: Project, b: Project): boolean {
  const strip = (p: Project) => ({ ...p, meta: { ...p.meta, updatedAt: '' } });
  return stableStringify(strip(a)) === stableStringify(strip(b));
}

async function writeAtomic(path: string, data: string): Promise<void> {
  const tmp = `${path}.${newId().slice(0, 6)}.tmp`;
  await writeFile(tmp, data);
  await rename(tmp, path);
}
