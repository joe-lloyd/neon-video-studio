/** Still and sheet requests, shared by the control API and `neon-cli still|sheet --headless`. */
import { SheetRequestSchema, StillRequestSchema, sheetFramesFor, stillFrame } from '@neon/core';
import type { StillTarget } from './types.ts';

/** Validate a request body and resolve its times against the timeline. */
export function parseCapture(kind: StillTarget['kind'], body: unknown, fps: number, durationFrames: number): { target: StillTarget; output: string | undefined } {
  switch (kind) {
    case 'still': {
      const req = StillRequestSchema.parse(body);
      return { target: { kind, frame: stillFrame(req, fps, durationFrames), width: req.width }, output: req.output };
    }
    case 'sheet': {
      const req = SheetRequestSchema.parse(body);
      return { target: { kind, frames: sheetFramesFor(req, fps, durationFrames), cols: req.cols, width: req.width }, output: req.output };
    }
    default: {
      const unreachable: never = kind;
      throw new Error(`Unknown capture ${String(unreachable)}`);
    }
  }
}

/** Project frames a capture shows, in order. */
export function captureFrames(target: StillTarget): number[] {
  return target.kind === 'still' ? [target.frame] : target.frames;
}
