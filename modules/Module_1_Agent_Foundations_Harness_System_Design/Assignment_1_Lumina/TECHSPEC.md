# TECHSPEC.md — LUMINA, Week 1 (the quick-search loop)

*Technical specification · Assignment 1 · FDE Agent Engineering Bootcamp cohort 2026-03*
*Companion to `DESIGN.md` (decisions) and the PRD (what & why). This document is **how**.*

---

## 0 · How to read this document

**Authority order. When any two disagree, the higher one wins and the lower is stale — say so
rather than following it.**

```
1. packages/contract/src/        executable zod schemas — outranks all prose
2. benchmark/sla.json            performance & cost thresholds
   expectations.json             budget & trajectory thresholds
   eval/rubric.json              points and red lines
3. AGENTS.md                     non-negotiables
4. SPEC.md                       the exhaustive requirements spec
5. THIS FILE                     implementation design only
```

**This file deliberately contains no thresholds, no route shapes, and no status-code tables.**
Those live above it and would drift. Where a number is needed, this file names the file that
holds it. If you find a number restated here, that is a bug in this document.

**Scope:** Week 1 only — the quick gear. Week 2 items (deep search, RAG, the jobs worker)
appear *only* in §13, the seam ledger, which specifies where they plug in without specifying
them.

**A correction the PRD requires.** The PRD (§4, §6, §8) invents five termination reasons —
`completed`, `no_results`, `tool_limit`, `time_limit`, `provider_error`. The contract defines
exactly three: `done`, `cap`, `error` (`packages/contract/src/sse.ts`). **This file uses the
contract's three.** In particular, a run whose retrieval came back empty and which honestly
said so is `done` — it finished correctly; it just found nothing.

---

## 1 · Stack

Fixed by the assignment (`SPEC.md §6`). MERN, one language end to end.

| Layer | Choice | Notes |
|---|---|---|
| Runtime | Node ≥ 20.19, ESM (`"type": "module"`) | root `package.json` engines |
| Language | TypeScript 5.6, `tsx watch` in dev, `tsc` to `dist/` for prod | typecheck is Gate 0 |
| HTTP | Express 4 | both services; already scaffolded |
| Validation | zod 3 via `@lumina/contract` | never hand-roll a shape the contract owns |
| Database | MongoDB Atlas (driver `mongodb` 6, **not** Mongoose) | ODM is optional; zod is the contract |
| Logging | `pino` 9 (agent), `pino-http` 10 (gateway) | JSON lines |
| LLM | Anthropic `claude-sonnet-5` via `@anthropic-ai/sdk` | **not pre-installed — you add it** |
| Embeddings | OpenAI `text-embedding-3-small`, 1536 dims | `openai` 4 is pre-installed |
| Search | Tavily (default) or SerpApi | env-swappable, no code change |
| Extraction | Tavily `extract`, or `@mozilla/readability` + `jsdom` | both pre-installed |
| Frontend | React 18 + Vite | **provided, do not touch** |

**The one dependency you must add:**

```bash
npm i @anthropic-ai/sdk -w @lumina/agent
```

`backend/agent/package.json` deliberately omits it (`_note` in that file): the LLM SDK is your
choice. `openai` is present only because the assignment names its embedding model.

---

## 2 · System architecture

```
┌─────────────────────────────────────────────────────────────────┐
│  web/  React 18 + Vite      :5173          PROVIDED — DO NOT EDIT│
└───────────────────────────┬─────────────────────────────────────┘
                            │ HTTP + SSE
                            │ headers: X-User-Id (required), X-Request-Id (optional)
                            ▼
┌─────────────────────────────────────────────────────────────────┐
│  backend/gateway/   Express  :8787            THE EDGE — YOURS   │
│                                                                  │
│  CORS → requestId → pino → requireUser → validate → rateLimit    │
│                                    ├── JSON proxy                │
│                                    └── SSE pass-through (no buf) │
│  also: serves web/dist                                           │
│  HOLDS NO PROVIDER KEY. Never imports the mongodb driver.        │
└───────────────────────────┬─────────────────────────────────────┘
                            │ HTTP, same contract, same zod schemas
                            │ forwards X-User-Id + X-Request-Id verbatim
                            ▼
┌─────────────────────────────────────────────────────────────────┐
│  backend/agent/     Express  :8000            THE WORK — YOURS   │
│                                                                  │
│   routes ──▶ loop/run.ts ──▶ Phase 1 RETRIEVE (tools, no prose)  │
│                          └─▶ Phase 2 SYNTHESIZE (prose, no tools)│
│                                                                  │
│   tools/registry ─ web_search · fetch_page · recall · save       │
│   evidence/       ─ collect → select snippet → number → emit     │
│   providers/      ─ llm · search · embed   (interfaces + impls)  │
│   cache/          ─ LRU  ▶  searchCache (TTL)                    │
│   obs/            ─ cost · runlog · pino                         │
│                                                                  │
│  THE ONLY PROCESS THAT READS A PROVIDER KEY.                     │
│  Must not be publicly reachable in production.                   │
└───┬─────────────────┬──────────────────┬────────────────────────┘
    ▼                 ▼                  ▼
 Tavily/SerpApi   Anthropic +        MongoDB Atlas
                  OpenAI embed       (§4)
```

**Why the browser never reaches :8000.** Two reasons, and only the first is about secrets: the
keys live there, and in Week 2 the deep-search spend cap is enforced there. A cap on the edge is
a cap you bypass by calling the service directly.

---

## 3 · Project folder structure

Files marked `[P]` are provided and already work. `[W2]` are Week 2 stubs — create the file with
its interface in Week 1 so the seam exists; leave the body unimplemented.

```
Assignment_1_Lumina/
├── DESIGN.md                          ← you write, BEFORE code. Graded.
├── TECHSPEC.md                        ← this file
├── .env                               ← git-ignored, from .env.example
├── runs/                              ← git-ignored. One JSON per answer.
│   └── failing/                       ← the deliberate failing trajectory (rule P1)
│                                        MUST be a subfolder: check.mjs reads runs/*.json only
│
├── packages/contract/                 [P] DO NOT EDIT — the authority
├── web/  benchmark/  eval/  quality/  scripts/   [P] DO NOT EDIT
│
├── backend/gateway/src/
│   ├── index.ts                       [P] extend: mount middleware + proxy, delete the 501 loop
│   ├── env.ts                         [P]
│   ├── sse.ts                         [P] sseHeaders() + sseSend() — already correct, use them
│   ├── middleware/
│   │   ├── requireUser.ts             X-User-Id present → next, else 401
│   │   ├── validate.ts                zod body/param validation → 400 with the zod message
│   │   └── rateLimit.ts               per-user fixed window, in-memory → 429
│   └── proxy/
│       ├── json.ts                    forward + status/body passthrough; upstream throw → 502
│       └── stream.ts                  SSE pass-through: pipe bytes, never parse, never buffer
│
└── backend/agent/src/
    ├── index.ts                       [P] extend: mount routers, delete the 501 loop
    ├── env.ts                         [P] all caps + config already parsed here
    ├── db.ts                          [P] one pooled MongoClient
    ├── worker.ts                      [W2] jobs worker
    │
    ├── http/
    │   ├── threads.routes.ts          POST /threads, GET /threads, GET /threads/:id, POST .../ask
    │   ├── memory.routes.ts           GET /memory, DELETE /memory/:id
    │   ├── stats.routes.ts            GET /stats
    │   ├── spaces.routes.ts           [W2]
    │   └── sse.ts                     agent-side emitter; validates each event against the contract
    │
    ├── loop/
    │   ├── run.ts                     THE ORCHESTRATOR. §5.
    │   ├── retrieve.ts                Phase 1: the bounded tool loop
    │   ├── synthesize.ts              Phase 2: streaming answer, no tools
    │   ├── gear.ts                    quick|deep config resolution + cap enforcement  ← seam
    │   ├── trace.ts                   emit + accumulate trace steps
    │   └── prompts.ts                 system prompt, tool descriptions, synthesis prompt
    │
    ├── tools/
    │   ├── types.ts                   the Tool interface every tool implements
    │   ├── registry.ts                name → Tool; gear decides which are exposed  ← seam
    │   ├── web_search.ts
    │   ├── fetch_page.ts
    │   ├── recall_memory.ts
    │   ├── save_memory.ts
    │   ├── search_documents.ts        [W2]
    │   └── plan_research.ts           [W2] deep only — never exposed to a quick gear
    │
    ├── evidence/
    │   ├── store.ts                   per-request evidence set (the ONLY citable universe)
    │   ├── select.ts                  deterministic snippet selection. §6.3
    │   └── merge.ts                   dedupe + contiguous renumber  ← the Week 2 seam. §13
    │
    ├── providers/
    │   ├── llm.ts                     interface: complete() / stream()
    │   ├── llm.anthropic.ts
    │   ├── search.ts                  interface: search(query) → SearchHit[]
    │   ├── search.tavily.ts
    │   ├── search.serpapi.ts
    │   └── embed.ts                   OpenAI embeddings, 1536 dims
    │
    ├── cache/
    │   └── searchCache.ts             tier 1 LRU → tier 2 Mongo TTL. §7
    │
    ├── repo/                          the ONLY files that touch collections
    │   ├── threads.ts   messages.ts   memories.ts
    │   └── requests.ts  runs.ts
    │
    ├── obs/
    │   ├── log.ts                     pino child bound to requestId
    │   ├── cost.ts                    token + search + embed → USD. §10
    │   └── runlog.ts                  writes runs/<requestId>.json AND the runs collection
    │
    └── lib/
        ├── normalize.ts               ONE normalizer, shared by cache key + grounding. §7.1
        └── tokens.ts                  truncation with a grounding guarantee. §6.4
```

**The `repo/` rule.** No route, tool, or loop file imports the `mongodb` driver. Every collection
access goes through `repo/`. This is what makes the data layer swappable and what keeps a
`$vectorSearch` pipeline out of a route handler.

---

## 4 · Database schema

One database, `lumina`. Documents are defined in `packages/contract/src/db.ts` — **those zod
schemas are the schema**; what follows is the deployment view.

### 4.1 Week 1 collections

| Collection | Purpose | Owns | Contract type |
|---|---|---|---|
| `threads` | conversation containers | authoritative | `ThreadDoc` |
| `messages` | every turn + its sources + its `done` | authoritative | `MessageDoc` |
| `memories` | durable per-user facts, with embedding | authoritative | `MemoryDoc` |
| `searchCache` | provider results, TTL'd | **cache — deletable** | `SearchCacheDoc` |
| `requests` | one row per HTTP request | observability | `RequestDoc` |
| `runs` | one row per answer, mirrors `runs/*.json` | observability | `RunDoc` |

### 4.2 Indexes

Created by `node scripts/create-indexes.mjs` (provided; reads `scripts/indexes.json`). Do not
create them by hand.

```
threads       { userId: 1, createdAt: -1 }
messages      { threadId: 1, createdAt: 1 }
memories      VECTOR "memories_vector" on embedding, cosine, 1536
                 └── userId declared as a FILTER field  ← mandatory, not optional
searchCache   { expiresAt: 1 }  TTL, expireAfterSeconds: 0
requests      { createdAt: -1 }, { requestId: 1 }
runs          { createdAt: -1 }
```

**Three notes that cost people a day each.**

1. `expireAfterSeconds: 0` means "expire at the time in `expiresAt`", not "expire immediately".
   You compute the expiry; Mongo honours it. Never delete cache rows by hand.
2. `userId` must be declared as a **filter field inside the vector index definition**, and passed
   inside the `$vectorSearch` stage — not as a `$match` after it. A post-filter scans other users'
   vectors first and silently returns fewer than `k` results.
3. Atlas Search indexes are **eventually consistent**. Week 1 only feels this on `memories`: a
   memory saved during a request may not be recallable microseconds later. Acceptable in Week 1
   (recall happens at the *start* of a later request). It becomes a hard requirement in Week 2 —
   see §13.

### 4.3 Free-tier budget

Atlas M0 allows **3 search indexes**. LUMINA needs exactly 3 across both weeks:
`memories_vector` (Week 1), `chunks_vector` + `chunks_text` (Week 2). Week 1 spends one. Do not
create a throwaway fourth to experiment.

### 4.4 Ids

`newId(prefix)` from `@lumina/contract` — prefixed, readable strings (`thr_…`, `ans_…`), **not**
ObjectIds. The `_id` of a thread *is* the `thr_…` string. Do not add a second id field.

---

## 5 · The agent loop

### 5.1 The decision that shapes everything: two phases

The contract requires `sources` to arrive **before the first `token`**, and grounding requires
every source's `snippet` to be findable verbatim in text actually retrieved. Together these force
a strict ordering:

```
  ┌─ PHASE 1 · RETRIEVE ────────────────────────────────┐
  │  bounded tool loop, model may call tools             │
  │  emits: trace                                        │
  │  produces: EvidenceItem[]                            │
  │  NO prose is generated in this phase                 │
  └──────────────────────┬──────────────────────────────┘
                         │  evidence frozen, snippets selected,
                         │  numbered 1..N
                         ▼
                   emit `sources`          ◀── the boundary
                         │
  ┌──────────────────────▼──────────────────────────────┐
  │ PHASE 2 · SYNTHESIZE                                 │
  │  one streaming call, TOOLS DISABLED                  │
  │  the model is handed the numbered evidence and may   │
  │  cite only [1]..[N]                                  │
  │  emits: token*  then  done                           │
  └─────────────────────────────────────────────────────┘
```

**This resolves PRD Open Question 1.** Citation chips may *not* be emitted from search results
before fetches complete: a chip's snippet is grounding-checked against fetched page text, so a
chip built from a search snippet fails the check. Sources are emitted after retrieval finishes,
before synthesis starts.

**Disabling tools in Phase 2 is not a convenience.** It is what makes "grounded or nothing"
structurally true rather than prompt-dependent: at the moment the first token is generated, the
citable universe is already closed and already sent to the client.

### 5.2 Phase 1 control flow

A real `while` loop — yours, not a framework's (`SPEC.md §5.1`).

```
run(query, threadId, userId, gear):
  requestId, answerId, t0
  ctx = { evidence: [], traceSteps: [], toolCallCount: 0, deadline: t0 + gear.wallClockSec }

  # step 1 is eager, not model-chosen — see 5.4
  emitTrace(recall_memory) ; ctx.memories = recall(userId, query)

  messages = [ system(gear, ctx.memories), ...threadHistory, user(query) ]

  while true:
      if ctx.toolCallCount >= gear.maxToolCalls: terminated = "cap"; break
      if now() > ctx.deadline:                   terminated = "cap"; break

      reply = llm.complete(messages, tools = registry.forGear(gear))   # may throw → §9

      if reply has no tool calls: terminated = "done"; break

      for each toolCall in reply.toolCalls:          # parallel where independent
          result = registry.run(toolCall)            # never throws; returns {ok, data|error}
          emitTrace({ step, tool, input, ok, ms, reason })
          ctx.toolCallCount += 1
          if result.ok and tool yields evidence: ctx.evidence.push(...)
          messages.push(toolResult)                  # errors go back to the model AS ERRORS
```

**Turn budget.** The TTFT target (`benchmark/sla.json`) is tight enough that turn count is a
design constraint, not an afterthought. The intended shape is **three LLM turns**:

```
turn 1  →  web_search("…")
turn 2  →  fetch_page(url) × 3–4  ← ONE assistant turn, multiple tool_use blocks, run in parallel
turn 3  →  no tool calls → exit Phase 1
```

Emitting several `fetch_page` calls in a single assistant turn is the difference between ~2 s and
~6 s to first token. The system prompt must ask for it explicitly, and the executor must run the
calls in a bounded-concurrency `Promise.allSettled`, not a sequential `for await`.

**Contingency if TTFT still misses:** speculatively begin fetching the top 3 search hits the
moment `web_search` returns, while turn 2 is in flight; discard any fetch the model did not ask
for. Adds cost, removes one round trip from the critical path. Do not build this first — measure,
then decide.

### 5.3 Termination — the only three values

| `terminated` | When | Client sees | Run log |
|---|---|---|---|
| `done` | loop exited on its own **— including empty retrieval** | 200, full stream | `"done"` |
| `cap` | `maxToolCalls` or `wallClockSec` exceeded | 200, partial answer that **says it is partial** | `"cap"` |
| `error` | a provider call threw | `error` SSE event **and** 502 | `"error"` |

Set explicitly at the call site. No SDK gives you this. Reporting a capped run as `done` is a red
line in `eval/rubric.json`.

**Empty retrieval is `done`.** Phase 2 still runs, with an empty evidence set and a prompt
instructing the model to state that retrieval returned nothing. `sources` is emitted as `[]`. The
answer contains no `[n]`.

### 5.4 Two deliberate asymmetries

**`recall_memory` runs eagerly; `save_memory` is model-chosen.**

Recall is a single cheap vector query whose result must be in the prompt *before* the model
reasons. Making it model-chosen costs a full LLM round trip on the critical path to discover
something you always want. So it runs as step 1 of every request, and it is still a real
registry tool: it emits a `trace` step and counts against the cap, which is what the memory
requirement asks for (`SPEC.md §5.3`).

Saving must stay model-chosen and explicit, because the requirement is that only stable facts
and preferences are written — a judgement only the model can make in context.

*Trade-off, and it belongs in `DESIGN.md`:* eager recall is less "agentic" and injects memory
into requests that did not need it. Bounded by cap-at-k (§8).

---

## 6 · Evidence and grounding

This is where the assignment is won or lost. 20 of the automated points ride on it.

### 6.1 The evidence store

An in-request, in-memory array. **It is the only citable universe.** Nothing that is not in it may
appear as `[n]`.

```ts
type EvidenceItem = {
  id: string;              // dedupe key: normalized URL (W2: or docId+locator)
  kind: 'web' | 'doc';
  title: string;
  url?: string;
  fullText: string;        // extracted page text, post-Readability
  sentText: string;        // the truncated window ACTUALLY sent to the model
  snippet?: string;        // selected in 6.3 — always a substring of sentText
  subQuestion?: number;    // W2
};
```

Two text fields, on purpose. `sentText` is what the model saw; `snippet` must come from it. See
§6.4.

### 6.2 Fetch, not snippets

`web_search` returns hits with URLs. It **produces no evidence**. Only a successful `fetch_page`
appends to the store. Synthesizing from search snippets is visible in the trace and scored down
(`SPEC.md §5.2`).

Extraction: Tavily `extract` when the provider is Tavily; `@mozilla/readability` + `jsdom`
otherwise. Both fail on JS-only pages and paywalls — a failed extraction is `ok: false` with an
error string, and the loop continues with the pages it did get.

### 6.3 Snippet selection is deterministic, not model-chosen

**A model asked to quote a page will paraphrase it, and a paraphrase fails a verbatim check.**

So the snippet is selected by code, before Phase 2:

```
for each EvidenceItem:
    split sentText into overlapping passages (~40 tokens, stride 20)
    score each against the query by normalized lexical overlap
    snippet = highest-scoring passage, verbatim, ≥ the grader's minimum consecutive-token run
```

The minimum run length and the normalization the grader applies are described in `SPEC.md §16`;
read it and match it exactly. Use the **same** normalizer as the cache key (`lib/normalize.ts`) —
one function, two callers, no drift.

*Trade-off for `DESIGN.md`:* a deterministic snippet may not be the passage the model's claim
actually rests on, so the chip is "the most query-relevant passage from a page the answer used"
rather than "the sentence that proves claim 3". It is honest, it is verifiable, and it always
passes. A model-selected snippet would be more precise and would sometimes fail the gate. Given
that grounding is 20 points and precision is 0, this is not a close call.

### 6.4 Truncation that cannot break grounding

**This resolves PRD Open Question 6.** Long pages blow the cost target; naive truncation can cut
away the text a snippet was taken from.

The rule: **select the snippet from `sentText`, never from `fullText`.**

```
fetch → extract → fullText
      → truncate to the per-page token budget → sentText     (sentText ⊆ fullText)
      → select snippet from sentText                          (snippet ⊆ sentText ⊆ fullText)
```

Because `sentText` is a substring of what was fetched, and the snippet is a substring of
`sentText`, the grounding check passes by construction — whatever the truncation budget is.

Truncation keeps the head of the extracted main content plus the highest-scoring passages, joined
with an elision marker. Never truncate mid-word.

### 6.5 Guarding the citation range

Sources are numbered `1..N` and sent before synthesis, so the model can only cite what exists — if
it behaves. It sometimes will not.

Prompt constraint first: the synthesis prompt states the exact valid range and that an
out-of-range citation is worse than no citation.

Structural guard second, in the token stream: a small transform that holds output when it sees
`[` and releases when the bracket closes. If the enclosed number is outside `1..N`, drop the
marker and emit the surrounding text. This costs a few characters of buffering — not measurable
against TTFT, since it engages only mid-answer — and makes an unresolvable `[n]` impossible
rather than unlikely.

`unresolvedCitations()` in `packages/contract/src/sse.ts` is the check. Run it on the assembled
answer before persisting the message, and log a warning if it ever fires — if the guard is
working, it never will.

---

## 7 · Search cache

Two tiers, one key.

```
web_search(q)
   │
   ├─ tier 1: in-process LRU (Map, ~500 entries, bounded)   ─ hit ─▶ return, mark cached
   ├─ tier 2: searchCache collection, _id = key             ─ hit ─▶ warm LRU, return, mark cached
   └─ miss:   provider call → write both tiers → return, mark NOT cached
```

### 7.1 The key

`sha256(normalize(query) + '|' + provider)`.

`normalize()` lives in `lib/normalize.ts` and is the **same function** the grounding check uses:
lowercase, collapse whitespace, strip punctuation, NFKC. Including the provider in the key is what
makes the env-swap test honest — flipping `SEARCH_PROVIDER` must not serve the other provider's
cached results.

### 7.2 `searchCached` semantics

**This resolves PRD Open Question 12.** The contract is explicit
(`packages/contract/src/sse.ts`): true only when **every search in the request was a hit**.
Fetches are not searches and do not count. A request with zero searches is `false`, not `true`.

Implementation: a per-request counter pair `{searches, searchHits}`; `searchCached = searches > 0
&& searches === searchHits`.

### 7.3 TTL

`expiresAt = now + SEARCH_CACHE_TTL_SECONDS` (in `.env`, already parsed in `env.ts`). Mongo's TTL
monitor runs about every 60 s, so an expired row can be read for up to a minute after expiry.
Check `expiresAt` in your read path rather than trusting the sweeper.

---

## 8 · Memory

| Operation | Trigger | Mechanism |
|---|---|---|
| recall | eager, step 1 of every ask | `$vectorSearch` on `memories_vector`, `userId` as an **in-stage filter**, top-k |
| save | model calls `save_memory` | embed → insert → emit trace step |
| list | `GET /memory` | plain find by `userId`, newest first |
| delete | `DELETE /memory/:id` | delete one, scoped by `userId` — 404 if it is not this user's |

**Injection budget.** Cap recalled memory at roughly ten documents / one thousand tokens
(`SPEC.md §5.3`). Unbounded memory injection is how a cheap request becomes expensive and how a
stale preference poisons an unrelated answer.

**The demonstrable-recall requirement.** A preference saved in thread A must change the answer in
thread B, and the trace must show `recall_memory` returning it. Recall is therefore scoped by
`userId` only — never by `threadId`. `sourceThread` is recorded for provenance, never used as a
filter.

**Deletion must actually change behaviour.** After `DELETE`, a fresh thread must no longer reflect
the preference. This falls out of correct scoping, but it is graded explicitly — test it.

---

## 9 · Error taxonomy — "fail loud"

The precedent (`AGENTS.md`): a translation service whose exception handler returned the input
untouched served English for weeks behind `200`s.

```
                         tool-level failure          provider-level failure
                         (a page 403s, a fetch        (search API 503, LLM SDK throws,
                          times out, extraction       auth rejected)
                          yields nothing)
                                │                             │
   registry.run() catches ──────┘                             │
   returns { ok: false, error }                               │
                                │                             │
   trace step: ok:false + NON-EMPTY error                     │
   tool result → model AS AN ERROR                            │
   loop CONTINUES with what it has                            │
                                                              │
                                          ┌───────────────────┘
                                          ▼
                          NOT caught by the tool wrapper.
                          Propagates to run(). terminated = "error".
                          → emit `error` SSE event
                          → HTTP 502
                          → run log written with terminated:"error"
                          → NEVER a synthesized answer
```

**The distinction, stated once:** a tool that ran and failed is data the model should see. A
provider that is down is not data — it is the end of the run.

**Three rules with no exceptions.**

1. No `catch` returns a synthesized or fallback answer. Not "I couldn't find anything", not an
   empty-but-successful stream.
2. `ok: false` without a non-empty `error` string is rejected by the contract's own
   `superRefine` (`sse.ts`). It will throw at you. That is intentional.
3. If the error arrives *after* the stream opened, you cannot change the status code — emit the
   `error` event, then end the stream. The `done` event is not sent. The run log still gets
   written.

**Producing the failing trajectory (rule P1).** Unset `TAVILY_API_KEY`, run one ask, and move the
resulting file into `runs/failing/`. Do this in Week 1 while the stack is small. `check.mjs` grades
`runs/*.json` and would fail an `error` run left in `runs/`; `eval/build-report.mjs` reads both
folders. The subfolder is how both hold at once (`AGENTS.md`).

---

## 10 · Observability

### 10.1 The run log — ten lines, and every gate reads it

Shape: `RunLog` in `packages/contract/src/db.ts`. Note `tokens` is a **single total**, not the
`{in, out}` split the `done` event carries. Include `depth` from day one even though Week 1 only
ever writes `"quick"` — without it, nobody can distinguish a legitimately expensive deep run from
a quick run that ran away.

Written **twice**, to `runs/<requestId>.json` (what `quality/check.mjs` reads) and to the `runs`
collection (what `npm run export:runs` dumps from a deployed instance).

**Write it in a `finally`, on stream close.** A crash mid-stream must still produce a log with
`terminated: "error"`. A run log written before the stream ends is a run log with the wrong
`wallClockSec`.

### 10.2 Cost accounting

Rates live in `benchmark/sla.json → cost_model`. Read them from that file; do not copy the numbers
into code.

```
costUsd = tokensIn/1e6 × input_usd_per_mtok
        + tokensOut/1e6 × output_usd_per_mtok
        + embeddingTokens/1e6 × embedding_usd_per_mtok
        + providerSearchCalls × search_usd_per_call      ← cache HITS COST NOTHING
```

Accumulate across every LLM turn in the request, not just the synthesis call. Phase 1's three
turns are most of the input tokens.

### 10.3 Logging and the request id

The gateway already generates/reuses `X-Request-Id` and binds it to `pino-http` (provided code —
read `backend/gateway/src/index.ts`). Your job: **forward it to the agent service**, and bind a
pino child logger to it there.

One line per request at the gateway; one line per answer at the agent, carrying `requestId,
toolCalls, terminated, tokens, costUsd, searchCached, ttftMs, latencyMs`. `grep <requestId>`
across both must tell the whole story.

### 10.4 `/stats`

Aggregations over `requests` and `runs`, shape in `packages/contract/src/http.ts`. The bench
cross-checks `answers` and `costUsdToday` against your logs — they must reconcile, so both must
derive from the same collections rather than from a counter you keep in memory and lose on
restart.

Week 1 reports `deepToday: 0` and `deepDailyCap` from env. The field exists; the feature does not.

---

## 11 · The gateway

Deliberately the boring half. Roughly 200 lines.

### 11.1 Middleware order — it matters

```
cors → requestId [P] → pino-http [P] → requireUser → validate → rateLimit → proxy
```

`requireUser` before `validate`: a request with no identity is 401 regardless of body shape.
`rateLimit` after `requireUser`: the limit is per user, so it needs the identity first.

### 11.2 SSE pass-through — the one place a bug is invisible

`backend/gateway/src/sse.ts` is provided and already correct. Use it. Three ways to break it:

1. **Never `express.json()` the ask route's response** or parse the upstream body. Pipe bytes.
2. **Never put `compression()` in front of `/threads/:id/ask`.** Compression buffers. Tokens
   arrive in one burst at the end, TTFT fails, and no profiler shows you why.
3. **Forward `X-Accel-Buffering: no`** — Fly's proxy and nginx otherwise hold the stream until
   they have a bufferful.

Implementation: `fetch()` the agent with `duplex: 'half'`, then pump
`response.body.getReader()` into `res.write()`. Abort the upstream on client disconnect
(`req.on('close')`) so a closed tab does not keep paying an LLM.

### 11.3 Rate limiting

In-memory fixed window per `X-User-Id`, limit from `.env`. A `Map<userId, {count, windowStart}>`
is sufficient and is the honest choice for a single-instance deploy — say so in `DESIGN.md`, and
name what breaks when you scale to two instances (each gets its own window, so the effective limit
doubles).

**The deep-search cap does not go here.** It is a spend gate on a provider call and belongs next to
the spending, in the agent service (Week 2).

---

## 12 · Configuration

Everything is already parsed in `backend/agent/src/env.ts` and `backend/gateway/src/env.ts` —
read them before adding anything. Both load `.env` from the assignment root.

**Rules.** Secrets are read in `env.ts` only, exported as a separate `secrets` object, and never
logged, never returned by a route, never bundled into client JS. Only `VITE_*` reaches the browser
— nothing secret is ever named `VITE_*`. Raising `MAX_TOOL_CALLS` to make a gate pass is the exact
failure the caps exist to catch.

`/health` names the live model, search provider, and vector backend as free strings. It must tell
the truth: a grader reading a recall number needs to know whether it came from an approximate index
or an exact scan.

**PRD Open Question 8, answered:** yes, `/health` reports `vectorStore` in Week 1. The field is
required by `HealthResponse` and the `memories` vector index is live in Week 1 — the value
describes the backend, not whether documents are indexed.

---

## 13 · The Week 2 seam ledger

**The point of this section: Week 2 should be filling in functions, not restructuring.** Five
seams, all cheap to build now.

| # | Seam | Week 1 state | Week 2 change |
|---|---|---|---|
| 1 | `tools/registry.ts` | 4 tools; `forGear(gear)` returns all of them | register `search_documents` + `plan_research`; `forGear` returns `plan_research` **only** for deep |
| 2 | `loop/gear.ts` | reads quick caps from env; `depth` is a parameter, never a literal | reads deep caps; adds the daily-cap check |
| 3 | `evidence/merge.ts` | takes `EvidenceItem[][]`, called with a **one-element array**, dedupes by `id`, renumbers from 1 | called with five arrays; dedupe and renumbering already work |
| 4 | `http/sse.ts` | `emitTrace()` / `emitSources()` accept an optional `subQuestion`, always `undefined` | pass a real index; add `emitPlan()` |
| 5 | `obs/runlog.ts` | writes `depth: "quick"` | writes `"deep"` |

**Seam 3 is the one that pays.** Writing `merge(sets: EvidenceItem[][])` in Week 1 and calling it
with `[items]` costs about fifteen minutes. Writing `merge(items: EvidenceItem[])` and changing it
in Week 2 costs a day, because deduping and contiguous renumbering across sets is exactly the
bookkeeping deep search is graded on.

**Two structural invariants that make Week 2 possible.** Never hard-code a cap — always
`gear.maxToolCalls`. Never emit a source outside `evidence/merge.ts`. Break either and the seam is
decorative.

**What must NOT exist in Week 1.** `plan_research` must not be reachable by any code path. A quick
run whose trace contains it is a red line in `eval/rubric.json`, and `bench.mjs` checks every quick
run for it. Create the file; leave it unregistered.

---

## 14 · Build sequence and verification

Each step is independently verifiable. Do not start the next until the check passes.

| # | Build | Verify |
|---|---|---|
| 1 | `DESIGN.md` — the five questions | a stranger could name your components |
| 2 | providers + registry + 2 tools | unit-call each tool directly from `tsx` |
| 3 | Phase 1 loop + trace | `curl -N` shows ordered `trace` steps with reasons |
| 4 | evidence + snippet select + `sources` | `sources` arrives before any `token`; snippets are substrings of fetched text |
| 5 | Phase 2 + `done` | full stream; `unresolvedCitations()` returns `[]` |
| 6 | run log | `node quality/check.mjs .` reads it |
| 7 | search cache | same query twice → second reports `searchCached: true` |
| 8 | threads + messages | follow-up with a pronoun resolves |
| 9 | memory | preference in thread A changes thread B; delete reverses it |
| 10 | gateway | the provided UI lights up end to end |
| 11 | the failing trajectory | kill the search key; file lands in `runs/failing/` |

Then, in order: `node benchmark/bench.mjs --smoke` → `node quality/check.mjs .` →
`node benchmark/bench.mjs`.

**Test the agent service directly with `curl -N` before the gateway exists.** It is the fastest
loop in this project, and a browser adds nothing to it.

---

## 15 · Risks carried into the build

| Risk | Mitigation | Where it bites |
|---|---|---|
| TTFT budget covers search + fetch + first token | 3-turn shape, parallel fetch, bounded concurrency, per-fetch timeout well under the budget | §5.2 |
| Long pages blow the cost target | truncate to `sentText`, select snippet from it | §6.4 |
| Model paraphrases its quotes | deterministic snippet selection | §6.3 |
| Model cites out of range | prompt constraint + bracket-buffer guard | §6.5 |
| Sites block fetching / are JS-only | tool-level failure, loop continues; enough usable sources remain | §9 |
| Run log written before stream close | write in `finally` on close | §10.1 |
| Cache key drifts from grounding normalizer | one `normalize()`, two callers | §7.1 |
| `userId` post-filtered on vector search | filter declared in-index and passed in-stage | §4.2 |
| Compression silently buffers SSE | never mount it on the ask route | §11.2 |

---

## 16 · Decisions this document makes that a reasonable engineer would make differently

Carry these into `DESIGN.md §Trade-offs` — it asks for three or four, including one you are unsure
about.

1. **Two hard phases instead of one interleaved loop.** Guarantees `sources`-before-`token` and
   closes the citable universe before generation. Costs the ability to retrieve *because* of
   something noticed mid-answer — a real capability Perplexity has. Given the contract's ordering
   requirement, there is no honest alternative.
2. **Deterministic snippet selection.** Always passes the grounding gate; sometimes surfaces a
   passage that is not the one the claim rests on. Trades precision for verifiability.
3. **Eager `recall_memory`.** Saves a round trip on the critical path; injects memory into requests
   that did not need it.
4. **In-memory rate limiting.** Correct for one instance; the effective limit doubles at two. The
   one I am least sure about — a Mongo-backed counter is maybe thirty lines and removes the
   caveat entirely.

---

*Numbers: `benchmark/sla.json`, `expectations.json`, `eval/rubric.json`.
Wire format: `packages/contract/src/`. Requirements: `SPEC.md`. Rules: `AGENTS.md`.
When this file disagrees with any of them, they win and this file is stale.*
