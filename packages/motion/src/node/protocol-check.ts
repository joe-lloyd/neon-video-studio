/**
 * Compile-time only: fails `pnpm --filter @neon/motion typecheck` if protocol.ts drifts from the
 * page side. Not imported at runtime.
 */
import type * as Page from '../render-page.tsx';
import type * as Ctx from '../context.tsx';
import type * as Node from './protocol.ts';

type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const checks: [Same<Node.AudioFrameEntry, Ctx.AudioFrameEntry>, Same<Node.RenderInit, Page.RenderInit>, Same<Node.RenderFrameResult, Page.RenderFrameResult>] = [true, true, true];
void checks;
