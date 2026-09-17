/**
 * Per-user fixed window, in memory. §11.3.
 *
 * After `requireUser`, because the limit is per identity and needs one first.
 *
 * **Known limit, stated rather than hidden:** the window lives in this process's heap, so
 * it is per instance. Run two instances behind a load balancer and each keeps its own
 * counter — a user spread across both gets twice the limit, and a user pinned to one gets
 * exactly the limit. That is the honest trade for a single-instance deploy: no Redis, no
 * network hop in front of every request, and a failure mode that is too permissive rather
 * than one that rejects legitimate traffic. The fix when it matters is a shared counter.
 *
 * **A fixed window, not a sliding one.** A caller can spend the whole allowance in the
 * last second of one window and again in the first second of the next — 2x the nominal
 * rate across that boundary. A sliding window costs a list of timestamps per user to
 * close a hole that only a deliberate attacker walks through, and this limiter exists to
 * stop a runaway client, not an adversary.
 *
 * The deep-search daily cap does NOT belong here. It is a spend gate on a provider call,
 * it lives next to the spending in the agent service, and a cap on the edge is a cap you
 * bypass by reaching the agent service directly.
 */
import type { NextFunction, Request, Response } from 'express';
import { env } from '../env.js';

const WINDOW_MS = 60_000;

/**
 * Above this many tracked users we sweep expired windows. Nothing else ever frees them,
 * and an unbounded Map keyed by a client-supplied header is a memory leak with a name.
 */
const SWEEP_ABOVE = 10_000;

type Window = { count: number; startedAt: number };

const windows = new Map<string, Window>();

function sweep(now: number): void {
  for (const [userId, w] of windows) {
    if (now - w.startedAt >= WINDOW_MS) windows.delete(userId);
  }
}

export function rateLimit(_req: Request, res: Response, next: NextFunction): void {
  const userId = String(res.locals.userId ?? '');
  const now = Date.now();

  let window = windows.get(userId);
  if (!window || now - window.startedAt >= WINDOW_MS) {
    window = { count: 0, startedAt: now };
    windows.set(userId, window);
  }

  window.count += 1;

  const limit = env.rateLimitPerMinute;
  res.setHeader('X-RateLimit-Limit', String(limit));
  res.setHeader('X-RateLimit-Remaining', String(Math.max(0, limit - window.count)));

  if (window.count > limit) {
    const resetsAtMs = window.startedAt + WINDOW_MS;
    res.setHeader('Retry-After', String(Math.max(1, Math.ceil((resetsAtMs - now) / 1000))));
    res.status(429).json({
      error: `rate limit exceeded: ${limit} requests per minute`,
      status: 429,
      // Same shape the deep-search cap uses, so a client has one 429 to handle.
      resetsAt: new Date(resetsAtMs).toISOString(),
      requestId: String(res.locals.requestId)
    });
    return;
  }

  if (windows.size > SWEEP_ABOVE) sweep(now);
  next();
}
