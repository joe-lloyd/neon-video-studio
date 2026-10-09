/**
 * `neon-cli apply` (batch plans) and the JSON input shared with `neon-cli api`.
 */
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { ZodError, parsePlan, type BatchFailure, type BatchRequest, type BatchResult, type PlanCheck } from '@neon/core';
import { ApiError } from './client.ts';

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * JSON from a command-line argument: "-" reads stdin, "@path" reads a file, anything else is
 * parsed as JSON text, or (with `pathByDefault`) read as a file path.
 */
export async function readJsonArg(arg: string, pathByDefault = false): Promise<unknown> {
  let text: string;
  let from: string;
  if (arg === '-') {
    text = await readStdin();
    from = 'stdin';
  } else if (arg.startsWith('@') || pathByDefault) {
    const file = resolve(arg.startsWith('@') ? arg.slice(1) : arg);
    text = await readFile(file, 'utf8').catch((err: NodeJS.ErrnoException) => {
      throw new ApiError('NO_FILE', `Cannot read ${file}: ${err.code ?? err.message}`);
    });
    from = file;
  } else {
    text = arg;
    from = 'the argument';
  }
  try {
    return JSON.parse(text) as unknown;
  } catch (err) {
    throw new ApiError('BAD_JSON', `${from} is not valid JSON: ${(err as Error).message}`);
  }
}

export async function loadPlan(arg: string): Promise<BatchRequest> {
  const raw = await readJsonArg(arg, true);
  try {
    return parsePlan(raw);
  } catch (err) {
    if (!(err instanceof ZodError)) throw err;
    const issues = err.issues.map((i) => `${i.path.map(String).join('.') || '(plan)'}: ${i.message}`).join('; ');
    throw new ApiError('PLAN_INVALID', `Plan must be {"ops":[{"route":"/api/…","body":{…}}]} or a bare array of ops: ${issues}`);
  }
}

export function formatPlanCheck(checks: PlanCheck[]): string {
  return checks.map((c) => `#${c.op} ${c.route} ${c.problems.length ? `✗ ${c.problems.join('; ')}` : '✓'}`).join('\n');
}

/** One line per result: the id and name when the result is a clip/track, otherwise its keys. */
function describe(result: unknown): string {
  if (Array.isArray(result)) return `[${result.map(describe).join(', ')}]`;
  if (result === null || typeof result !== 'object') return JSON.stringify(result);
  const id = Object.getOwnPropertyDescriptor(result, 'id')?.value;
  const name = Object.getOwnPropertyDescriptor(result, 'name')?.value;
  if (typeof id === 'string') return `${id}${typeof name === 'string' ? ` “${name}”` : ''}`;
  return `{${Object.keys(result).join(', ')}}`;
}

export function formatApplied(plan: BatchRequest, r: BatchResult): string {
  const lines = plan.ops.map((op, i) => `#${i} ${op.route} → ${describe(r.results[i])}`);
  lines.push(`Applied ${plan.ops.length} op(s) as checkpoint ${r.history.cursor + 1} of ${r.history.count}; \`neon-cli history undo\` reverts the whole batch`);
  return lines.join('\n');
}

export function batchFailure(details: unknown): BatchFailure | null {
  if (details === null || typeof details !== 'object') return null;
  const failedAt = Object.getOwnPropertyDescriptor(details, 'failedAt')?.value;
  const results = Object.getOwnPropertyDescriptor(details, 'results')?.value;
  const rolledBack = Object.getOwnPropertyDescriptor(details, 'rolledBack')?.value;
  const cause = Object.getOwnPropertyDescriptor(details, 'cause')?.value;
  if (typeof failedAt !== 'number' || !Array.isArray(results) || typeof rolledBack !== 'boolean') return null;
  return { failedAt, results, rolledBack, ...(cause === undefined ? {} : { cause }) };
}
