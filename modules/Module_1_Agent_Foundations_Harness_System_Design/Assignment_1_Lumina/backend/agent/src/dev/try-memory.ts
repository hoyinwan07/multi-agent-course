/**
 * Dev harness for memory (TECHSPEC §14 step 9). Not on any route.
 *
 *   npx tsx src/dev/try-memory.ts --routes   GET/DELETE /memory only; no LLM, no spend
 *   npx tsx src/dev/try-memory.ts            the whole scenario against a live agent on :8000
 *
 * The full run asks THREE real questions and costs real money, because the thing being
 * verified cannot be faked: the step-9 criterion is "a preference saved in thread A changes
 * the answer in thread B, and DELETE reverses it", and every clause of that is about the
 * text of a real answer.
 *
 * The preference is chosen so the check is arithmetic rather than taste. "Answer in French"
 * is visible in one regex; "be more concise" would need a judgement call about how concise
 * is concise, and a test that needs a judgement call is a test that passes when you want it
 * to. It is also deliberately UNRELATED to the question asked in thread B — that is the
 * whole point of a preference, and the reason `recall_memory` has no score threshold.
 *
 * Each run uses a fresh user id, so it never reads a preference an earlier run left behind
 * and never reports a pass it did not earn.
 */
const BASE = process.env.AGENT_URL ?? 'http://localhost:8000';
const USER = process.env.DEV_USER_ID ?? `dev_step9_${Date.now().toString(36)}`;

let failed = 0;

function check(name: string, ok: boolean, detail?: string): void {
  if (ok) {
    console.log(`  ok   ${name}`);
    return;
  }
  failed += 1;
  console.log(`  FAIL ${name}${detail ? `\n         ${detail}` : ''}`);
}

// ---------------------------------------------------------------- the SSE client

type TraceStep = { step: number; tool: string; ok: boolean; ms: number; reason?: string; error?: string };
type Done = { costUsd: number; ttftMs: number; latencyMs: number; terminated: string; tokens: { in: number; out: number } };
type Answered = {
  trace: TraceStep[];
  sources: { n: number; title: string }[];
  text: string;
  done: Done | null;
  error: unknown;
};

async function ask(threadId: string, query: string, userId = USER): Promise<Answered> {
  const res = await fetch(`${BASE}/threads/${threadId}/ask`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-user-id': userId },
    body: JSON.stringify({ query })
  });
  if (!res.ok || !res.body) throw new Error(`ask → ${res.status} ${await res.text()}`);

  const out: Answered = { trace: [], sources: [], text: '', done: null, error: null };
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const frames = buf.split('\n\n');
    buf = frames.pop() ?? '';
    for (const frame of frames) {
      const event = /^event: (.+)$/m.exec(frame)?.[1];
      const data = /^data: (.+)$/m.exec(frame)?.[1];
      if (!event || !data) continue;
      const parsed: unknown = JSON.parse(data);
      if (event === 'trace') out.trace.push(parsed as TraceStep);
      else if (event === 'sources') out.sources = parsed as Answered['sources'];
      else if (event === 'token') out.text += (parsed as { text: string }).text;
      else if (event === 'done') out.done = parsed as Done;
      else if (event === 'error') out.error = parsed;
    }
  }
  return out;
}

type MemoryRow = { id: string; text: string; sourceThread?: string; createdAt: string };

async function listMemory(userId = USER): Promise<MemoryRow[]> {
  const res = await fetch(`${BASE}/memory`, { headers: { 'x-user-id': userId } });
  if (!res.ok) throw new Error(`GET /memory → ${res.status} ${await res.text()}`);
  return ((await res.json()) as { memories: MemoryRow[] }).memories;
}

async function newThread(userId = USER): Promise<string> {
  const res = await fetch(`${BASE}/threads`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-user-id': userId },
    body: '{}'
  });
  return ((await res.json()) as { threadId: string }).threadId;
}

async function status(path: string, init?: RequestInit): Promise<number> {
  const res = await fetch(`${BASE}${path}`, init);
  await res.text();
  return res.status;
}

// ---------------------------------------------------------------- the routes, free

async function routes(): Promise<void> {
  console.log('routes');

  check('401 listing memory without x-user-id', (await status('/memory')) === 401);
  check(
    '401 deleting memory without x-user-id',
    (await status('/memory/mem_whatever', { method: 'DELETE' })) === 401
  );
  check(
    '404 deleting a memory that does not exist',
    (await status('/memory/mem_nope', { method: 'DELETE', headers: { 'x-user-id': USER } })) === 404
  );

  const mine = await listMemory();
  check('a fresh user has no memories', mine.length === 0, `${mine.length} rows`);
}

// ---------------------------------------------------------------- the scenario, live

const PREF = 'Always answer in French, whatever language the question is asked in.';
const QUESTION = 'What is the capital of Portugal?';

/** French markers that are not also English words. Cheap, and it does not need to be clever. */
const FRENCH = /\b(est|la capitale|située|le Portugal|selon|également|qui|pays|ville)\b/i;

async function live(): Promise<void> {
  console.log('\nthread A — saving the preference (a real run; this costs money)');

  const threadA = await newThread();
  const a = await ask(threadA, `Please remember this for all future answers: ${PREF}`);
  check('thread A streamed an answer', a.text.length > 0 && a.error === null, JSON.stringify(a.error));

  const saveStep = a.trace.find((t) => t.tool === 'save_memory');
  check('the trace shows save_memory', Boolean(saveStep) && saveStep?.ok === true, JSON.stringify(a.trace.map((t) => t.tool)));

  const afterSave = await listMemory();
  check('GET /memory lists the new row', afterSave.length === 1, `${afterSave.length} rows`);
  const row = afterSave[0];
  check('…and it holds the preference', Boolean(row) && /french/i.test(row?.text ?? ''), row?.text);
  check('…with its source thread, for provenance', row?.sourceThread === threadA, String(row?.sourceThread));
  check(
    '…and the answer confirms rather than refusing',
    !/cannot answer|no sources/i.test(a.text),
    a.text.slice(0, 200)
  );

  // The run that should have been cheap: no fetches, because no question was asked.
  const fetchesA = a.trace.filter((t) => t.tool === 'fetch_page').length;
  check('a save-only request did not go fetching pages', fetchesA === 0, `${fetchesA} fetch_page calls`);

  console.log('\nthread B — a DIFFERENT thread, an UNRELATED question');

  const threadB = await newThread();
  const b = await ask(threadB, QUESTION);
  check('thread B streamed an answer', b.text.length > 0 && b.error === null, JSON.stringify(b.error));

  const recallB = b.trace.find((t) => t.tool === 'recall_memory');
  check('the trace carries a recall_memory step', Boolean(recallB), JSON.stringify(b.trace.map((t) => t.tool)));
  check('…and it succeeded', recallB?.ok === true, recallB?.error);
  check('…and it found the memory', /recalled 1 memor/.test(recallB?.reason ?? ''), recallB?.reason);
  check('recall is step 1, before anything else', recallB?.step === 1, `step ${String(recallB?.step)}`);

  // THE VERIFICATION. The preference crossed a thread boundary and changed the writing.
  check('THE ANSWER IS IN FRENCH — the preference crossed threads', FRENCH.test(b.text), b.text.slice(0, 240));
  check('…and it is still a grounded answer, not just a preference', b.sources.length > 0, `${b.sources.length} sources`);

  // The memory must not have become citable. It is not in `sources`, so a marker pointing
  // at it is impossible by construction — this checks the construction held.
  const cited = [...b.text.matchAll(/\[(\d{1,3})\]/g)].map((m) => Number(m[1]));
  const maxN = b.sources.length;
  check(
    'every [n] resolves to a real source — the memory was never numbered',
    cited.every((n) => n >= 1 && n <= maxN),
    `cited ${JSON.stringify(cited)} against ${maxN} sources`
  );

  console.log('\nanother user — the same question, no memory');

  const stranger = `${USER}_stranger`;
  const c = await ask(await newThread(stranger), QUESTION, stranger);
  check('a different user gets no recall hit', /no stored memories/.test(
    c.trace.find((t) => t.tool === 'recall_memory')?.reason ?? ''
  ), c.trace.find((t) => t.tool === 'recall_memory')?.reason);
  check('…and their answer is NOT in French', !FRENCH.test(c.text), c.text.slice(0, 200));

  console.log('\nDELETE — and the effect has to disappear with the row');

  const del = await status(`/memory/${row?.id ?? 'mem_missing'}`, {
    method: 'DELETE',
    headers: { 'x-user-id': stranger }
  });
  check("404 deleting another user's memory", del === 404, `got ${del}`);

  check(
    'DELETE /memory/:id returns 204',
    (await status(`/memory/${row?.id ?? 'mem_missing'}`, { method: 'DELETE', headers: { 'x-user-id': USER } })) === 204
  );
  check('GET /memory no longer lists it', (await listMemory()).length === 0);

  const threadC = await newThread();
  const d = await ask(threadC, QUESTION);
  check('thread C streamed an answer', d.text.length > 0 && d.error === null, JSON.stringify(d.error));
  check(
    'THE EFFECT IS GONE — a fresh thread is no longer in French',
    !FRENCH.test(d.text),
    d.text.slice(0, 240)
  );

  // ---- what it cost, because step 9 adds a mandatory call to every run ----
  console.log('\ncost of the eager recall');
  for (const [label, run] of [
    ['thread A (save only)', a],
    ['thread B (with memory)', b],
    ['thread C (memory deleted)', d]
  ] as const) {
    const recall = run.trace.find((t) => t.tool === 'recall_memory');
    console.log(
      `  ${label.padEnd(26)} $${run.done?.costUsd.toFixed(4) ?? '?'} · ttft ${run.done?.ttftMs ?? '?'}ms · ` +
        `${run.trace.length} trace steps · recall ${recall?.ms ?? '?'}ms · ${run.done?.terminated ?? '?'}`
    );
  }
  // The gate `bench.mjs:673` actually applies: it counts TRACE STEPS, not tool calls.
  const overflowing = [a, b, d].filter((r) => r.trace.length > 8);
  check('no run emitted more than 8 trace steps (the quick envelope)', overflowing.length === 0,
    `${overflowing.length} run(s) over: ${overflowing.map((r) => r.trace.length).join(', ')}`);

  console.log(`\nuser: ${USER}`);
  console.log(`B (memory live) ${b.text.slice(0, 220)}…`);
  console.log(`C (memory gone) ${d.text.slice(0, 220)}…`);
}

const routesOnly = process.argv.includes('--routes');

routes()
  .then(() => (routesOnly ? undefined : live()))
  .catch((e: unknown) => {
    failed += 1;
    console.log(`\n  FAIL harness threw: ${e instanceof Error ? e.message : String(e)}`);
  })
  .finally(() => {
    console.log(failed ? `\n${failed} failed` : '\nall passed');
    process.exit(failed ? 1 : 0);
  });
