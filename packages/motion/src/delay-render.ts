/**
 * Render gating. Anything that must finish before a frame may be captured (an image decoding, a
 * font, data loading) takes a handle with `delayRender()` and releases it with `continueRender()`.
 * The headless renderer waits for zero open handles before every screenshot; the preview Player
 * ignores them (it never blocks on loading).
 */
interface Pending {
  label: string;
  started: number;
  timeoutMs: number;
}

const pending = new Map<number, Pending>();
let nextHandle = 1;
let fatal: Error | null = null;
const idleWaiters = new Set<() => void>();

export const DEFAULT_DELAY_RENDER_TIMEOUT_MS = 30_000;

export function delayRender(label = 'delayRender()', options: { timeoutInMilliseconds?: number } = {}): number {
  const handle = nextHandle++;
  pending.set(handle, { label, started: Date.now(), timeoutMs: options.timeoutInMilliseconds ?? DEFAULT_DELAY_RENDER_TIMEOUT_MS });
  return handle;
}

export function continueRender(handle: number): void {
  if (!pending.delete(handle)) return;
  // Wake on a microtask, not synchronously: React releases an old handle in a layout-effect
  // cleanup and takes the new one in the same commit (e.g. <Img> retrying a new src), and a
  // waiter must not see the empty moment in between and capture the frame too early.
  if (pending.size === 0) {
    queueMicrotask(() => {
      if (pending.size === 0) for (const wake of [...idleWaiters]) wake();
    });
  }
}

/** Abort the render with an error (no-op in the preview). */
export function cancelRender(error: unknown): void {
  fatal = error instanceof Error ? error : new Error(String(error));
  for (const wake of [...idleWaiters]) wake();
}

export function pendingDelayRenders(): string[] {
  return [...pending.values()].map((p) => p.label);
}

/** Resolves once no handles are open; rejects on cancelRender() or when a handle outlives its timeout. */
export function waitForRenderIdle(): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const check = () => {
      if (fatal) {
        const err = fatal;
        fatal = null;
        cleanup();
        reject(err);
        return;
      }
      if (pending.size === 0) {
        cleanup();
        resolve();
        return;
      }
      const now = Date.now();
      for (const p of pending.values()) {
        if (now - p.started > p.timeoutMs) {
          cleanup();
          reject(new Error(`A delayRender() handle was not released within ${p.timeoutMs} ms: "${p.label}"`));
          return;
        }
      }
      timer = setTimeout(check, 50);
    };
    const cleanup = () => {
      idleWaiters.delete(check);
      if (timer) clearTimeout(timer);
    };
    idleWaiters.add(check);
    check();
  });
}
