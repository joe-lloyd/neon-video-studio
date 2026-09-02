/**
 * Owns the live ProjectDoc and its persistence.
 *
 * Project directory layout (`<name>.neon/`):
 *   project.json  – materialised JSON (human/agent readable, used by headless renders)
 *   doc.bin       – full Yjs state (CRDT history, merges cleanly across peers)
 *   assets/       – content-addressed media: <sha256>.<ext>
 */
import * as Y from 'yjs';
import { cp, mkdir, readFile, rename, rm, writeFile, access } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { ORIGIN_SYSTEM, ProjectDoc, ProjectSchema, newId, type Project, type ProjectMeta } from '@neon/core';
import { paths } from './paths.ts';
import type { Settings } from './settings.ts';

type StoreEvent = 'doc-replaced' | 'saved' | 'changed';
type Listener = (store: ProjectStore) => void;

const AUTOSAVE_MS = 1500;

export class ProjectStore {
  doc: ProjectDoc;
  dir: string;
  dirty = false;
  lastSavedAt: string | null = null;
  private readonly listeners = new Map<StoreEvent, Set<Listener>>();
  private autosaveTimer: ReturnType<typeof setTimeout> | null = null;
  private unsubscribeDoc: (() => void) | null = null;
  private saving: Promise<void> | null = null;

  private constructor(doc: ProjectDoc, dir: string) {
    this.doc = doc;
    this.dir = dir;
    this.bind();
  }

  // ---- construction --------------------------------------------------------------------

  static async openOrCreate(settings: Settings): Promise<ProjectStore> {
    if (settings.lastProjectPath) {
      try {
        await access(join(settings.lastProjectPath, 'project.json'));
        return await ProjectStore.openDir(settings.lastProjectPath);
      } catch (err) {
        console.warn(`[store] could not reopen ${settings.lastProjectPath}: ${(err as Error).message}`);
      }
    }
    return ProjectStore.create({});
  }

  static async create(meta: Partial<Pick<ProjectMeta, 'name' | 'fps' | 'width' | 'height'>>): Promise<ProjectStore> {
    const doc = new ProjectDoc();
    doc.ensureInitialized(meta);
    const dir = join(paths.scratchProjects(), `${safeName(doc.getMeta().name)}-${doc.getMeta().id.slice(-6)}.neon`);
    await mkdir(join(dir, 'assets'), { recursive: true });
    const store = new ProjectStore(doc, dir);
    await store.save();
    return store;
  }

  static async openDir(dir: string): Promise<ProjectStore> {
    const abs = resolve(dir);
    const doc = await loadDoc(abs);
    await mkdir(join(abs, 'assets'), { recursive: true });
    return new ProjectStore(doc, abs);
  }

  /** Empty, uninitialised doc that will be populated by syncing with a room host. */
  static async createForJoin(roomCode: string): Promise<ProjectStore> {
    const doc = new ProjectDoc();
    const dir = join(paths.scratchProjects(), `room-${roomCode}.neon`);
    await mkdir(join(dir, 'assets'), { recursive: true });
    return new ProjectStore(doc, dir);
  }

  // ---- swapping the live document -----------------------------------------------------

  /** Replace the live doc/dir with another store's (used by new/open/join). */
  async adopt(other: ProjectStore): Promise<void> {
    await this.flush();
    this.unbind();
    this.doc.doc.destroy();
    this.doc = other.doc;
    this.dir = other.dir;
    this.dirty = other.dirty;
    this.lastSavedAt = other.lastSavedAt;
    other.unbind();
    this.bind();
    this.emit('doc-replaced');
  }

  private bind(): void {
    this.unsubscribeDoc = this.doc.subscribe(() => {
      this.dirty = true;
      this.scheduleAutosave();
      this.emit('changed');
    });
  }

  private unbind(): void {
    this.unsubscribeDoc?.();
    this.unsubscribeDoc = null;
    if (this.autosaveTimer) clearTimeout(this.autosaveTimer);
    this.autosaveTimer = null;
  }

  // ---- persistence ---------------------------------------------------------------------

  get isScratch(): boolean {
    return this.dir.startsWith(paths.scratchProjects());
  }

  get assetsDir(): string {
    return join(this.dir, 'assets');
  }

  get projectId(): string {
    return this.doc.isInitialized ? this.doc.getMeta().id : `pending-${basename(this.dir)}`;
  }

  toJSON(): Project {
    return this.doc.toJSON();
  }

  private scheduleAutosave(): void {
    if (this.autosaveTimer) clearTimeout(this.autosaveTimer);
    this.autosaveTimer = setTimeout(() => {
      this.autosaveTimer = null;
      this.save().catch((err) => console.error('[store] autosave failed', err));
    }, AUTOSAVE_MS);
  }

  async flush(): Promise<void> {
    if (this.autosaveTimer) {
      clearTimeout(this.autosaveTimer);
      this.autosaveTimer = null;
    }
    if (this.saving) await this.saving;
    if (this.dirty) await this.save();
  }

  async save(): Promise<string> {
    if (this.saving) await this.saving;
    this.saving = (async () => {
      if (!this.doc.isInitialized) return; // joined room, nothing synced yet
      await mkdir(this.assetsDir, { recursive: true });
      const json = JSON.stringify(this.doc.toJSON(), null, 2);
      const bin = this.doc.encodeState();
      await writeAtomic(join(this.dir, 'project.json'), json);
      await writeAtomic(join(this.dir, 'doc.bin'), bin);
      this.dirty = false;
      this.lastSavedAt = new Date().toISOString();
      this.emit('saved');
    })();
    try {
      await this.saving;
    } finally {
      this.saving = null;
    }
    return this.dir;
  }

  /** Copy the project (including assets) to a new directory and continue working there. */
  async saveAs(targetDir: string): Promise<string> {
    const abs = resolve(targetDir).replace(/\/$/, '');
    const dest = abs.endsWith('.neon') ? abs : `${abs}.neon`;
    await this.flush();
    await mkdir(dest, { recursive: true });
    await cp(this.assetsDir, join(dest, 'assets'), { recursive: true, force: false, errorOnExist: false });
    await cp(join(this.dir, 'history'), join(dest, 'history'), { recursive: true, force: true }).catch(() => undefined);
    const oldDir = this.dir;
    this.dir = dest;
    if (this.doc.getMeta().name === 'Untitled Project') {
      this.doc.updateMeta({ name: basename(dest).replace(/\.neon$/, '') }, ORIGIN_SYSTEM);
    }
    await this.save();
    if (oldDir.startsWith(paths.scratchProjects())) await rm(oldDir, { recursive: true, force: true }).catch(() => undefined);
    this.emit('doc-replaced');
    return dest;
  }

  // ---- events --------------------------------------------------------------------------

  on(event: StoreEvent, listener: Listener): () => void {
    let set = this.listeners.get(event);
    if (!set) this.listeners.set(event, (set = new Set()));
    set.add(listener);
    return () => set!.delete(listener);
  }

  private emit(event: StoreEvent): void {
    for (const l of this.listeners.get(event) ?? []) {
      try {
        l(this);
      } catch (err) {
        console.error(`[store] listener for ${event} failed`, err);
      }
    }
  }
}

async function loadDoc(dir: string): Promise<ProjectDoc> {
  const doc = new ProjectDoc();
  try {
    const bin = await readFile(join(dir, 'doc.bin'));
    Y.applyUpdate(doc.doc, new Uint8Array(bin), ORIGIN_SYSTEM);
    if (doc.isInitialized) return doc;
  } catch {
    /* fall back to project.json */
  }
  const raw = await readFile(join(dir, 'project.json'), 'utf8');
  const parsed = ProjectSchema.safeParse(JSON.parse(raw));
  if (!parsed.success) throw new Error(`Invalid project.json in ${dir}: ${parsed.error.issues[0]?.message ?? 'schema error'}`);
  doc.load(parsed.data);
  return doc;
}

async function writeAtomic(path: string, data: string | Uint8Array): Promise<void> {
  const tmp = `${path}.${newId().slice(0, 6)}.tmp`;
  await writeFile(tmp, data);
  await rename(tmp, path);
}

function safeName(name: string): string {
  return name.replace(/[^a-zA-Z0-9-_ ]/g, '').trim().replace(/\s+/g, '-').slice(0, 40) || 'project';
}
