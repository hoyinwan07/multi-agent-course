/**
 * Identity: the `X-User-Id` header, and nothing else.
 *
 * First in the chain after logging, and before validation, because a request with no
 * identity is a 401 whatever its body looks like. Telling an anonymous caller that their
 * body is also malformed leaks the shape of a route they are not allowed to reach.
 *
 * The agent service enforces the same header again on its own port (`http/auth.ts`). That
 * is deliberate duplication, not a redundancy to remove: a check that exists only on the
 * edge is a check you get past by not using the edge.
 */
import type { NextFunction, Request, Response } from 'express';
import { USER_HEADER } from '@lumina/contract';

export function requireUser(req: Request, res: Response, next: NextFunction): void {
  // `.trim()` matters: the bench probes with `x-user-id: ''`, and an empty header is
  // present-but-anonymous, which is the same thing as absent.
  const userId = req.header(USER_HEADER)?.trim();
  if (!userId) {
    res.status(401).json({
      error: `${USER_HEADER} is required`,
      status: 401,
      requestId: String(res.locals.requestId)
    });
    return;
  }

  // The rate limiter and the proxies read it from here rather than re-reading the header,
  // so "the identity this request was rate-limited and proxied under" has one definition.
  res.locals.userId = userId;
  next();
}
