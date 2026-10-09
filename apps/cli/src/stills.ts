/**
 * `neon-cli still` and `neon-cli sheet`: render PNGs of the timeline so an agent can look at its
 * edit. Through the running app by default, or straight from a project directory with --headless.
 */
import { join, resolve } from 'node:path';
import { projectDurationFrames, stillFileName, type SheetRequestInput, type StillRequestInput, type StillResult } from '@neon/core';
import { neonHome } from '@neon/core/node';
import { captureFrames, loadProjectDir, parseCapture, renderHeadless } from '@neon/render';
import { ApiError, type NeonClient } from './client.ts';

export interface StillFlags {
  at?: string;
  from?: string;
  to?: string;
  count?: string;
  every?: string;
  cols?: string;
  width?: string;
  out?: string;
  output?: string;
  headless: boolean;
  project?: string;
  json: boolean;
}

function num(raw: string | undefined, flag: string): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n)) throw new ApiError('BAD_NUMBER', `--${flag} expects a whole number, got "${raw}"`);
  return n;
}

type Body = { kind: 'still'; body: StillRequestInput } | { kind: 'sheet'; body: SheetRequestInput };

/** Flags to a request body. The schema validates it: the app's, or parseCapture's for --headless. */
function requestBody(kind: 'still' | 'sheet', flags: StillFlags): Body {
  const out = flags.out ?? flags.output;
  const output = out === undefined ? undefined : resolve(out);
  const width = num(flags.width, 'width');
  if (kind === 'still') {
    if (flags.at === undefined) throw new ApiError('USAGE', 'still --at T [--out f.png] [--width 1280]');
    return { kind, body: { at: flags.at, width, output } };
  }
  return { kind, body: { from: flags.from, to: flags.to, count: num(flags.count, 'count'), every: flags.every, cols: num(flags.cols, 'cols'), width, output } };
}

async function headless(req: Body, flags: StillFlags): Promise<StillResult> {
  if (!flags.project) throw new ApiError('USAGE', `${req.kind} --headless requires --project <dir.neon>`);
  const project = await loadProjectDir(flags.project);
  const { fps } = project.meta;
  const { target, output } = parseCapture(req.kind, req.body, fps, projectDurationFrames(project));
  const frames = captureFrames(target);
  const outputPath = output ?? join(neonHome(), 'stills', stillFileName(project.meta.name, fps, frames));
  const result = await renderHeadless({
    projectDir: flags.project,
    target: () => ({ ...target, outputPath }),
    onEvent: (e) => {
      if (flags.json) return;
      if (e.type === 'stage') process.stderr.write(`${e.stage}: ${e.message ?? ''}\n`);
      if (e.type === 'bundle') process.stderr.write(`bundle ${e.cached ? 'cache hit' : 'built'}: ${e.location}\n`);
    },
    onLog: (line) => {
      if (!flags.json && process.env.NEON_VERBOSE) process.stderr.write(`  ${line}\n`);
    },
  });
  return { path: result.outputPath, frames, width: result.width, height: result.height };
}

export async function stillCommand(kind: 'still' | 'sheet', flags: StillFlags, connect: () => Promise<NeonClient>): Promise<StillResult> {
  const req = requestBody(kind, flags);
  if (flags.headless) return headless(req, flags);
  const api = await connect();
  if (!flags.json) process.stderr.write(`Rendering ${kind}…\n`);
  return req.kind === 'still' ? api.still(req.body) : api.sheet(req.body);
}

export function describeStill(r: StillResult): string {
  const frames = r.frames.length === 1 ? `frame ${r.frames[0]}` : `${r.frames.length} frames: ${r.frames.join(', ')}`;
  return `${r.path} (${r.width}×${r.height}, ${frames})`;
}
