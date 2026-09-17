/**
 * Body validation, from the contract's own zod schemas — so a malformed request dies at
 * the edge with a message that names the field, instead of costing an agent round trip.
 *
 * **Bodies only, deliberately.** Path params are NOT validated here, and that is a
 * contract requirement rather than an omission: `GET /threads/thr_nope` must answer 404,
 * not 400. A gateway that rejected the *shape* of an id would turn "no such thread" into
 * "bad request" for any id the regex disliked, and the bench probes exactly that case.
 * Whether an id exists is a question only the agent service can answer, so the whole
 * question goes there.
 */
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { ZodTypeAny } from 'zod';

/**
 * Parse `req.body` with `schema` or answer 400 with the zod message.
 *
 * On success the *parsed* value replaces `req.body`, so contract defaults (`mode: 'auto'`,
 * `depth: 'quick'`) are applied once, at the edge, and the agent receives an explicit body.
 * `depth` defaulting here is the same default the agent applies — the server still never
 * upgrades a request to deep on its own.
 */
export function validateBody(schema: ZodTypeAny): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    const parsed = schema.safeParse(req.body ?? {});
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      const path = issue?.path.join('.');
      res.status(400).json({
        // The field name first, because "query is required" without it is a message a
        // client developer has to guess at.
        error: issue ? (path ? `${path}: ${issue.message}` : issue.message) : 'invalid body',
        status: 400,
        requestId: String(res.locals.requestId)
      });
      return;
    }

    req.body = parsed.data;
    next();
  };
}
