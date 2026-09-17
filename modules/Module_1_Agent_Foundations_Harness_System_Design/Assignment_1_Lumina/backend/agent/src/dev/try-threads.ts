/**
 * Dev harness for threads + messages (TECHSPEC §14 step 8). Not on any route.
 *
 *   npx tsx src/dev/try-threads.ts --unit     buildHistory only; no server, no spend
 *   npx tsx src/dev/try-threads.ts            the whole thing against a live agent on :8000
 *
 * The live half asks two real questions and costs real money, so the part that is easy to
 * get wrong — the pairing, the alternation, the citation stripping — is a unit check that
 * runs in milliseconds for free. What the live half proves is the one thing a unit check
 * cannot: that a pronoun in the second question resolves to the subject of the first.
 */
import type { MessageDoc } from '@lumina/contract';
import { buildHistory, HISTORY_EXCHANGES, stripCitations } from '../loop/history.js';

const BASE = process.env.AGENT_URL ?? 'http://localhost:8000';
const USER = process.env.DEV_USER_ID ?? 'dev_step8';

let failed = 0;

function check(name: string, ok: boolean, detail?: string): void {
  if (ok) {
    console.log(`  ok   ${name}`);
    return;
  }
  failed += 1;
  console.log(`  FAIL ${name}${detail ? `\n         ${detail}` : ''}`);
}

// ---------------------------------------------------------------- unit: buildHistory

const msg = (role: 'user' | 'assistant', content: string, at: number): MessageDoc => ({
  _id: `${role}_${at}`,
  threadId: 'thr_unit',
  userId: USER,
  role,
  content,
  sources: [],
  createdAt: new Date(at).toISOString()
});

function unit(): void {
  console.log('buildHistory');

  const roles = (h: ReturnType<typeof buildHistory>) => h.map((m) => m.role).join(',');
  const texts = (h: ReturnType<typeof buildHistory>) =>
    h.map((m) => (m.role === 'tool' ? '' : m.text));

  check('empty thread yields no turns', buildHistory([]).length === 0);

  const one = buildHistory([msg('user', 'what is MCP?', 1), msg('assistant', 'A protocol [1].', 2)]);
  check('one exchange becomes user,assistant', roles(one) === 'user,assistant', roles(one));
  check('citation markers are stripped', texts(one)[1] === 'A protocol.', JSON.stringify(texts(one)[1]));

  // The dangling turn a failed run leaves behind. Pairing it with the NEXT answer would
  // attribute somebody else's answer to it; leaving it in place would send the API a
  // `user, user` sequence, which it rejects.
  const dangling = buildHistory([
    msg('user', 'the run that died', 1),
    msg('user', 'the run that worked', 2),
    msg('assistant', 'an answer', 3)
  ]);
  check('an unanswered question is dropped', roles(dangling) === 'user,assistant', roles(dangling));
  check('…and it is the ANSWERED question that survives', texts(dangling)[0] === 'the run that worked');

  // An assistant row with no question in range (the transcript window cut it off).
  const orphan = buildHistory([msg('assistant', 'answer to nothing', 1)]);
  check('an orphan answer is dropped', orphan.length === 0, roles(orphan));

  const many: MessageDoc[] = [];
  for (let i = 1; i <= 5; i++) {
    many.push(msg('user', `question ${i}`, i * 10), msg('assistant', `answer ${i}`, i * 10 + 1));
  }
  const capped = buildHistory(many);
  check(`bounded to ${HISTORY_EXCHANGES} exchanges`, capped.length === HISTORY_EXCHANGES * 2, `${capped.length} turns`);
  check('…keeping the MOST RECENT ones', texts(capped)[0] === 'question 4', String(texts(capped)[0]));
  check('always starts with user, ends with assistant', roles(capped).startsWith('user') && roles(capped).endsWith('assistant'));
  check(
    'roles strictly alternate',
    capped.every((m, i) => m.role === (i % 2 === 0 ? 'user' : 'assistant')),
    roles(capped)
  );

  check('stripCitations closes the gap it leaves', stripCitations('Rust is fast [1]. Go is simple [2].') === 'Rust is fast. Go is simple.');
  check('stripCitations leaves bracketed prose alone', stripCitations('the spec [see §4] is [1] clear') === 'the spec [see §4] is clear');

  const empty = buildHistory([msg('user', '  ', 1), msg('assistant', '[1]', 2)]);
  check('a turn emptied by stripping is still a turn', empty.length === 2 && empty.every((m) => m.role !== 'tool' && m.text.length > 0));
}

// ---------------------------------------------------------------- live: the routes

type Answered = { sources: { n: number; title: string }[]; text: string; done: unknown; error: unknown };

async function ask(threadId: string, query: string): Promise<Answered> {
  const res = await fetch(`${BASE}/threads/${threadId}/ask`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-user-id': USER },
    body: JSON.stringify({ query })
  });
  if (!res.ok || !res.body) throw new Error(`ask → ${res.status} ${await res.text()}`);

  const out: Answered = { sources: [], text: '', done: null, error: null };
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    // SSE frames are separated by a blank line; a chunk can hold several or half of one.
    const frames = buf.split('\n\n');
    buf = frames.pop() ?? '';
    for (const frame of frames) {
      const event = /^event: (.+)$/m.exec(frame)?.[1];
      const data = /^data: (.+)$/m.exec(frame)?.[1];
      if (!event || !data) continue;
      const parsed: unknown = JSON.parse(data);
      if (event === 'sources') out.sources = parsed as Answered['sources'];
      else if (event === 'token') out.text += (parsed as { text: string }).text;
      else if (event === 'done') out.done = parsed;
      else if (event === 'error') out.error = parsed;
    }
  }
  return out;
}

async function status(path: string, init?: RequestInit): Promise<number> {
  const res = await fetch(`${BASE}${path}`, init);
  await res.text();
  return res.status;
}

async function live(): Promise<void> {
  console.log('\nroutes');

  check('401 without x-user-id', (await status('/threads', { method: 'POST' })) === 401);
  check('404 asking on a thread that does not exist', (await status('/threads/thr_nope/ask', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-user-id': USER },
    body: JSON.stringify({ query: 'hello' })
  })) === 404);
  check('404 reading a thread that does not exist', (await status('/threads/thr_nope', { headers: { 'x-user-id': USER } })) === 404);
  check('404 on an id that is not a thread id at all', (await status('/threads/garbage', { headers: { 'x-user-id': USER } })) === 404);

  const created = await fetch(`${BASE}/threads`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-user-id': USER },
    body: '{}'
  });
  const { threadId } = (await created.json()) as { threadId: string };
  check('POST /threads returns 201', created.status === 201, `got ${created.status}`);
  check('…with a thr_ id', /^thr_[A-Za-z0-9_-]+$/.test(threadId ?? ''), String(threadId));

  check("404 for another user's thread", (await status(`/threads/${threadId}`, { headers: { 'x-user-id': 'someone_else' } })) === 404);

  const fresh = await (await fetch(`${BASE}/threads/${threadId}`, { headers: { 'x-user-id': USER } })).json();
  check('a new thread has no messages', (fresh as { messages: unknown[] }).messages.length === 0);

  console.log('\nthe follow-up (two real answers — this costs money)');

  const q1 = 'What is the Model Context Protocol?';
  const a1 = await ask(threadId, q1);
  check('first answer streamed', a1.text.length > 0 && a1.error === null, JSON.stringify(a1.error));

  // THE VERIFICATION. "it" has no referent in this string; the only way to search for the
  // right thing is to have read the previous turn.
  const q2 = 'Who created it, and when?';
  const a2 = await ask(threadId, q2);
  check('follow-up streamed', a2.text.length > 0 && a2.error === null, JSON.stringify(a2.error));

  const resolved = /anthropic/i.test(a2.text) || /model context protocol|\bMCP\b/i.test(a2.text);
  check('the pronoun resolved — the follow-up is about MCP, not about nothing', resolved, `answer: ${a2.text.slice(0, 200)}…`);
  check('the follow-up retrieved its own sources', a2.sources.length > 0);
  check(
    'the follow-up did not reuse the first answer’s numbering',
    a2.sources.every((s) => s.n >= 1) && new Set(a2.sources.map((s) => s.n)).size === a2.sources.length
  );

  const thread = (await (await fetch(`${BASE}/threads/${threadId}`, { headers: { 'x-user-id': USER } })).json()) as {
    title?: string;
    messages: { role: string; content: string; sources?: unknown[]; answerId?: string; done?: unknown }[];
  };

  check('the transcript holds both exchanges', thread.messages.length === 4, `${thread.messages.length} messages`);
  check('…in order, alternating', thread.messages.map((m) => m.role).join(',') === 'user,assistant,user,assistant');
  check('…with the questions as asked', thread.messages[0]?.content === q1 && thread.messages[2]?.content === q2);
  check('…and the answers carry their sources', (thread.messages[1]?.sources?.length ?? 0) > 0);
  check('…and their done event', Boolean(thread.messages[1]?.done) && Boolean(thread.messages[1]?.answerId));
  check('the thread was named after its first question', thread.title === q1.slice(0, 80), String(thread.title));

  const list = (await (await fetch(`${BASE}/threads`, { headers: { 'x-user-id': USER } })).json()) as {
    threads: { threadId: string; title: string }[];
  };
  check('GET /threads lists it', list.threads.some((t) => t.threadId === threadId));
  check("…and not to another user",
    !((await (await fetch(`${BASE}/threads`, { headers: { 'x-user-id': 'someone_else' } })).json()) as typeof list).threads.some(
      (t) => t.threadId === threadId
    )
  );

  console.log(`\nthread: ${threadId}`);
  console.log(`Q1 ${q1}\nA1 ${a1.text.slice(0, 160)}…`);
  console.log(`Q2 ${q2}\nA2 ${a2.text.slice(0, 300)}…`);
}

const unitOnly = process.argv.includes('--unit');

unit();
(unitOnly ? Promise.resolve() : live())
  .catch((e: unknown) => {
    failed += 1;
    console.log(`\n  FAIL harness threw: ${e instanceof Error ? e.message : String(e)}`);
  })
  .finally(() => {
    console.log(failed ? `\n${failed} failed` : '\nall passed');
    process.exit(failed ? 1 : 0);
  });
