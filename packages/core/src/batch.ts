/**
 * Batch plans (`neon-cli apply`, POST /api/batch): parsing, result references and offline checks.
 *
 * A body may point at an earlier op's result: a string that is exactly "$N" or "$N.<path>"
 * ("$0.id", "$2.1.id" for the right half of a split) is replaced before op N+k runs. A string
 * starting with "$$" is sent with one "$" removed, for text that really starts with "$".
 */
import { checkBatchRoute } from './api-catalog.ts';
import { BatchRequestSchema, type BatchRequest } from './schemas.ts';

export interface BatchRef {
  /** Index of the op whose result is referenced. */
  op: number;
  /** Keys / array indexes into that result. */
  path: string[];
}

const REF = /^\$(\d+)((?:\.[^.]+)*)$/;

export function parseRef(value: string): BatchRef | null {
  const m = REF.exec(value);
  if (!m) return null;
  return { op: Number(m[1]), path: m[2] ? m[2].slice(1).split('.') : [] };
}

/** `{ "ops": [...] }` or a bare array of ops. Throws a ZodError on anything else. */
export function parsePlan(raw: unknown): BatchRequest {
  return BatchRequestSchema.parse(Array.isArray(raw) ? { ops: raw } : raw);
}

type Path = (string | number)[];

/** Copy of `value` with every ref string replaced by `replace(ref, path)` and "$$" unescaped. */
function mapRefs(value: unknown, replace: (ref: BatchRef, at: Path) => unknown, at: Path = []): unknown {
  if (typeof value === 'string') {
    if (value.startsWith('$$')) return value.slice(1);
    const ref = parseRef(value);
    return ref ? replace(ref, at) : value;
  }
  if (Array.isArray(value)) return value.map((v, i) => mapRefs(v, replace, [...at, i]));
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, mapRefs(v, replace, [...at, k])]));
  }
  return value;
}

function show(ref: BatchRef): string {
  return ['$' + ref.op, ...ref.path].join('.');
}

const ESCAPE_HINT = 'write "$$…" to send text that starts with "$"';

/** Replace refs in `body` with values from `results` (results[i] = op i's result). Throws on a bad ref. */
export function resolveRefs(body: unknown, results: readonly unknown[]): unknown {
  return mapRefs(body, (ref) => {
    if (ref.op >= results.length) throw new Error(`${show(ref)} points at op ${ref.op}, which has not run yet; refs name earlier ops (${ESCAPE_HINT})`);
    let current: unknown = results[ref.op];
    for (const [i, key] of ref.path.entries()) {
      const here = show({ op: ref.op, path: ref.path.slice(0, i) });
      if (Array.isArray(current)) {
        const index = Number(key);
        if (!Number.isInteger(index) || index < 0 || index >= current.length) throw new Error(`${show(ref)}: ${here} is a list of ${current.length}, "${key}" is not an index in it`);
        current = current[index];
      } else if (current !== null && typeof current === 'object' && Object.hasOwn(current, key)) {
        current = Object.getOwnPropertyDescriptor(current, key)?.value;
      } else {
        const keys = current !== null && typeof current === 'object' ? Object.keys(current).join(', ') : typeof current;
        throw new Error(`${show(ref)}: ${here} has no "${key}" (it has: ${keys})`);
      }
    }
    return current;
  });
}

/** Where `body` holds refs, as zod-style paths. */
export function refSites(body: unknown): { at: Path; ref: BatchRef }[] {
  const sites: { at: Path; ref: BatchRef }[] = [];
  mapRefs(body, (ref, at) => {
    sites.push({ at, ref });
    return null;
  });
  return sites;
}

export interface PlanCheck {
  op: number;
  route: string;
  /** Empty when the op looks valid. */
  problems: string[];
}

const samePath = (a: Path, b: readonly PropertyKey[]) => a.length === b.length && a.every((p, i) => String(p) === String(b[i]));

/**
 * Validate a plan without running it: each route must be batchable, each ref must name an
 * earlier op, and each body must match its route's schema. A ref stands in for a value only
 * known at run time, so schema issues at a ref's own position are not reported.
 */
export function checkPlan(plan: BatchRequest): PlanCheck[] {
  return plan.ops.map((op, index) => {
    const problems: string[] = [];
    const route = checkBatchRoute(op.route);
    const sites = refSites(op.body);
    for (const { ref } of sites) if (ref.op >= index) problems.push(`${show(ref)} must point at an earlier op, this is op ${index} (${ESCAPE_HINT})`);
    if (!route.ok) problems.push(route.reason);
    else if (route.entry.spec.body) {
      const parsed = route.entry.spec.body.safeParse(op.body ?? {});
      if (!parsed.success) {
        for (const issue of parsed.error.issues) {
          if (sites.some((s) => samePath(s.at, issue.path))) continue;
          problems.push(`${issue.path.map(String).join('.') || '(body)'}: ${issue.message}`);
        }
      }
    }
    return { op: index, route: op.route, problems };
  });
}
