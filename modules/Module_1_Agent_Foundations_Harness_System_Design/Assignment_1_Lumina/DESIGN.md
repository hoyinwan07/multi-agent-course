# DESIGN.md — LUMINA

Initial process to come up with the DESIGN.md:
1) Brainstormed and finalized PRD Brief (this is the documentto explain WHAT & WHY we are building this)
2) Brainstormed and created a Tech Spec (TECHSPEC.md) off (this is the technical document that explains HOW we are building this)
3) Wrote this DESIGN.md file based on the Tech Spec to map and answer the DESIGN.md 

Implementation detail lives in `TECHSPEC.md`; this document is the five decisions and what each one cost.*

*Status honesty: everything below encapsulates the system architecture designed and built
across both weeks. Deep search, document RAG, and the jobs worker were added during Week 2
and are now built, verified, and committed — not a future promise. Those items are still
marked `[W2]` so the reader can tell which decisions were made later, with Week 1 already
running in production, but the tag no longer means "not built yet.."*

## Components

The following table describes seven entites that carry state or make decisions for LUMINA. 
Two are processes. The other five are not processes, but contribute to the logic and behavior of LUMINA.

| Component | Where it runs | What it is |
|---|---|---|
| **Web UI** | Vercel (prod) - Vite dev server :5173 | Already provided in this repo with React. Used as an acceptance test. |
| **Gateway** | Fly.io, public - :8787 (the edge) | Express. This is only process / entity the browser can reach. No provider keys are held here and it never imports the MongoDB driver. |
| **Agent service** | Fly.io, **private networking only** - :8000 |  Express. This is the layer where the agent loop, its tools, memory, retrieval, run logs live. The only process that reads a provider key. It is not publicly routable — the deep-search spend cap (`DEEP_DAILY_CAP`, checked in `http/threads.routes.ts` before any retrieval starts) is enforced here. A cap you can bypass by calling the service directly is not a cap. |
| **The loop** | (Agent Service) - in-process, per request | Two phases: a bounded retrieval loop with tools enabled, then a streaming synthesis call with tools disabled. Not a framework. It owns the decision of when to stop and why. |
| **Evidence store** | (Agent Service) - in-process, per request, never persisted as-is | The set of things actually retrieved during one request. It is the **only** citable universe. If it is not in this array it cannot become an `[n]`. Its distillation (title, url, snippet) is persisted on the message; the full page text is discarded when the request ends.|
| **Search cache** | (Agent Service) two tiers: an in-process LRU, and the `searchCache` collection with a TTL index | Pure cache. Deleting it costs money and latency and loses no information. A result is only cached if it clears `MIN_CACHEABLE_HITS` (2) a thin, near-empty result is never cached, so a later identical query gets a fresh attempt instead of being locked into a bad or stale answer. |
| **Run logs** | (Agent Service) - `runs/<requestId>.json` on disk **and** the `runs` collection | One record per answer: tokens, wall clock, cost, termination reason, ordered tool calls. Every automated gate reads these. |
| **MongoDB Atlas** | Atlas M0, external to both services | One database, named: `lumina`. Houses the threads, messages, memories and their vector index, the cache, request and run logs. `[W2]` implemented spaces, documents, chunks with vector + text indexes, jobs, GridFS. |

Two components that a component diagram usually omits, and I am naming because they make
decisions for this application:
- **tool registry** - (Agent Service) decides which tools a given gear is even allowed to see
- **`evidence/merge.ts`** - (Agent Service) the single function through which every source must 
pass to be deduped and numbered. Both exist so that Week 2 is a change of arguments rather than
a change of structure.

## Responsibilities

The following are the exclusions:

1. **Only the agent service reads a provider key.** The gateway's `env.ts` does NOT parse one. This
is not stylistic: it means a gateway compromise, a gateway log leak, or a gateway misconfiguration
cannot expose an Anthropic, Tavily, or OpenAI credential, and the browser is two layers away from
anything secret.

2. **Only the gateway talks to the browser.** It owns CORS, the `X-User-Id` check, request-id
generation, zod validation of inbound bodies, per-user rate limiting, and serving the built UI. It
owns no product logic regardless. It can't answer a question, and it does not have context on what a
citation is.

3. **The gateway validates request bodies and nothing else.** It parses inbound bodies with the
contract's own zod schemas and answers `400` (BAD REQUEST)with the field name, because a malformed
body is knowable without asking anyone. It deliberately does **not** validate path ids. 
`GET /threads/thr_nope` must answer `404` (NOT FOUND), and a gateway that checked the *shape* of an id
would convert "no such thread" into "bad request" for every id the regex happened to dislike. Whether
a thing exists is a question only the service holding the data can answer, so the whole question goes
there and with it, the choice of `404` (NOT FOUND) over `403` (FORBIDDEN), which is the agent's decision
to make and which the gateway relays without an opinion.

4. **Exactly one status is created at the edge: `502` (API Exceptions).** Every other code the client sees: `400` from
validation and `401` from the user check aside, is the agent's own, relayed untouched, including
the `501`s for routes it has not built yet. The gateway no longer owns a stub list, so the UI's
"not implemented" state now reflects what the agent can actually do rather than what the edge was
told to claim, and the two cannot drift apart.

5. **`/evals/report.json` is served off disk, not proxied.** It belongs to neither service: the eval
tooling writes it from real bench and quality runs, and every number in it is a measurement. The
code does not read it and system logic does not use this, and when it does not exist the route will
result in a `404` instead of returning an empty object for the UI to render as a product that scored
zero. It is also one of the two routes that does not require `X-User-Id`, because the grader's tooling
pulls it with no header.

6. **Only the agent service decides that a run is over.** Caps are read from configuration in one
place (`loop/gear.ts`) and enforced in one place (`loop/run.ts`), which is also the only code that
sets `terminated`. Every automated gate reads that field, so only one function is allowed to
write it.

7. **Only `repo/` touches a collection.** No route handler, tool, or loop file imports the `mongodb`
driver. A `$vectorSearch` pipeline in a route handler is how the data layer becomes unswappable
and untestable.

8. **Only `evidence/merge.ts` creates a numbered source list.** Nothing else can emit a `sources`
event or assign an `n`. This is the invariant that makes "grounded or nothing" enforceable by
structure.

9. **Only the model decides what is worth remembering.** `save_memory` is called by the model, never
inferred by my code from a heuristic, because the requirement is that stable facts and preferences
are saved and single-answer trivia is not — a judgement that needs the conversation. Recall is the
deliberate exception (see Trade-offs).

10. **No code logic upgrades a request's depth.** `depth` arrives from the client (defaulted to `quick`)
and is reported back in `done` as the gear that actually ran. `[W2]` There is no server-side path
escalates a quick request into a deep one; a product that escalates itself is a product with an unbounded
bill. Verified in the built code: `depth` is read once from the request body in `http/threads.routes.ts`
and is never rewritten anywhere in the deep-search path.

## Communication

Based on the Architecture from the existing TECHNICAL.md, the following is the list of communications
and relations between the Components.

**1. Browser -> Gateway: HTTP, plus SSE for the one streaming route.** JSON everywhere else. The
gateway generates an `X-Request-Id` if the caller did not send one and returns it on the response.
*If the gateway is down:* the UI cannot function at all. This is a hard dependency and there is no
offline mode. This is acceptable because the gateway holds no state and is trivially restartable.

**2. Gateway -> Agent service: HTTP over Fly private networking, carrying the same contract shapes,
with `X-User-Id` and `X-Request-Id` forwarded verbatim.** The ask route is a **byte-level
pass-through**: the gateway pumps the upstream response body to the client without parsing,
buffering, or compressing it. Parsing it would mean re-serializing every frame and would make a
JSON round trip on the critical path of a latency target (measured in milliseconds); compressing it
would buffer the stream and make every token arrive at once, which reads as a slow model and fails
a time-to-first-token target for a reason no profiler will show me. *If the agent service is down:*
the gateway returns `502` and never a `200` - including mid-stream, where it emits an `error` event
and ends the stream, because once headers are sent the status code is no longer available to tell
the truth with. `/health` reports the agent's status nested rather than pretending to be healthy.
Measured cost of the hop, on a real answer: 56ms between the agent's own `ttftMs` and the moment
the client had the first token in hand.

**3. A closed tab has to stop the spending** When the browser hangs up, the gateway aborts its
upstream `fetch` call. The agent will see its own response close and the run stops paying an LLM
for an answer where the session is already closed (and assuming the user will never read it).
For which event to listen for: on a POST, `express.json()` drains the request stream to parse the
body, which destroys it and fires the request's `close` almost immediately. I measured 19ms and
8ms on two runs, against responses that closed at 508ms and 3986ms. So listening on the request would
therefore abort every run about 15ms in and report a perfectly healthy agent as an upstream failure:
a bug that presents as "the model is broken" and lives nowhere near the model.
The response's `close` is the assumption that the client has left. Both services listen on
the response, and I verified it through this logic rather than letting the LLM continue answering.

**4. Agent service -> MongoDB: the driver.** *If Mongo is down:* `/health` reports `db: "down"` and
degrades. So if it can't read its thread, it fails with a `502` instead of answering without context.
Because an answer silently missing its conversation history is worse than no answer at all.
TODO / FOLLOW UP SUGGESTION: we can add a user-friendly message that explains more in depth about this.

**5. Agent service -> providers (Anthropic, Tavily/SerpApi, OpenAI): HTTPS, with per-call timeouts.**
This is the boundary where the failure taxonomy matters most and I split it deliberately:
1. A **tool-level** failure: a page returns 403 (FORBIDDEN), a fetch times out, extraction yields nothing - is
caught by the tool wrapper, surfaces as a `trace` step with `ok: false` and a non-empty error
string, is returned to the model *as an error*, and the loop continues with what it has. 
2. A **provider-level** failure: when the search API is down or the LLM SDK throws an error but it is not caught,
it ends the run with `terminated: "error"` and a `502` (Bad Gateway). The distinction is:
- a tool that ran and failed should persist as data that the model should see
- a provider that is down should end the run
No `catch` anywhere in this system returns:
- a synthesized answer
- an empty-but-successful stream
- or the string "I couldn't find anything" when the real cause was an exception.

**6. Worker -> jobs collection `[W2]`:** polling with an atomic `findOneAndUpdate` claim, and a sweeper
that returns rows whose `claimedAt` has gone stale. No Redis and no broker - the queue is a
collection, which is one fewer service to deploy and one fewer thing to be down.

## State

**AUTHORATIVE (and losing it loses information):** `threads`, `messages` (each with its sources
and its `done` envelope), and `memories` with their embeddings. 
`[W2]`: `spaces`, `documents`, `chunks`, and the GridFS uploads bucket. All have been built and committed.

**CACHE, and deleting it costs only money and latency:** the `searchCache` collection and the
in-process LRU in front of it. Nothing is ever reconstructed from the cache that could NOT be
re-fetched. I deliberately DO NOT CACHE ANSWERS. I only cache the search results so information is 
never served stale; two identical questions would cost two answers, but that is the correct trade
for a product with the purpose of actively providing trustworthy up-to-date truth.
```
EXAMPLE: Asking "What is the stock price for Nvidia today?" should reflect CURRENT market conditions.
A cached answer from yesterday would be stale and misleading, even if the question text is identical.
```

**EPHEMERAL per request, but never persisted whole:** the evidence store. Full page text is held only
for the life of one request. What survives is the distillation on the message document:
- title
- url
- selected snippet
Which are the only values that a citation needs to render on the UI, remain clickable and checkable
(redirects user to the actual source). Keeping every fetched page would multiply my storage by a 
large factor to preserve something that isn't being used in the system. In addition this data not 
being used, web pages, blogs and articles can be dynamic (always changing, moving, or even being
deleted) -making this cached information susceptible to being stale (no longer a reliable source of
truth).
```
EXAMPLE: Asking "What did OpenAI announce about GPT-5 in their blog?" will pull a page for the blog
on that day and time it was asked.
Then after a week, if OpenAI moves the page or appends edits with a new finding, the previous version
that was pulled last week becomes outdated.

*They even note in their documentation that they do not publish a separate blog post for every minor change.
```

**OBSERVABILITY is authoritative about history but not about the product:** `runs` (plus the
`runs/*.json` files) is written to; `requests` — named alongside it in TECHSPEC's file tree as the
other collection this aggregation pairs with — is NOT. No `repo/requests.ts` exists and nothing
imports `COLLECTIONS.requests`; this was a real Week 1 gap that surfaced only once `/stats` got
built in Week 2. Rather than build a whole request-logging path Week 1 skipped, `/stats` derives
every field it needs from `messages` instead: a `role:'user'` row is treated as a "request"
(persisted whether or not it produced an answer), a `role:'assistant'` row is an "answer," and its
stored `done` envelope (`ttftMs`, `costUsd`, `searchCached`, `depth`) is exactly the per-answer data
`/stats` needs, with nothing missing. `runs`/`RunLog` was the other candidate and was rejected: it
has no `searchCached` field at all, so it cannot answer `searchCacheHitRatePct`.

Logs tell you what happened in the past and are used for debugging, grading, and benchmarking. This
is NOT used for deciding what the current state of the product should do. Every run produces ONE
record, and this ONE record is written in two places because different environments need different
storage:
- 1x to `runs/<requestId>.json` because `quality/check.mjs` reads a folder (for testing and evaluating locally)
- 1x to a `runs` collection -on MongoDB (for testing and evaluating on other deployed instances or off of local)
The MongoDB handles idempotency: write is an upsert keyed on `<request_id>`, so a retried request
overwrites its own row to prevent creations of duplicate rows.
`/stats` is built, committed, and live (`GET /stats`, `http/stats.routes.ts`). Scoped by
`X-User-Id` and windowed to "today" as midnight UTC; matching how `createdAt` is always written.
It aggregates over `messages` (see above) rather than in-memory counters, so the numbers survive a
restart and reconcile with the logs, which the benchmark cross-checks (`statsReconciles`).
`deepDailyCap` in its response comes from configuration (`env.deepDailyCap`), not from data — it is
the ceiling, not a measurement.
```
EXAMPLE: If a request:
- took 1.2s
- used 4,000 LLM tokens
- cost $0.03 (plus search calls)
- ended with `terminated: "done"`

Every run produces ONE record, and this ONE record is saved to both:
- `runs/<requestId>.json` (the authority)
- the `runs` collection in MongoDB

This stored record in the `runs` collection is cross-checked by the benchmark; `/stats` itself is
aggregated from `messages`, not from `runs` — see above for why.
```

**CONSISTENCY is written but not always immediately readable.** Atlas Search indexes are eventually
consistent: a document that has been upserted is not necessarily searchable. In Week 1 this touches
only `memories`: a memory saved during one request may not be recallable microseconds later -but
it is harmless, because recall happens at the start of a subsequent request, by which time the
index has caught up. But the CAVEAT is: database write success and search visibility are two
different guarantees, and conflating them is exactly the kind of bug that looks fine in every
manual test and then fails silently in production.
`[W2]`: It stops being trivial for document chunks, where "upserted" being mistaken for
"searchable" would let me report a document as `indexed` that no query can find. **Built and
verified:** a **read-your-write** probe (`probeChunkIndexed()` in `repo/chunks.ts`). The worker
queries the vector index for a chunk it just wrote and only flips the document to `indexed` once
the index returns it. Status transitions are committed after the work succeeds, never before.
Verified against 4 gold-corpus files (2 PDF, 2 markdown): all four reached `indexed` correctly, and
`recall@5` went from untested to 3/3 on the smoke bench once this landed.

## Trade-offs
**1. Two hard phases instead of one interleaved loop.** The contract requires the `sources` event
to precede the first `token`, and grounding requires every snippet to be searchable in text and 
actually retrieved. This satisfies both structurally:
- Phase 1 retrieves with tools enabled and generates no prose; the evidence set is then frozen, 
numbered, and sent
- Phase 2 streams the answer with tools **disabled**. At the moment the first token exists, the 
citable universe is already closed and already in the client's hands, so an ungrounded citation 
is not merely discouraged, it is unreachable. 
**THE TRADEOFF: The agent cannot retrieve something BECAUSE of a gap it noticed while writing.** 
It would be reasonable to work around it, keep that capability, and enforce grounding by prompt and 
post-hoc validation (testing / evaluating after). Given that the ordering is contractual, I do 
not think this alternative is available or a reasonable approach.

**2. Snippet selection is through deterministic code, not the model's choice.** For each retrieved
page I score overlapping passages AGAINST the query and take the best-scoring one, verbatim. 
A model asked to quote a page paraphrases it, and a paraphrase fails a verbatim grounding check.
**THE TRADEOFF: precision.** My chip is "the most query-relevant passage from a page this answer used"
rather than "the sentence that proves claim 3", and sometimes those differ visibly. I took this
tradeoff because grounding is weighted more than snippet precision, which makes a judgement call
from the model less of a priority.

**3. A capped deep-search sub-question is reported as `cap`, never as `done` — and that is
correct, not a bug.** Each deep-search sub-question gets a fair fraction of the same 24-call
budget the whole run log is held to (`RESERVED_FOR_RECALL` + `perSubMax` in `loop/deep.ts`).
With 6 sub-questions, that fraction is tight — narrow enough that a sub-question can
legitimately exhaust its budget before the exit heuristic (`MIN_EVIDENCE_TO_EXIT_SUBQUESTION`)
is satisfied. When that happens the run's `terminated` field is honestly set to `"cap"`. It is
never set to `"done"`.
**THE TRADEOFF: this goes against the A2 rule in `quality/check.mjs`** ("every run ends with
`terminated='done'`"), which is more strict than the red line it backs (in `eval/rubric.json`:
*"no run that hit a cap reported as `terminated=done`"*).
The rule and the red line are checking different things:
- A2 flags any non-`done` ending
- The red line cares only about dishonest endings
The runs satisfy the red line's actual intent: every `cap`-terminated run is stated, and doesn't
claim any completion it didn't reach. I chose to keep `terminated:"cap"` honest rather than tune
the budget or the exit heuristic to make A2 pass, because bounded-and-honest (addressed in the PRD)
matters more here than a clean quality report. I think it's important to focus on the original vision
and value that the MVP product should bring to the user versus a better report (for now).
However, this would become a critical issue if it were hiding a real budget constraint behind a looser
exit threshold.

**3. `recall_memory` runs eagerly as step one; `save_memory` stays model-chosen.** Recall is a
single cost-effecient vector query whose result must be in the prompt before the model reasons at all,
so letting the model decide to call it would cost a full round trip on a critical path already tight
enough that turn count is a design constraint. It is still a registered tool: it emits a trace step and
counts against the cap, so it remains visible and bounded.
**THE TRADEOFF: agency.** The system recalls memory on requests that plainly did not need it, spending
tokens and risking a stale preference for an unrelated answer. My workaround to mitigate this risk is
by placing a cap on the injected memory rather than by making the call conditional. That way it will grab
the subset of the parts that are most related to answering the question and avoid leaking unrelated context
from the entirety of the memory.

**4. Rate limiting is an in-process map.** A `Map<userId, {count, windowStart}>` is correct and free
at one instance. At two instances, each instance gets its own window but the effective limit will now
silently double. And the limit does not fail loudly, but now the limit does not reflect the number I 
gave it. Which is the failure mode I have spent this whole document trying to design out everywhere else.
A Mongo-backed counter is perhaps thirty lines and removes this caveat entirely. I have kept the in-memory
version for Week 1 because it's only focused on a single instance and I would rather spend the time on
grounding. 
So for now, **the TRADEOFF** is that rate limit currently does not scale effectively for multiple instances.

**5. Deep search fans out over sub-questions rather than letting the model call `plan_research`
whenever it wants.** `plan_research.ts` is registered nowhere in `tools/registry.ts` and is
deliberately never called through it — its file header explains why in detail. The Must that
matters most for deep search is that the `plan` event ships before ANY retrieval starts; that
ordering has to be structural, not a matter of system-prompt wording a model might ignore. So
`loop/deep.ts` calls the LLM once, directly, with `tools:[planResearch]` and `toolChoice` forced,
before the retrieval loop exists at all — then fans out one ordinary `retrieve()` call per
sub-question with bounded concurrency (`SUBQUESTION_CONCURRENCY = 3`), each tagged with a fixed
`subQuestion` index passed as a parameter, never inferred from which fetch happened to occur near
which part of a shared conversation several turns later.
**THE TRADEOFF: two real bugs surfaced from choosing "forced tool call" over "just another
registered tool," and one design constraint became permanent.** (1) Under a forced `tool_choice`,
the model does not reliably return `subQuestions` as a native array — it serializes the whole tool
input to a JSON string and nests it one level deeper than the schema describes.
`extractSubQuestions()` in `loop/deep.ts` now handles all three shapes seen in practice (native
array, JSON-stringified array, JSON-stringified re-wrapped object) — `input_schema` is a hint to
the model, not something the API enforces on the response. (2) A sub-question's tool-call budget,
divided fairly from the same fixed 24-call ceiling `expectations.json` holds the whole run to, was
structurally too tight to ever exit cleanly: with 6 sub-questions each gets ~3 calls, but
`MIN_EVIDENCE_TO_EXIT` (3, tuned for quick's 8-call budget) needs 3 successful fetches to
auto-exit — a 3-call budget, one of which is the eager search that produces no evidence by itself,
can never produce that. Fixed with a lower `MIN_EVIDENCE_TO_EXIT_SUBQUESTION = 2`, reasoned as
acceptable because a sub-question is narrower than the question it was decomposed from. Even after
that fix, `terminated:'cap'` stays common at 6 sub-questions — one fetch 403 anywhere in a 3-call
budget has no slack to recover. I accept this as an honest consequence of dividing a fixed budget
across a wide plan, not a bug worth continuing to chase.

**6. `deep plan p95` misses the `<=4000ms` target, and I accepted that rather than attempting to fix.**
With no `maxTokens` set on the planning call, the model wrote verbose sub-questions and
one-paragraph reasons. 6 of those at Sonnet's generation speed measured ~9950ms in the first full
bench run.
Two changes made that brought it down: 
1. `PLAN_MAX_TOKENS = 900` as a safety ceiling (not the primary fix! But sized with headroom so a
compliant model's output shouldn't get cut off mid-JSON. `loop/deep.ts` also checks
`planReply.stopReason==='max_tokens'` and throws a specific readable error flagging `PLAN_MAX_TOKENS`
if a plan is ever actually truncated instead of displaying "0 usable sub-questions" -which can be
confusing to users).
2. A prompt change telling the model reasons must be "AT MOST TEN WORDS" and that the call is timed.
This is the real fix, since it reduces how much the model writes instead of just capping it.
**THE TRADEOFF:** the fix resulted in a ~35-45% improvement (9950ms down to a 4833-6494ms range across a
full bench run.) BUT now it doesn't satisfy the threshold for the 4000ms target, and I chose not to tweak it
further.
My thinking: reducing this metric more would likely mean either:
- cutting the 3-6 sub-question range
- dropping the reason field the plan UI shows the user
But both of these are priorities and explicitly stated requirements in the contract. Giving up either of these
means defying what the contract or the UX wants and I don't think this is the right tradeoff if it's for buying
back some time (in milliseconds). SATISFYING MVP REQUIREMENTS > TARGET THRESHOLD
**FINAL VERDICT:** Accepted as a known, documented risk rather than an open bug.

**7. Conversation history re-entering a prompt is stripped of citation markers first.**
`stripCitations()` (in `loop/history.ts`) runs before any prior turn's text is placed back into
context. A citation number like `[2]` only means something relative to the source list that was
frozen for THAT turn and would be carried unchanged into a new turn. And it can be a new turn with
a new, differently-numbered source list, so it silently points at the wrong thing and `citations.ts`
would still pass it. `unresolvedCitations()` would still return `[]`, the bench would score it as grounded,
and the citation would point at an unrelated page. I want to avoid designing something that **looks**
correct by every automated check but it is actually wrong / incorrect.
**THE TRADEOFF:** a small amount of visible provenance is lost from the history that the model sees
(it no longer sees which specific numbered source backed which claim in a prior turn) BUT in exchange
for this, we **never risk a silently-wrong citation**. The same logic that drives every other citation-related
decision in this document and is a launch-critical requirement to satisfy (based on my judgement).