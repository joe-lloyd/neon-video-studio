/**
 * Minimal Chrome DevTools Protocol client over the global WebSocket (Node ≥ 22).
 *
 * One connection to the browser endpoint; pages are driven through flattened sessions
 * (`Target.attachToTarget({ flatten: true })`), so every message carries an optional `sessionId`
 * and there is exactly one socket per browser.
 */

export interface CdpEvent {
  method: string;
  params: Record<string, unknown>;
  sessionId?: string;
}

type EventHandler = (params: Record<string, unknown>, sessionId: string | undefined) => void;

interface PendingCall {
  method: string;
  resolve(value: Record<string, unknown>): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout> | undefined;
}

export class CdpError extends Error {
  code: number | undefined;
  constructor(message: string, code?: number) {
    super(message);
    this.name = 'CdpError';
    this.code = code;
  }
}

export const DEFAULT_CDP_TIMEOUT_MS = 30_000;

export class CdpConnection {
  private socket: WebSocket;
  private nextId = 1;
  private pending = new Map<number, PendingCall>();
  private handlers = new Map<string, Set<EventHandler>>();
  private closeListeners = new Set<(reason: string) => void>();
  private closedReason: string | null = null;

  private constructor(socket: WebSocket) {
    this.socket = socket;
    socket.addEventListener('message', (e) => this.onMessage(e.data));
    socket.addEventListener('close', () => this.onClosed('DevTools connection closed'));
    socket.addEventListener('error', () => this.onClosed('DevTools connection error'));
  }

  /** Open a connection to a `ws://…/devtools/browser/…` endpoint. */
  static connect(wsUrl: string, timeoutMs = DEFAULT_CDP_TIMEOUT_MS): Promise<CdpConnection> {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(wsUrl);
      const timer = setTimeout(() => {
        socket.close();
        reject(new Error(`Timed out connecting to DevTools at ${wsUrl}`));
      }, timeoutMs);
      socket.addEventListener('open', () => {
        clearTimeout(timer);
        resolve(new CdpConnection(socket));
      }, { once: true });
      socket.addEventListener('error', () => {
        clearTimeout(timer);
        reject(new Error(`Could not connect to DevTools at ${wsUrl}`));
      }, { once: true });
    });
  }

  get closed(): boolean {
    return this.closedReason !== null;
  }

  send<T = Record<string, unknown>>(method: string, params: Record<string, unknown> = {}, sessionId?: string, timeoutMs = DEFAULT_CDP_TIMEOUT_MS): Promise<T> {
    if (this.closedReason !== null) return Promise.reject(new CdpError(`${method}: ${this.closedReason}`));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const call: PendingCall = {
        method,
        resolve: resolve as (value: Record<string, unknown>) => void,
        reject,
        timer: timeoutMs > 0 && Number.isFinite(timeoutMs)
          ? setTimeout(() => {
            this.pending.delete(id);
            reject(new CdpError(`${method} timed out after ${timeoutMs} ms`));
          }, timeoutMs)
          : undefined,
      };
      this.pending.set(id, call);
      this.socket.send(JSON.stringify(sessionId ? { id, method, params, sessionId } : { id, method, params }));
    });
  }

  /** Subscribe to an event (from any session); returns an unsubscribe function. */
  on(method: string, handler: EventHandler): () => void {
    let set = this.handlers.get(method);
    if (!set) this.handlers.set(method, (set = new Set()));
    set.add(handler);
    return () => set.delete(handler);
  }

  /** Resolves with the first matching event's params. */
  waitFor(method: string, opts: { sessionId?: string; timeoutMs?: number; predicate?: (params: Record<string, unknown>) => boolean } = {}): Promise<Record<string, unknown>> {
    const timeoutMs = opts.timeoutMs ?? DEFAULT_CDP_TIMEOUT_MS;
    return new Promise((resolve, reject) => {
      const off = this.on(method, (params, sessionId) => {
        if (opts.sessionId && sessionId !== opts.sessionId) return;
        if (opts.predicate && !opts.predicate(params)) return;
        cleanup();
        resolve(params);
      });
      const offClose = this.onClose((reason) => {
        cleanup();
        reject(new CdpError(`${method}: ${reason}`));
      });
      const timer = setTimeout(() => {
        cleanup();
        reject(new CdpError(`Timed out after ${timeoutMs} ms waiting for ${method}`));
      }, timeoutMs);
      const cleanup = () => {
        clearTimeout(timer);
        off();
        offClose();
      };
    });
  }

  onClose(listener: (reason: string) => void): () => void {
    this.closeListeners.add(listener);
    return () => this.closeListeners.delete(listener);
  }

  session(sessionId: string): CdpSession {
    return new CdpSession(this, sessionId);
  }

  close(): void {
    if (this.closedReason === null) {
      try {
        this.socket.close();
      } catch {
        /* already closing */
      }
    }
    this.onClosed('DevTools connection closed');
  }

  private onMessage(data: unknown): void {
    let msg: { id?: number; method?: string; params?: Record<string, unknown>; sessionId?: string; result?: Record<string, unknown>; error?: { message: string; code?: number; data?: string } };
    try {
      msg = JSON.parse(typeof data === 'string' ? data : Buffer.from(data as ArrayBuffer).toString('utf8'));
    } catch {
      return;
    }
    if (typeof msg.id === 'number') {
      const call = this.pending.get(msg.id);
      if (!call) return;
      this.pending.delete(msg.id);
      if (call.timer) clearTimeout(call.timer);
      if (msg.error) call.reject(new CdpError(`${call.method}: ${msg.error.message}${msg.error.data ? ` (${msg.error.data})` : ''}`, msg.error.code));
      else call.resolve(msg.result ?? {});
      return;
    }
    if (msg.method) {
      const set = this.handlers.get(msg.method);
      if (!set) return;
      for (const handler of [...set]) handler(msg.params ?? {}, msg.sessionId);
    }
  }

  private onClosed(reason: string): void {
    if (this.closedReason !== null) return;
    this.closedReason = reason;
    for (const [, call] of this.pending) {
      if (call.timer) clearTimeout(call.timer);
      call.reject(new CdpError(`${call.method}: ${reason}`));
    }
    this.pending.clear();
    for (const listener of [...this.closeListeners]) listener(reason);
    this.closeListeners.clear();
  }
}

/** A flattened target session (one page). */
export class CdpSession {
  readonly connection: CdpConnection;
  readonly id: string;

  constructor(connection: CdpConnection, id: string) {
    this.connection = connection;
    this.id = id;
  }

  send<T = Record<string, unknown>>(method: string, params: Record<string, unknown> = {}, timeoutMs?: number): Promise<T> {
    return this.connection.send<T>(method, params, this.id, timeoutMs);
  }

  on(method: string, handler: (params: Record<string, unknown>) => void): () => void {
    return this.connection.on(method, (params, sessionId) => {
      if (sessionId === this.id) handler(params);
    });
  }

  waitFor(method: string, opts: { timeoutMs?: number; predicate?: (params: Record<string, unknown>) => boolean } = {}): Promise<Record<string, unknown>> {
    return this.connection.waitFor(method, { ...opts, sessionId: this.id });
  }
}
