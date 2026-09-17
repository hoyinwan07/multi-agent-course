/**
 * The JSON proxy: forward the request to the agent service, pass its answer back byte for
 * byte, and turn any failure to reach it into a 502.
 *
 * **The status is never rewritten.** A 401, 404, 429 or 501 from the agent arrives at the
 * client as itself. The gateway decides who may ask; the agent decides what the answer is,
 * including which failure it was. The one status this file mints is 502, and only when the
 * agent could not be reached or did not answer — never when it answered with an error.
 * (Rule A1: never a 2xx when the upstream threw.)
 *
 * The body is relayed as text, not re-parsed and re-serialised. Parsing would put this
 * file in a position to silently change a payload it does not own.
 */
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { MAX_UPLOAD_BYTES, REQUEST_HEADER, USER_HEADER } from '@lumina/contract';
import { env } from '../env.js';

/** Plenty for a Mongo round trip; short enough that a hung agent is a 502, not a hung tab. */
const UPSTREAM_TIMEOUT_MS = 30_000;

/** An upload is bytes over the wire before it is a 202, so it gets its own budget. */
const UPLOAD_TIMEOUT_MS = 60_000;

/**
 * What the agent needs to serve and log the request. `x-request-id` is the one that makes a
 * request greppable end to end: the gateway either reuses the caller's or minted one, and
 * from here on both services log the same string.
 */
function forwardHeaders(req: Request, res: Response): Record<string, string> {
  const headers: Record<string, string> = {
    [USER_HEADER]: String(res.locals.userId ?? ''),
    [REQUEST_HEADER]: String(res.locals.requestId)
  };
  const accept = req.header('accept');
  if (accept) headers.accept = accept;
  return headers;
}

/** Relay an upstream response verbatim: same status, same content type, same bytes. */
async function relay(upstream: globalThis.Response, res: Response): Promise<void> {
  const text = await upstream.text();
  const contentType = upstream.headers.get('content-type');
  if (contentType) res.setHeader('Content-Type', contentType);
  res.status(upstream.status).send(text);
}

/** Context the 502 needs to name which call failed, since `fetch failed` alone names nothing. */
const upstreamError = (req: Request, err: unknown): Error =>
  new Error(
    `agent ${req.method} ${req.path} failed: ${err instanceof Error ? err.message : String(err)}`
  );

/**
 * Forward a JSON request (or a body-less GET/DELETE) to the agent service.
 *
 * `req.originalUrl` rather than `req.path`, so a query string survives the hop.
 */
export const proxyJson: RequestHandler = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  const hasBody = req.method !== 'GET' && req.method !== 'DELETE' && req.method !== 'HEAD';
  const headers = forwardHeaders(req, res);
  if (hasBody) headers['content-type'] = 'application/json';

  try {
    const upstream = await fetch(`${env.agentUrl}${req.originalUrl}`, {
      method: req.method,
      headers,
      // The body validate.ts already parsed — defaults applied, shape known.
      body: hasBody ? JSON.stringify(req.body ?? {}) : undefined,
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS)
    });
    await relay(upstream, res);
  } catch (err) {
    next(upstreamError(req, err));
  }
};

/**
 * Forward a multipart upload without reading it into memory. [W2 seam — the route is live
 * here in Week 1 and relays the agent's own 501.]
 *
 * `index.ts` deliberately skips `express.json()` for this route, so the request is still an
 * unread stream: it is piped straight to the agent, which means a 25MB PDF never lands in
 * this process's heap. `duplex: 'half'` is required whenever a fetch body is a stream — the
 * request finishes sending before the response starts arriving.
 *
 * The `Content-Length` check is an edge courtesy, not the enforcement: a client can lie
 * about it or omit it entirely, so the agent still has to count bytes as they arrive. What
 * this buys is rejecting an oversized upload before it spends a minute crossing the wire.
 */
export const proxyUpload: RequestHandler = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  const declared = Number(req.header('content-length') ?? NaN);
  if (Number.isFinite(declared) && declared > MAX_UPLOAD_BYTES) {
    res.status(413).json({
      error: `file too large: ${declared} bytes, limit ${MAX_UPLOAD_BYTES}`,
      status: 413,
      requestId: String(res.locals.requestId)
    });
    return;
  }

  const headers = forwardHeaders(req, res);
  // The multipart boundary travels in here. Lose it and the agent cannot parse the body.
  const contentType = req.header('content-type');
  if (contentType) headers['content-type'] = contentType;

  try {
    const upstream = await fetch(`${env.agentUrl}${req.originalUrl}`, {
      method: req.method,
      headers,
      // A Node Readable is an async iterable, which is what undici wants for a streamed
      // body; the DOM types this fetch is checked against only know about web streams.
      body: req as unknown as RequestInit['body'],
      duplex: 'half',
      signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS)
    } as RequestInit & { duplex: 'half' });
    await relay(upstream, res);
  } catch (err) {
    next(upstreamError(req, err));
  }
};
