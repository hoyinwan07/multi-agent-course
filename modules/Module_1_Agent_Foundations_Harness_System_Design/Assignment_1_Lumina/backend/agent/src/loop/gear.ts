/**
 * The gear: which envelope this run is allowed to spend, and which tools it may see.
 * Seam 2 of the Week 2 ledger (TECHSPEC §13).
 *
 * The structural invariant that makes the seam real: nothing anywhere hard-codes a cap.
 * Every check reads `gear.maxToolCalls` / `gear.wallClockSec`. Week 2 changes the numbers
 * this function returns and changes nothing else.
 */
import type { Depth } from '@lumina/contract';
import { DEEP_ONLY_TOOLS } from '@lumina/contract';
import { env } from '../env.js';

export type Gear = {
  depth: Depth;
  maxToolCalls: number;
  wallClockSec: number;
  /**
   * Tools this gear may never be shown, whatever the model would like. The contract
   * owns this list — `plan_research` is not deep-only because we say so here.
   */
  forbiddenTools: readonly string[];
};

export function resolveGear(depth: Depth): Gear {
  if (depth === 'deep') {
    return {
      depth,
      maxToolCalls: env.maxToolCallsDeep,
      wallClockSec: env.maxWallClockSecDeep,
      forbiddenTools: []
    };
  }
  return {
    depth: 'quick',
    maxToolCalls: env.maxToolCalls,
    wallClockSec: env.maxWallClockSec,
    // A quick run whose trace contains plan_research has escalated itself into a run
    // costing several times more. bench.mjs checks every quick run for exactly this.
    forbiddenTools: DEEP_ONLY_TOOLS
  };
}

/** The wall-clock deadline as an absolute instant, so every check is a comparison. */
export const deadlineFrom = (startedAt: number, gear: Gear): number =>
  startedAt + gear.wallClockSec * 1000;
