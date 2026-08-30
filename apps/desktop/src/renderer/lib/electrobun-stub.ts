/**
 * Stand-in for `electrobun/view` when the Hutch devkit is not present (plain-browser dev).
 * The bridge detects the stub and falls back to the HTTP control API.
 */
export type RPCSchema<T> = T;

export class Electroview<T = unknown> {
  static readonly isStub = true;
  rpc: T | null;
  constructor(opts: { rpc?: T }) {
    this.rpc = opts.rpc ?? null;
  }
  static defineRPC<_T>(_config: unknown): never {
    throw new Error('electrobun/view is not available outside the Electrobun webview');
  }
}
