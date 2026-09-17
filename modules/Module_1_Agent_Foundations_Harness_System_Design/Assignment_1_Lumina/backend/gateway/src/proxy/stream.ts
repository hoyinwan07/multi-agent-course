/**
 * SSE pass-through — the one place in this service where a bug is invisible.
 *
 * The rule is: **pipe bytes.** This file never parses a frame, never buffers one, never
 * reassembles the answer. Everything it would learn by parsing, it does not need, and
 * every millisecond it spends parsing is a millisecond of TTFT. A gateway that collected
 * the stream and forwarded it at the end would pass every functional test in the suite and
 * fail the SLA for a reason no profiler points at.
 *
 * Three ways this goes wrong, all of them silent (§11.2):
 *   1. parsing or re-serialising frames — latency, and a chance to corrupt what we relay
 *   2. `compression()` in front of this route — it buffers; tokens arrive in one burst
 *   3. a proxy holding the stream — answered by `X-Accel-Buffering: no` in `sseHeaders()`
 */
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { REQUEST_HEADER, USER_HEADER } from '@lumina/contract';
import { env } from '../env.js';
import { sseHeaders, sseSend } from '../sse.js';

/**
 * Past the widest gear's wall clock (deep: 240s) with room for the agent to finish and
 * close. This is a backstop against a hung upstream, not a policy — the caps that shape a
 * run live in the agent, next to what they bound.
 */
const UPSTREAM_TIMEOUT_MS = 300_000;

/** Write one chunk, waiting for drain if the socket is full. A slow reader must not be dropped. */
function write(res: Response, chunk: Uint8Array): Promise<void> {
  if (res.write(Buffer.from(chunk))) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const settle = (): void => {
      res.off('drain', settle);
      res.off('close', settle);
      resolve();
    };
    // Both, because a client that hangs up while we are waiting for drain will never
    // send one, and awaiting a `drain` that cannot arrive is a leaked request forever.
    res.once('drain', settle);
    res.once('close', settle);
  });
}

export const proxyStream: RequestHandler = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  const abort = new AbortController();

  // `res.on('close')`, NOT `req.on('close')` — the same trap the agent hit, and TECHSPEC
  // §11.2, which says `req`, is stale on this point. `express.json()` drains the POST body,
  // which destroys the request stream and fires req's `close` while the client is still
  // sitting there waiting. MEASURED at this gateway, not inherited on trust: req closed at
  // 19ms and 8ms on two runs, against a response that closed at 508ms and 3986ms. On `req`
  // we would abort every run about 15ms in and report a working agent as an upstream
  // failure. The response's `close` is the one that means the client actually went away.
  res.on('close', () => {
    // A normal end closes the response too; only an early close is a disconnect.
    if (!res.writableEnded) abort.abort(new Error('client disconnected'));
  });

  // A hung agent must not hold a socket open forever. Cleared as soon as we have a
  // response, so a legitimately long deep run is never cut off mid-answer.
  const timeout = setTimeout(() => abort.abort(new Error('agent timed out')), UPSTREAM_TIMEOUT_MS);

  let upstream: globalThis.Response;
  try {
    upstream = await fetch(`${env.agentUrl}${req.originalUrl}`, {
      method: 'POST',
      headers: {
        [USER_HEADER]: String(res.locals.userId ?? ''),
        [REQUEST_HEADER]: String(res.locals.requestId),
        'content-type': 'application/json',
        accept: 'text/event-stream'
      },
      body: JSON.stringify(req.body ?? {}),
      signal: abort.signal
    });
  } catch (err) {
    clearTimeout(timeout);
    // Nothing has been written, so this is still an ordinary HTTP failure: the error
    // handler answers 502. A client that hung up gets nothing, which is what it asked for.
    if (res.writableEnded || res.destroyed) return;
    next(
      new Error(
        `agent POST ${req.path} failed: ${err instanceof Error ? err.message : String(err)}`
      )
    );
    return;
  }
  clearTimeout(timeout);

  const contentType = upstream.headers.get('content-type') ?? '';

  // A 404 for an unknown thread, a 400 for a bad body, a 429 from the deep cap: the agent
  // answers those BEFORE it opens a stream, and they must reach the client as statuses.
  // Once one byte of a 200 stream is on the wire the status is 200 forever, and a 404
  // delivered as an SSE frame inside a 200 is a 404 no HTTP client can see.
  if (!upstream.ok || !upstream.body || !contentType.includes('text/event-stream')) {
    const text = await upstream.text().catch(() => '');
    if (contentType) res.setHeader('Content-Type', contentType);
    res.status(upstream.status).send(text);
    return;
  }

  sseHeaders(res);

  const reader = upstream.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (res.writableEnded || res.destroyed) break;
      if (value) await write(res, value);
    }
  } catch (err) {
    // We are past the headers, so 502 is no longer available: the status went out as 200
    // with the first byte. The contract's `error` event is how a stream says it failed, and
    // saying nothing would leave the client showing a half answer as if it were finished.
    if (!res.writableEnded && !res.destroyed && !abort.signal.aborted) {
      sseSend(res, 'error', {
        status: 502,
        error: `stream from the agent failed: ${err instanceof Error ? err.message : String(err)}`
      });
    }
  } finally {
    // Best effort: the client may already be gone, and cancelling a reader on a dead
    // socket must not become the error that replaces the real one.
    await reader.cancel().catch(() => undefined);
    if (!res.writableEnded) res.end();
  }
};
