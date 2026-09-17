/**
 * Thread routes: create, list, read, and ask.
 *
 * `404 unknown ids` is satisfied here and nowhere else. Every route looks the thread up by
 * `{_id, userId}`, so a thread that does not exist and a thread belonging to somebody else
 * give the same answer — 404, not 403. 403 would confirm the id exists, and a request that
 * cannot be served is not made servable by naming what it nearly reached.
 *
 * On `ask` the lookup happens BEFORE `sseHeaders()`. Once a byte is on the wire the status
 * is 200 forever, and a 404 delivered as an `error` event inside a 200 stream is a 404 no
 * HTTP client can see.
 */
import { Router, type Request, type Response } from 'express';
import {
  AskBody,
  CreateThreadBody,
  MessageDoc,
  newId,
  REQUEST_HEADER,
  ThreadId,
  type GetThreadResponse,
  type ListThreadsResponse,
  type ThreadDoc,
  type ThreadMessage
} from '@lumina/contract';
import { buildHistory, HISTORY_FETCH } from '../loop/history.js';
import { run, type RunOutcome } from '../loop/run.js';
import { emptySpend } from '../obs/cost.js';
import { logFor } from '../obs/log.js';
import { writeRunLog } from '../obs/runlog.js';
import { recentMessages, saveMessages } from '../repo/messages.js';
import { findThread, insertThread, listThreads, titleThreadIfUntitled } from '../repo/threads.js';
import { requireUser } from './auth.js';
import { SseEmitter, sseHeaders } from './sse.js';

export const threadsRouter: Router = Router();

/** The sidebar is a picker, not an archive. */
const THREAD_LIST_LIMIT = 50;

/** How much of a transcript `GET /threads/:id` renders. Well past any real conversation. */
const TRANSCRIPT_LIMIT = 200;

/** A thread named after its first question. Long enough to recognise, short enough to fit. */
const TITLE_CHARS = 80;

// ---------------------------------------------------------------- POST /threads

threadsRouter.post('/threads', async (req: Request, res: Response) => {
  const userId = requireUser(req, res);
  if (!userId) return;

  const body = CreateThreadBody.safeParse(req.body ?? {});
  if (!body.success) {
    res.status(400).json({ error: body.error.issues[0]?.message ?? 'invalid body', status: 400 });
    return;
  }

  const thread: ThreadDoc = {
    _id: newId('thr'),
    userId,
    // Empty means "not yet titled": the first ask fills it in from the question. The UI
    // creates threads with no title at all, so a thread named at creation time would be
    // named "New thread" forever.
    title: body.data.title?.trim() || '',
    createdAt: new Date().toISOString()
  };

  await insertThread(thread);
  // 201, per the contract. A created resource is not a 200.
  res.status(201).json({ threadId: thread._id });
});

// ---------------------------------------------------------------- GET /threads

threadsRouter.get('/threads', async (req: Request, res: Response) => {
  const userId = requireUser(req, res);
  if (!userId) return;

  const rows = await listThreads(userId, THREAD_LIST_LIMIT);
  const body: ListThreadsResponse = {
    threads: rows.map((t) => ({
      threadId: t._id,
      // The display fallback for a thread whose first question never landed. The stored
      // title stays empty, so `titleThreadIfUntitled` can still claim it later.
      title: t.title || 'New thread',
      createdAt: isoOf(t.createdAt)
    }))
  };
  res.json(body);
});

// ---------------------------------------------------------------- GET /threads/:threadId

threadsRouter.get('/threads/:threadId', async (req: Request, res: Response) => {
  const userId = requireUser(req, res);
  if (!userId) return;

  const threadId = ThreadId.safeParse(req.params.threadId);
  if (!threadId.success) {
    res.status(404).json({ error: `no thread ${req.params.threadId}`, status: 404 });
    return;
  }

  const [thread, messages] = await Promise.all([
    findThread(threadId.data, userId),
    recentMessages(threadId.data, TRANSCRIPT_LIMIT)
  ]);
  if (!thread) {
    res.status(404).json({ error: `no thread ${threadId.data}`, status: 404 });
    return;
  }

  const body: GetThreadResponse = {
    threadId: thread._id,
    title: thread.title || 'New thread',
    messages: messages.map(
      (m): ThreadMessage => ({
        role: m.role,
        content: m.content,
        sources: m.sources,
        ...(m.answerId ? { answerId: m.answerId } : {}),
        ...(m.done ? { done: m.done } : {}),
        createdAt: isoOf(m.createdAt)
      })
    )
  };
  res.json(body);
});

// ---------------------------------------------------------------- POST /threads/:id/ask

threadsRouter.post('/threads/:threadId/ask', async (req: Request, res: Response) => {
  const userId = requireUser(req, res);
  if (!userId) return;

  const threadId = ThreadId.safeParse(req.params.threadId);
  if (!threadId.success) {
    res.status(404).json({ error: `no thread ${req.params.threadId}`, status: 404 });
    return;
  }

  const body = AskBody.safeParse(req.body ?? {});
  if (!body.success) {
    res.status(400).json({ error: body.error.issues[0]?.message ?? 'invalid body', status: 400 });
    return;
  }

  // One round trip for both, because both are needed before the stream opens and neither
  // depends on the other. The lookup is what answers 404; the history read would otherwise
  // add a second Atlas round trip to the TTFT path for nothing.
  const [thread, priorMessages] = await Promise.all([
    findThread(threadId.data, userId),
    recentMessages(threadId.data, HISTORY_FETCH)
  ]);
  if (!thread) {
    res.status(404).json({ error: `no thread ${threadId.data}`, status: 404 });
    return;
  }

  const query = body.data.query;
  const history = buildHistory(priorMessages);

  const requestId = req.header(REQUEST_HEADER)?.trim() || `req_${Date.now().toString(36)}`;
  const log = logFor(requestId, userId);

  // Fire and forget, deliberately: naming the thread is a nicety for the sidebar and must
  // never sit in front of the first token. It is also idempotent and racing-safe — the
  // filter only matches an untitled thread, so of four concurrent asks exactly one wins.
  if (!thread.title) {
    titleThreadIfUntitled(threadId.data, userId, query.slice(0, TITLE_CHARS)).catch((e: unknown) =>
      log.warn({ err: e instanceof Error ? e.message : String(e) }, 'could not title the thread')
    );
  }

  // Abort the whole run when the client hangs up, so a closed tab stops paying providers.
  const abort = new AbortController();
  const startedAt = Date.now();
  const sse = new SseEmitter(res, startedAt);

  // `res.on('close')`, NOT `req.on('close')`. On a POST, express.json() drains the
  // request stream, which destroys it and fires req's 'close' within milliseconds — so
  // the run would abort itself before the first tool call and report a provider error.
  // The response's 'close' is the one that means the client actually went away.
  res.on('close', () => {
    if (!res.writableEnded) {
      log.info('client disconnected mid-stream');
      sse.markClosed();
      abort.abort();
    }
  });

  sseHeaders(res);

  // The client asks; the server never upgrades a request to deep on its own.
  const depth = body.data.depth ?? 'quick';
  let outcome: RunOutcome | null = null;

  try {
    outcome = await run({
      requestId,
      userId,
      threadId: threadId.data,
      query,
      depth,
      history,
      sse,
      signal: abort.signal
    });
  } catch (e) {
    // run() reports provider failures as an `error` event itself. Anything reaching here
    // is a bug in our code, and it still must not end as a silent truncated stream.
    log.error({ err: e instanceof Error ? e.message : String(e) }, 'unhandled error in ask');
    sse.emitError(500, e instanceof Error ? e.message : String(e));
  } finally {
    // BEFORE `sse.end()`, unlike the run log below, and the difference is the point: the
    // client treats the closed stream as "this turn is finished", and a client that
    // reloads the thread on that signal must not be shown a transcript missing the answer
    // it just watched arrive. Measured at ~40ms against a 12s p95 budget — the price of
    // read-your-write on your own turn, and worth it. `done.latencyMs` is already on the
    // wire by now, so the figure the client is scored on does not move.
    await persistExchange({ requestId, userId, threadId: threadId.data, query, startedAt, outcome, log });

    sse.end();

    // AFTER the stream is closed, and in a `finally` so that a crash mid-answer still
    // leaves a log behind (§10.1). `outcome` is null only when run() threw before it
    // could return one — which is a bug in our code, and the log says `error` because
    // that is what happened, not because we know why.
    await writeRunLog({
      requestId,
      userId,
      threadId: threadId.data,
      query,
      ...(outcome?.answerId ? { answerId: outcome.answerId } : {}),
      terminated: outcome?.terminated ?? 'error',
      depth: outcome?.depth ?? depth,
      toolCalls: outcome?.toolCalls ?? [],
      spend: outcome?.spend ?? emptySpend(),
      // Measured HERE, at stream close, rather than taken from the outcome: a log written
      // at the end of the loop is a log with the wrong wall clock, and a run that spent
      // four seconds failing to finish spent them (§10.1).
      wallClockSec: (Date.now() - startedAt) / 1000,
      log
    });
  }
});

// ---------------------------------------------------------------- persistence

type PersistArgs = {
  requestId: string;
  userId: string;
  threadId: string;
  query: string;
  startedAt: number;
  outcome: RunOutcome | null;
  log: ReturnType<typeof logFor>;
};

/**
 * Write the turn the thread just had, once the run is over and before the stream closes.
 *
 * Written after the run rather than before it for two reasons. The obvious one is that the
 * answer does not exist until the run does. The subtle one is that a user message written
 * up front would be read back as history by the run that is about to answer it.
 *
 * The question is stored even when the run failed: the thread should say what was asked
 * and show no answer, which is true, rather than lose the question, which is not.
 * `buildHistory` drops such a dangling turn rather than pairing it with somebody else's
 * answer, so it costs nothing on the next request.
 *
 * Timestamps come from the request's own start and finish, not from `now`, so four asks
 * racing down one thread still read back in the order they were asked.
 */
async function persistExchange(args: PersistArgs): Promise<void> {
  const { requestId, userId, threadId, query, startedAt, outcome, log } = args;

  const docs: MessageDoc[] = [
    {
      // The natural id, as everywhere else (§4.4): the user turn belongs to its request,
      // so a retried request rewrites its own row instead of asking the question twice.
      _id: `${requestId}_user`,
      threadId,
      userId,
      role: 'user',
      content: query,
      sources: [],
      createdAt: new Date(startedAt).toISOString()
    }
  ];

  // An answer the client never received is not a turn of the conversation. A run that
  // ended in `error` with nothing streamed leaves the question standing on its own.
  if (outcome && outcome.answerText.trim()) {
    docs.push({
      _id: outcome.answerId,
      threadId,
      userId,
      role: 'assistant',
      content: outcome.answerText,
      answerId: outcome.answerId,
      // The numbering the text's `[n]` refer to. Stored with the message because the two
      // are only meaningful together — this is what lets `GET /threads/:id` re-render a
      // past answer with working citation chips.
      sources: outcome.sources,
      ...(outcome.done ? { done: outcome.done } : {}),
      createdAt: new Date().toISOString()
    });
  }

  try {
    await saveMessages(docs);
  } catch (e) {
    // The answer was delivered and the run log is already written. Losing the transcript
    // row is bad, and it is said loudly, but it does not retroactively fail a good answer.
    log.error({ err: e instanceof Error ? e.message : String(e) }, 'answer delivered but not persisted');
  }
}

/** Stored as an ISO string; `z.date()` is in the contract's union, so accept one either way. */
const isoOf = (v: string | Date): string => (typeof v === 'string' ? v : v.toISOString());
