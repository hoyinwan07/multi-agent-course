# LUMINA — session handoff (Week 1 BUILD COMPLETE, steps 1–11 done; next is the gate decision, then deploy)

## Working directory
`modules/Module_1_Agent_Foundations_Harness_System_Design/Assignment_1_Lumina/`

npm workspace root (`package.json` workspaces, `.env`, `runs/`). **Every path below is relative
to it.** Agent commands run from `backend/agent/`, gateway commands from `backend/gateway/`.

## Context
**Assignment 1: LUMINA**, FDE Agent Engineering Bootcamp cohort 2026-03. Due end of Week 2;
currently Week 1. Perplexity-style citation-grounded research agent, two Express services.
React UI + API contract are **provided and must not be edited**.

- `backend/gateway/` (:8787) — edge: CORS, `X-User-Id`, request ids, pino, zod, rate limit,
  SSE pass-through, serves `web/dist`. **No provider keys. COMPLETE (step 10).**
- `backend/agent/` (:8000) — the work: loop, tools, memory, RAG [W2], deep search [W2],
  jobs worker [W2], run logs. **Only process that reads a provider key. Steps 1–9 complete.**

**Do not edit:** `web/`, `packages/contract/`, `benchmark/`, `eval/`, `quality/`, `scripts/`.
Submission is a **deployed URL**, not code. Nothing committed yet.

## Document authority order (higher wins; if prose disagrees, prose is stale)
1. `packages/contract/src/` — executable zod schemas
2. `benchmark/sla.json`, `expectations.json`, `eval/rubric.json` — all thresholds
3. `AGENTS.md` → 4. `SPEC.md` → 5. `TECHSPEC.md`, `DESIGN.md` (mine)

## Environment state
- `.env` exists at the assignment root. Both services resolve `process.cwd()/../../.env`.
  Do NOT create `backend/agent/.env` or `backend/gateway/.env`.
- Keys present: `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `TAVILY_API_KEY`, `MONGODB_URI`.
  **`SERPAPI_API_KEY` still empty** — needed for the provider-swap test.
- Gateway vars already set: `PORT_GATEWAY=8787`, `AGENT_URL=http://localhost:8000`,
  `CORS_ORIGINS=http://localhost:5173`, **`RATE_LIMIT_PER_MINUTE=300`** (raised from 30 —
  findings 7 and 23; comment in `.env` says why). **Add the Vercel/Fly origins to
  `CORS_ORIGINS` before deploying** — the browser is blocked otherwise and the failure looks
  like a dead backend.
- **`@anthropic-ai/sdk` ^0.125.0 is declared in `backend/agent/package.json`** and the lockfile.
  It had silently vanished once (present only in `node_modules`, pruned by an `npm install`).
  If you see `Cannot find module '@anthropic-ai/sdk'`, re-run
  `npm i @anthropic-ai/sdk -w @lumina/agent`.
- `node scripts/create-indexes.mjs` **has been run** — all regular/TTL indexes plus the 3
  search indexes exist, including `memories_vector`.
- Both services may still be running (:8000 agent, :8787 gateway), plus Vite on :5173.
  **Do NOT use `pkill -f "tsx src/index.ts"` — it matches BOTH services** and will take down
  the agent when you meant the gateway. Use `lsof -ti:8787 | xargs kill` (or `:8000`).

## Build progress (TECHSPEC §14)
| # | Step | State |
|---|---|---|
| 1 | `DESIGN.md` | done (substantial additions owed — see "What I still owe") |
| 2 | providers + registry + 2 tools | done |
| 3 | Phase 1 loop + trace | done |
| 4 | evidence + snippet select + `sources` | done — grounding 27/27 = 100% |
| 5 | Phase 2 + `done` | done — `unresolvedCitations()` `[]` on every run |
| 6 | run log | done — `node quality/check.mjs .` → 0 errors |
| 7 | search cache | done — miss→hit verified, `searchCached` correct |
| 8 | threads + messages | done — 34/34 checks; the pronoun follow-up resolves |
| 9 | memory | **done — 27/27 checks; cross-thread recall + delete both verified live** |
| 10 | gateway | **done — 4/4 contract probes on :8787, UI streams live, disconnect verified** |
| 11 | failing trajectory | done — **already have one** in `runs/failing/` |

**Week 1's build sequence is finished.** What is left is not code: the cost/latency gate decision,
the `DESIGN.md` remainder, and the deploy + eval run that produces the actual submission.

## Files built (agent — all complete)
```
lib/          normalize.ts  tokens.ts  errors.ts
providers/    llm.ts  llm.anthropic.ts  search.ts  search.tavily.ts  search.serpapi.ts  embed.ts
tools/        types.ts  registry.ts  web_search.ts  fetch_page.ts  recall_memory.ts
              save_memory.ts  plan_research.ts (UNREGISTERED)
evidence/     store.ts  select.ts  merge.ts
cache/        searchCache.ts
repo/         runs.ts  searchCache.ts  threads.ts  messages.ts  memories.ts   <- ONLY files touching mongodb
loop/         gear.ts  prompts.ts  retrieve.ts  synthesize.ts  citations.ts  run.ts  history.ts
http/         sse.ts  auth.ts  threads.routes.ts  memory.routes.ts
obs/          log.ts  cost.ts  runlog.ts
dev/          try-tool.ts  check-grounding.ts  try-citations.ts  try-cache.ts  try-threads.ts
              try-memory.ts
index.ts      threadsRouter + memoryRouter mounted BEFORE the 501 loop
```

## Files built (gateway — step 10, all complete)
```
middleware/   requireUser.ts  validate.ts  rateLimit.ts
proxy/        json.ts (proxyJson + proxyUpload)  stream.ts (proxyStream)
index.ts      501 loop DELETED; every contract route wired; /evals/report.json served off disk
env.ts        + reportPath  (the only addition; everything else was already parsed)
sse.ts        [P] untouched — sseHeaders() + sseSend() used as provided
```
Chain, per §11.1: `cors → requestId → pino-http → requireUser → validate → rateLimit → proxy`.

## Verified commands
```bash
npm run -w @lumina/agent typecheck && npx eslint backend/agent/src --max-warnings 0
cd backend/agent && nohup npx tsx src/index.ts > /tmp/lumina-agent.log 2>&1 &   # then sleep 6
npx tsx src/dev/try-tool.ts fetch_page '{"url":"https://…"}'
npx tsx src/dev/check-grounding.ts "query one" "query two"
npx tsx src/dev/try-citations.ts                              # 9 guard cases
npx tsx src/dev/try-cache.ts                                  # key + rows + TTL index
npx tsx src/dev/try-cache.ts --purge                          # empty the cache
npx tsx src/dev/try-threads.ts --unit                         # buildHistory only, free
npx tsx src/dev/try-threads.ts                                # 34 checks, 2 real answers
npx tsx src/dev/try-memory.ts --routes                        # 4 checks, FREE (no LLM)
npx tsx src/dev/try-memory.ts                                 # 27 checks, 4 real answers ≈ $0.12
node quality/check.mjs .                                      # 0 errors; exit 1 is the FLOOR
node benchmark/bench.mjs --smoke --target http://localhost:8000
```

Background the agent with `nohup … &` then `sleep 6` — a bare `&` inside a compound command
tangles and reports `health=000`.

**`node benchmark/bench.mjs --smoke` crashes at the RAG phase** with an unhandled
`HttpError: 501 POST /spaces` (Week 2 work). Everything before the crash is real and useful:
contract probes + the 5-query web workload. **Its memory phase (4b) sits AFTER the RAG phase,
so the bench cannot grade memory until spaces exist** — `try-memory.ts` covers the same three
assertions meanwhile.

## Findings that overrode the docs — do not undo these
1. **The grounding haystack is the BENCH'S OWN re-fetch** (`benchmark/bench.mjs:206`),
   stripped by a regex turning every HTML entity into a space (`:193`). → Use **Readability,
   not Tavily `extract`**. **TECHSPEC §6.2 is stale.**
2. **`normalize()` is byte-identical to `benchmark/lib.mjs:192` — NO NFKC.** TECHSPEC §7.1 is stale.
3. **Longer snippets are SAFER.** A ≤12-token snippet must match in full; a longer one needs
   only *some* 12-token run. 30-token windows.
4. **`res.on('close')`, never `req.on('close')`,** in the AGENT. `express.json()` fires req's
   `close` in ~48ms on a POST. **Finding 20 confirms the same holds at the GATEWAY — measured.**
5. **TTFT 2500ms is UNREACHABLE.** Floor ≈ 3.6s. `eval/rubric.json` scores `performance_sla`
   as **10 points, binary** — a known, documented loss. Do not gut the architecture chasing it.
6. **LLM turns are ~74% of latency, tools ~26%.**
7. **Rate-limit landmine, NOW LIVE for step 10:** bench counts a 429 as an error
   (`bench.mjs:291`); 40 queries at concurrency 4 from one `user_id` vs
   **`RATE_LIMIT_PER_MINUTE=30` currently in `.env`** blows `max_error_rate_pct: 1.0`. Fix by
   raising the number — it appears in no threshold file, unlike `MAX_TOOL_CALLS`, which
   AGENTS.md forbids raising.
8. **`sla.json` cost rates are placeholders** ($3/$15 per MTok; Sonnet 5 is really $2/$10).
   File is do-not-edit, so `obs/cost.ts` reads it and every reported cost runs ~50% conservative.
9. **`temperature` is DEPRECATED on Sonnet 5** — `400 temperature is deprecated for this
   model`. Reasoning left in a comment in `llm.anthropic.ts`; don't re-add it.
10. **Never cache a thin search result.** `MIN_CACHEABLE_HITS = 2`.
11. **`expiresAt` must be a BSON `Date`, not an ISO string.** Mongo's TTL monitor ignores
    strings. `threads`/`messages`/`memories` deliberately store ISO strings instead.
12. **`quality/rules.json` ships 10 `TODO —` precedents** and is do-not-edit, so **P2 always
    fails at `warn` severity. `exit 1` with 0 errors is the passing floor.** Don't chase it.
13. **Replaying a stored answer verbatim into a prompt is a silent grounding bug.** Its `[1]`,
    `[2]` come from *that* request's numbering; reused they are *in range*, so every automated
    check goes green and the citation points at an unrelated page. `loop/history.ts` strips
    every marker before history enters a prompt.
14. **Persist the exchange BEFORE `sse.end()`.** A client treats stream-close as "turn
    finished". ~40ms against a 12s budget. The **run log stays after** `sse.end()`.
15. **History costs ~250 input tokens per prompt ≈ $0.002–0.003 per run** and does not change
    the loop's shape.
16. **The failed-fetch path, not history, is what breaches the cost gate.** The expensive runs
    are failed fetches plus a model-initiated second `web_search`.
17. **NEW · `bench.mjs:673` counts TRACE STEPS, not tool calls** — the quick envelope is
    `(a.trace ?? []).length > 8`. This is why the eager `recall_memory` **must** count against
    `gear.maxToolCalls`: an exempt recall could spend 8 tool calls and emit 9 trace steps,
    failing a run that obeyed its own cap. Counting it makes the internal cap enforce the
    external check by construction.
18. **NEW · Phase 1 will skip retrieval entirely on trivia it thinks it knows.** Measured:
    "What is the capital of Portugal?" returned `turn 1, asked: 0` — DONE with zero fetches,
    and the answer came back "I have no sources and cannot answer", because Phase 2 only sees
    fetched text. **That is the exact question `bench.mjs:773` asks in its memory phase.** The
    Phase 1 prompt now states the consequence explicitly and forbids DONE before a successful
    fetch (exceptions: all fetches failed, or nothing to fetch).
19. **NEW · `answer_p95_ms: 12000` looks breached under the real bench workload** — this was
    NOT in the previous risk list. Five smoke runs: `9.3 · 16.8 · 11.0 · 8.2 · 18.5` seconds.
    Same mechanism as the cost breach (finding 16): one extra LLM turn from a failed fetch or
    a model refinement costs both dollars and seconds.
20. **NEW · `req.on('close')` at the GATEWAY is the same trap as in the agent — MEASURED, and
    TECHSPEC §11.2 is stale on it.** Instrumented both events on the ask route: req closed at
    **19ms** and **8ms** on two runs, against responses that closed at **508ms** and **3986ms**.
    `express.json()` drains the POST body and destroys the request stream while the client is still
    waiting. On `req` the gateway would abort every run ~15ms in and report a healthy agent as an
    upstream failure. `res.on('close')` in `proxy/stream.ts`. Instrumentation has been removed; the
    numbers are in the comment there and in `DESIGN.md`.
21. **NEW · Gateway overhead is ~56ms.** Client-observed first token 10936ms vs the agent's own
    `ttftMs` 10880 on the same run. The hop is not the latency problem — finding 19 is.
22. **NEW · The provided SPA fallback regex excluded `/evals`, so the Evals page 404'd.**
    `^(?!\/(health|stats|threads|memory|spaces|artifacts|evals)).*` never served `index.html` for
    `/evals`, which `web/src/App.tsx` links to with a plain `<a href>`. Fixed: only
    `evals/report.json` is treated as an API path; `/evals` falls through to the SPA. **This only
    bites on the deployed gateway** (in dev, Vite serves the page), so it would have shown up for
    the first time on the submitted URL.
23. **NEW · `RATE_LIMIT_PER_MINUTE` is now 300** (was 30 — finding 7). Verified on a throwaway
    instance at limit 3: 4th request 429 with `resetsAt` + `Retry-After`, a second user unaffected,
    and a 400 body does not spend quota (validate runs before rateLimit).

## Locked-in architectural decisions (agent — do not relitigate)
1. **Two hard phases.** Phase 1 RETRIEVE (tools on, no prose) → freeze evidence, number
   1..N, emit `sources` → Phase 2 SYNTHESIZE (tools **off**, streaming).
2. **Termination is exactly `done` | `cap` | `error`.** Empty retrieval is `done`.
3. **`ProviderError` (`lib/errors.ts`) is the throw/return boundary.** Tool failure →
   `{ok:false, error}`, loop continues. Provider failure → `terminated:"error"` + 502.
4. **Eager `web_search` before the first LLM turn.** Model refines **once** if off-target.
   `MAX_SEARCHES = 3`.
5. **Exit heuristic:** Phase 1 returns `done` when a turn's calls all succeeded AND evidence
   ≥ 3. Any failure in a turn always gets another pass.
6. **`fetch_page` returns a RECEIPT to the model, not page text.** Full text reaches Phase 2 only.
7. **Snippet selection is deterministic code.** `prose > clean 12-run > starts at a sentence >
   query relevance`.
8. **Truncation is head-only**; a snippet may never span two `segments`.
9. **`evidence/merge.ts` is the ONLY function that mints a `Source`.**
10. **`plan_research.ts` is imported by NOTHING.**
11. **Anthropic:** `thinking:{type:'disabled'}`, `output_config:{effort:'low'}`. No `temperature`.
12. **`searchCached`** = true only when every *search* hit. Fetches don't count. Zero searches = false.
13. **Tools are absent, not disabled, in Phase 2.** `LlmProvider.stream()` has no `tools` parameter.
14. **The citation guard is structural.** `loop/citations.ts` buffers on `[`, releases on `]`,
    drops out-of-range markers.
15. **`toolCalls` and `spend` are owned by `run.ts` and appended in place**, never returned
    from `retrieve()`/`synthesize()` — a return value does not survive a `throw`.
16. **`settleProviderSpend()` is called BEFORE `emitDone` and again in the `finally`.**
17. **The run log is written in the route's `finally`, after `sse.end()`**, to
    `runs/<requestId>.json` first (the gate must not need a DB) then Mongo.
18. **`repo/*.ts` upserts are keyed on the natural id**; `_id` travels in the filter, never the body.
19. **History is 2 exchanges, truncated, citation-stripped, complete pairs only.**
20. **`run()` takes `history` and returns the `done` event.**
21. **404, never 403.** Every scoped route filters `{_id, userId}`.
22. **`title: ''` means "not yet titled".** Claimed atomically by the first ask.
23. **The question is stored even when the run failed.**
24. **NEW · Recall runs IN PARALLEL with the eager search, so it is free.** Recall ≈ 400ms, the
    search ≈ 1.4s; sequentially that is 400ms of pure TTFT on every request, concurrently it is
    zero. `Promise.all`, then trace steps emitted recall-then-search (the order a reader
    expects). Both count against the cap — see finding 17.
25. **NEW · `recall_memory` is `systemOnly: true`** — a new flag on the `Tool` interface.
    `registry.forGear()` skips it so the model is never shown it; `registry.run()` still
    executes it, so it keeps the error taxonomy, the trace step and the cap slot. The model is
    shown exactly `fetch_page, save_memory, web_search` on both gears (verified).
26. **NEW · Recall is top-k with NO score floor.** A preference is never topically similar to
    the question it governs ("British English" vs "capital of Portugal"), so any threshold high
    enough to filter noise filters out exactly the memories that matter most. `RECALL_K = 6`.
    Known limit, for DESIGN.md: at ~50 memories, topical rows crowd out standing preferences;
    the fix is a typed memory (`kind: 'preference' | 'fact'`), impossible in Week 1 because
    `MemoryDoc` is contract-fixed.
27. **NEW · A failed recall degrades; it does NOT kill the run.** The ONE place a
    `ProviderError` is deliberately downgraded, at a single documented site
    (`eagerRecall()` in `retrieve.ts`). Not the forbidden catch: the trace carries `ok: false`
    and the provider's real message, so "nothing stored" stays distinguishable from "the lookup
    broke". Losing preferences must not 502 a correct grounded answer.
28. **NEW · `save_memory` ids are content-derived** —
    `mem_<sha256(userId|normalize(text)).slice(0,24)>` — so repeating a preference rewrites one
    row instead of accumulating duplicates. Same natural-id rule as every other upsert.
29. **NEW · Memories are injected into BOTH phases, and Phase 2 is the one that matters.**
    Phase 1 retrieves; a preference changes the *writing*. A recall that reached only Phase 1
    would pass every automated check (trace step present, row in `GET /memory`) and still not
    work. They go in the **user message, never the system prompt** — the system prompt is the
    cacheable prefix and a per-user block would mint a cache entry per user.

## Tunable constants (all measured)
`PAGE_TOKEN_BUDGET = 1200` · `MIN_ARTICLE_TOKENS = 120` · `FETCH_TIMEOUT_MS = 6000` ·
`MAX_BYTES = 2MB` · `WINDOW_WORDS = 30` · `STRIDE_WORDS = 8` · `CLEAN_RUN = 12` ·
`MAX_PARALLEL = 4` · `MIN_EVIDENCE_TO_EXIT = 3` · `MAX_SEARCHES = 3` ·
`ANSWER_MAX_TOKENS = 500` · `SYNTH_FLOOR_MS = 15000` · `LRU_MAX = 500` · `MIN_CACHEABLE_HITS = 2` ·
`HISTORY_EXCHANGES = 2` · `HISTORY_FETCH = 8` · `USER_CHARS = 240` · `ASSISTANT_CHARS = 320` ·
`THREAD_LIST_LIMIT = 50` · `TRANSCRIPT_LIMIT = 200` · `TITLE_CHARS = 80` ·
**`RECALL_K = 6`** · **`MEMORY_CHARS = 240`** · **`BLOCK_CHARS = 1200`** · **`MAX_SAVES = 3`** ·
**`MAX_TEXT_CHARS = 400`** · **`MEMORY_LIST_LIMIT = 50`**

## Measured, live (end of step 9)
```
clean run, no history:    $0.0363-0.0393 · ttft 4.7-5.5s · 1 turn · 4-5 trace steps
clean run, 2 exchanges:   $0.0421        · ttft 6.5s
follow-up (pronoun):      $0.0590        · 3 turns
save-only run:            $0.0221        · ttft 4.1s · 3 steps (recall, search, save)
failed fetch x2:          $0.0713        · 3 turns · worst observed
cache hit:                saves $0.008 and ~1.2s of TTFT
eager recall:             ~390-450ms, IN PARALLEL with the search → ~0ms added TTFT
                          ~0 prompt tokens for a user with no memories (block is empty)
grounding:                27/27 = 100% (gate 95%)
quality/check.mjs:        0 errors over 29 run logs (A1 A2 A3 B1 B2 B3 all pass), exit 1
try-memory.ts:            27/27 checks pass
bench --smoke (5 queries, concurrency 1, all terminated `done`):
  $0.0375  9.3s   5 steps
  $0.0505 16.8s   5 steps (one failed fetch)     <- OVER cost AND latency
  $0.0393 11.0s   5 steps
  $0.0370  8.2s   4 steps
  $0.0614 18.5s   7 steps (model ran a 2nd search) <- OVER cost AND latency
```
Gates: `answer_p95_ms 12000` (**breached — finding 19**) · `max_cost_per_answer_usd 0.05`
(**breached — finding 16**) · `ttft_p95_ms 2500` (known, accepted loss).

## Step 10 — the gateway — DONE. What it verified

```
4/4 contract probes on :8787   401 no header · 404 thr_nope · 400 empty body · report.json NOT 401
bench --smoke --target :8787   contract probes ✓ · 5/5 answered · 0 errors · then the known
                               Week-2 crash at POST /spaces (now the AGENT's 501, relayed)
streaming                      86 token frames over 4096ms — a buffered stream would be ~0ms
gateway overhead               56ms (client first token 10936 vs agent ttftMs 10880)
disconnect                     client abort → gateway res close 3986ms → agent logs
                               "client disconnected mid-stream" → run stops paying. Same
                               requestId in both logs.
rate limit                     limit-3 instance: 4th → 429 + resetsAt + Retry-After; second
                               user unaffected; a 400 body spends no quota
UI at :5173                    full answer streamed, citation chips, sources rail, trace panel,
                               thread sidebar. Network log: EVERY call to :8787, none to :8000.
                               CORS preflights 204.
citation integrity             text [1][2][3] vs sources 1,2,3 — no dangling marker
quality/check.mjs .            0 errors, exit 1 (the floor)
```

### Gateway commands
```bash
npm run -w @lumina/gateway typecheck && npx eslint backend/gateway/src --max-warnings 0
cd backend/gateway && nohup npx tsx src/index.ts > /tmp/lumina-gateway.log 2>&1 &   # then sleep 6
node benchmark/bench.mjs --smoke --target http://localhost:8787
VITE_API_URL=http://localhost:8787 npm run dev -w web                # → http://localhost:5173
```
Start each service in its **own** Bash call. A `pkill -f "tsx src/index.ts"` matches BOTH
services — it killed the agent while I was only trying to restart the gateway. Use
`lsof -ti:8787 | xargs kill` instead.

## Next: the two things that are not code

**1. The cost AND latency gate decision — the biggest open problem.** `max_cost_per_answer_usd
0.05` and `answer_p95_ms 12000`, both breached by the same mechanism (finding 16): one extra
LLM turn, bought by a failed fetch or a model-initiated second search, costs both dollars and
seconds. Fresh evidence from this session, all through the gateway, all `terminated: done`:
`7.9 · 13.2 · 14.0 · 19.5 · 28.4` seconds at `$0.029–$0.050`, plus a UI run at 24.1s / $0.0555.
The 28.4s run is a new worst. **These are agent-measured wall clocks — the gateway is not in
them** (finding 21), so this is the loop, not the edge. One fix moves both gates.

**2. Deploy, then the real eval run.** The submission is a URL, not code. Before deploying:
add the Vercel/Fly origins to `CORS_ORIGINS`, build `web/dist` so the gateway serves the UI,
sweep `runs/`, and keep `runs/failing/` intact. Then a real `node benchmark/bench.mjs` and
`node quality/check.mjs .` **against the deployed gateway**, then `eval/build-report.mjs` into
`reports/report.json`, which the gateway now serves at `GET /evals/report.json`.

## Known risks carried forward
- **Two gates are breached, both by the same mechanism:** `max_cost_per_answer_usd 0.05` and
  `answer_p95_ms 12000`. A failed fetch or a model-initiated second search buys an extra LLM
  turn, which costs both dollars and seconds. **This is the biggest open problem** and the one
  fix that would pull both gates back inside the line. **Worse than last session's numbers:**
  this session's five gateway-fronted runs were `7.9 · 13.2 · 14.0 · 19.5 · 28.4`s at
  `$0.029–$0.050`, and a UI run hit 24.1s / $0.0555. The gateway is not in those clocks.
- **A3 has headroom but not much.** `maxConsecutiveSameTool: 4`; observed max 3.
- **The cache gate has no headroom.** `min_search_cache_hit_rate_pct: 50` against 20 fresh +
  20 repeats = a 50% ceiling. Every repeat must hit; a model refinement worded differently on
  the repeat is one miss and a failed gate.
- **The empty-retrieval path has now run live** (finding 18) and produced the correct "no
  sources" answer — but that was a bug, and the prompt fix means it should be rare again.
- A client closing a tab writes an `error` log into `runs/`, which A2 flags. Correct behaviour
  — but **sweep `runs/` before any graded run**.
- **Atlas Search indexes are eventually consistent.** A memory saved during a request may not
  be recallable microseconds later. Acceptable in Week 1 (recall happens at the *start* of a
  later request); a hard requirement in Week 2 (§13, the read-your-write probe).

## State of `runs/`
35 `done` logs in `runs/` (step 6, step 8, step 9's verification, and both bench smokes), and
**one real failing trajectory in `runs/failing/req_step6_aborted.json`** (a client disconnect
mid-stream: `terminated:"error"`, `costUsd: 0.008`). The subfolder arrangement is proven end to
end — `readdirSync` is non-recursive and a directory does not end in `.json`.

## What I still owe
- **`DESIGN.md`** — the largest debt, and it is graded as the design section of `/evals`.
  Personalize trade-offs #1 and #4, and add: eager search, the exit heuristic, head-only
  truncation, the TTFT gap with its measured breakdown, the citation guard as structural
  rather than prompt-based, answer length as a *latency* decision, not caching thin results,
  citation-stripped history (finding 13), bounded history as a cost decision (decision 19),
  persist-before-close (finding 14), and now five from step 9: **parallel eager recall**
  (decision 24), **system-only tools** (decision 25), **top-k with no score floor and why**
  (decision 26), **recall degrades rather than kills** (decision 27), and **memory injected
  into both phases** (decision 29).
  **Step 10 paid part of this down** — `DESIGN.md` now carries the measured `res`-vs-`req` close
  finding with its numbers, the 56ms gateway overhead, bodies-validated-but-not-ids and why
  `404` beats `400` there, 502-is-the-only-minted-status, and `/evals/report.json` served off
  disk. The in-memory rate limiter was **already** covered by trade-off #4, including what
  breaks at two instances. Everything else on this list is still owed.
- **A decision on the cost AND latency gates** — both breached, same mechanism. See "Next".
- `SERPAPI_API_KEY` for the provider-swap test.
- Nothing is committed yet.

**Read `AGENTS.md` first, then `benchmark/sla.json` + `eval/rubric.json` for what the two
breached gates are actually worth, then `backend/agent/src/loop/retrieve.ts` and
`loop/run.ts` — the extra LLM turn that breaks both gates is bought there, and that is where
the remaining decision lives. The gateway is finished; read it only if something on :8787
misbehaves.**
