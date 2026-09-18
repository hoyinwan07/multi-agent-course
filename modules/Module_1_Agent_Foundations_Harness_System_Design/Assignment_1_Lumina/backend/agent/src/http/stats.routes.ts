/**
 * GET /stats (SPEC §5 "make cost visible and gated", TECHSPEC §10.4).
 *
 * Everything but `deepDailyCap` is a per-user, today-so-far aggregate over `messages`
 * (`repo/messages.ts`'s `statsForUserSince` explains why that collection rather than
 * `runs`/`requests`). `deepDailyCap` is config, not data — same reasoning `worker.ts`'s
 * header gives for env-driven numbers: it is the ceiling the server enforces, not a
 * measurement of what happened.
 *
 * "Today" is midnight UTC, matching how `createdAt` is written everywhere in this service
 * (`new Date().toISOString()`) — a local-timezone boundary would make the number jump at a
 * different moment than the data actually resets.
 */
import { Router, type Request, type Response } from 'express';
import type { StatsResponse } from '@lumina/contract';
import { env } from '../env.js';
import { statsForUserSince } from '../repo/messages.js';
import { requireUser } from './auth.js';

export const statsRouter: Router = Router();

statsRouter.get('/stats', async (req: Request, res: Response) => {
  const userId = requireUser(req, res);
  if (!userId) return;

  const since = startOfUtcDay();
  const agg = await statsForUserSince(userId, since);

  const body: StatsResponse = {
    ...agg,
    // Week 2 note, same as TECHSPEC's: the cap is real config (§ env.deepDailyCap), but
    // deep search itself is not built yet, so `deepToday` is always 0 in practice.
    deepDailyCap: env.deepDailyCap
  };
  res.json(body);
});

const startOfUtcDay = (): Date => {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
};
