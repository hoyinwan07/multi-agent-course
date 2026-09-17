/**
 * Identity, such as it is: the `X-User-Id` header, enforced in every router.
 *
 * Enforced HERE as well as at the gateway because this service listens on its own port and
 * a check that exists only on the edge is a check you get past by not using the edge. It is
 * the same argument `SPEC.md` makes about the deep-search daily cap, and it applies to
 * anything that scopes data to a user.
 */
import type { Request, Response } from 'express';
import { USER_HEADER } from '@lumina/contract';

/** The user id, or null having ALREADY answered 401 — so every caller is `if (!u) return`. */
export function requireUser(req: Request, res: Response): string | null {
  const userId = req.header(USER_HEADER)?.trim();
  if (userId) return userId;
  res.status(401).json({ error: `${USER_HEADER} is required`, status: 401 });
  return null;
}
