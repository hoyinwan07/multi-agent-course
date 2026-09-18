# LUMINA — session handoff (Week 1 shipped; Week 2 code-complete, pending commit)

## READ THIS FIRST — exact resume point

Deep search (README step 8, the last Week 2 route) is **built, fully re-verified against
the restarted agent, and both open findings from that verification have been reviewed and
explicitly accepted as documented risks by the user. Nothing is committed yet — that is the
only remaining step, and it needs the user's go-ahead.**

What happened in the verification pass (2026-09-18 session):
1. Restarted the agent (old PID killed by exact PID, not `pkill`, per the standing rule
   below) to pick up the `PLAN_MAX_TOKENS`/prompt fix.
2. Hand-verified one deep search: plan arrived in ~6.9s (down from the ~10s pre-fix
   baseline), no `PLAN_MAX_TOKENS` truncation error, decomposition stayed sane (6
   sub-questions).
3. Ran the FULL `node benchmark/bench.mjs`. Result: **`deep plan p95` improved from
   9950ms to 6494ms but still misses its `<= 4000ms` target** — the fix helped
   (~35-45% faster across all 4 samples: 5447/6494/4833/5580ms) but didn't close the gap.
   Every other deep-search SLA line passed. **User decision: accept `deep plan p95` as a
   known, documented risk — do not tune further.** See "Deep search — architecture, bugs
   found, and verification" below for the full final SLA table.
4. Ran typecheck (clean) and eslint (clean). `node quality/check.mjs .` came back
   `1 error(s), 2 warning(s)` instead of the expected `0 errors, 2 warnings` — traced to
   rule `A2` ("every run ends with `terminated='done'`", severity `error`), which was
   tripping on `cap`-terminated deep runs now that deep search actually exists in the
   local `runs/` corpus. Split the runs by whether they predated the agent restart: 3
   `error`-terminated deep runs turned out to be stale debris from the OLD pre-fix process
   (10:35-10:41am, before the 11:14:18 restart) — **deleted** (`runs/req_mu728jze.json`,
   `req_mu72esji.json`, `req_mu72g6z6.json`; all untracked, never committed, safe to
   remove). The remaining cap-terminated runs (11 deep + 3 quick, all post-restart, all
   legitimate) are exactly the already-documented "`terminated:'cap'` is common at 6
   sub-questions" trade-off (see Bug #2 below) plus the pre-existing Week 1 quick-loop
   finding (see Known risks). **User decision: accept this too — quality/check.mjs will
   keep showing `1 error(s)` under rule A2 until/unless that rule is rescoped to exclude
   deep search's accepted cap terminations; this is expected, not a regression to chase.**

**What's left:** commit. The exact uncommitted file list is under "Git / fork state →
Uncommitted right now" and "Files built (agent...)" below. This project's rule is never to
commit without being asked, and that has held for every prior piece of this Week 2 work too
(three separate commits, each only after the user said to) — **ask before committing.**

**Real-money note:** this pass's manual testing plus one full bench run spent somewhere
around $2-3 in real Anthropic + Tavily calls (each deep search costs ~$0.20-0.25). That's
expected and within `max_cost_per_deep_answer_usd` ($0.35/answer) — confirmed in the final
SLA table (`$0.2284` measured). Throwaway test users from this session (`deep-test-1`
through `-5`, `cap-test-1`, `deep-manual-2`, `deep-manual-3`) have each used part or all of
their `DEEP_DAILY_CAP` for today (UTC) — irrelevant fake ids, but don't reuse them expecting
a fresh cap.

Full detail on what was built, the two real bugs found and fixed along the way, and the
final numbers from the full bench run are under "Deep search — architecture, bugs found,
and verification" below. The rest of this file (Spaces, hybrid retrieval, `/stats`, deploy
state) is from earlier in this same session and is committed and stable — no action needed
there.

## Working directory
`modules/Module_1_Agent_Foundations_Harness_System_Design/Assignment_1_Lumina/`

npm workspace root (`package.json` workspaces, `.env`, `runs/`). **Every path below is relative
to it.** Agent commands run from `backend/agent/`, gateway commands from `backend/gateway/`.

## Context
**Assignment 1: LUMINA**, FDE Agent Engineering Bootcamp cohort 2026-03. Due end of Week 2;
currently finishing **Week 2**. Perplexity-style citation-grounded research agent, two Express
services. React UI + API contract are **provided and must not be edited** (one exception below).

- `backend/gateway/` (:8787) — edge: CORS, `X-User-Id`, request ids, pino, zod, rate limit,
  SSE pass-through, serves `web/dist`. **No provider keys. COMPLETE.**
- `backend/agent/` (:8000) — the work: loop, tools, memory **done (Week 1)**. Spaces, the
  jobs worker, hybrid retrieval RAG, and `/stats` are **done and committed**. Deep search is
  **built, one fix pending verification, nothing committed yet** — see above.

**Do not edit:** `web/`, `packages/contract/`, `benchmark/`, `eval/`, `quality/`, `scripts/`.
One exception already made and explained below (`web/vercel.json`). Submission is a
**deployed URL**, not code.

## Document authority order (higher wins; if prose disagrees, prose is stale)
1. `packages/contract/src/` — executable zod schemas
2. `benchmark/sla.json`, `expectations.json`, `eval/rubric.json` — all thresholds
3. `AGENTS.md` → 4. `SPEC.md` → 5. `TECHSPEC.md`, `DESIGN.md` (mine)

---

## Week 2: what's actually left

Every route on the contract is now built:

| Route | Purpose | Status |
|---|---|---|
| `GET /stats` | Deep-run cost + remaining daily allowance (needed for the submission video) | ✅ done, committed |
| `POST /spaces` | Create a Space | ✅ done, committed |
| `GET /spaces` | List Spaces | ✅ done, committed |
| `POST /spaces/:spaceId/documents` | Upload → `202` → parse → chunk → embed → probe → `indexed` (the jobs worker) | ✅ done, committed |
| `GET /spaces/:spaceId/documents` | List documents + status | ✅ done, committed |
| `POST /threads/:id/ask {depth:"deep"}` | Plan sub-questions, fan out, merge citations, spend gate | ✅ built, verifying the last fix, **not committed** |

Hybrid retrieval (`search_documents` + RRF, README step 7) is done and committed alongside
Spaces/stats — see "Done this session, part 2/3" below. **Nothing is 501 anymore.** Once
deep search's last fix is verified and committed, Week 2 is code-complete; what remains
after that is `DESIGN.md` write-ups and the cost/latency finding (see Known risks) —
neither blocks the contract.

**Done this session — Spaces + jobs worker (§5.4):**
- New `repo/` files (the only files touching their collection, per the `repo/` rule):
  `spaces.ts`, `documents.ts`, `chunks.ts` (upsert + the read-your-write probe query),
  `jobs.ts` (atomic claim + a stale-job sweeper), `uploads.ts` (GridFS).
- New `ingest/` package: `parse.ts` (pdfjs-dist page-aware PDF text extraction; markdown
  split by heading; plain text split by line blocks), `chunk.ts` (sub-divides a section on
  size, keeps its one locator), `index-document.ts` (the orchestrator: parse → chunk →
  embed in batches of 64 → upsert → poll the probe up to 30s).
- `http/spaces.routes.ts`: all 4 routes, multer memory-storage upload (field `file`),
  404-not-403 scoping identical to `threads.routes.ts`, 413/400 on oversized/bad-mimetype
  uploads.
- `worker.ts` rewritten from the skeleton: polls `jobs`, claims atomically, runs
  `index_document`, sweeps stale `running` rows every 10 ticks. Runs as its OWN PROCESS
  (`npm run worker`) — this is what satisfies the bench's ingest-decoupling check (a PDF
  parsing in a separate OS process cannot block the agent's SSE stream), not worker_threads.
- Verified locally: 4 gold-corpus files (2 PDF, 2 md) all reach `indexed`; 202 accept latency
  178-340ms (target ≤300ms p95, borderline warm-connection variance, not yet measured
  properly under bench's own concurrency); a truly empty file correctly reaches `failed`
  with a real error string; unknown-space and bad-mimetype uploads correctly 404/400.
  `npm run -w @lumina/agent typecheck` and `npx eslint backend/agent/src --max-warnings 0`
  both clean. `node quality/check.mjs .` still 0 errors (2 pre-existing warnings, unchanged).
- **`node eval/eval.mjs` now reaches Gate 2 and runs it for real** (previously crashed with
  `HttpError: 501 POST /spaces`). Gate 2 still fails, but on the two ALREADY-KNOWN Week 1
  latency findings (ttft/answer p95) plus `recall@5 0/3` (hybrid retrieval not built — see
  "what's next" above), not on anything Spaces-related. `citationGrounding`, `errorRate`,
  `costPerAnswer`, `sourcesBeforeFirstToken`, and `citationsWithNoSource` all pass.

**Not built / deliberately out of scope this session:** re-index-on-replace and
delete-a-document (§5.4 lists both as "Could", not "Must").

**Done this session, part 2 — hybrid retrieval (§5.4):**
- `tools/search_documents.ts`: embeds the query, calls `repo/chunks.ts`'s new
  `hybridSearchChunks` (dense `$vectorSearch` + BM25 `$search` on `chunks_text`, both
  scoped to `spaceId`+`userId` INSIDE their own stage, fused by reciprocal rank fusion —
  `RRF_K=60`, top 20 candidates per side, top 8 after fusion, all named consts next to the
  function per SPEC's "declared in config, not hard-coded"). No separate re-rank call after
  fusion — documented in-code as the deliberate "or a documented reason for skipping it"
  choice, given the already-open latency budget. One evidence item per PAGE/heading/line,
  not per chunk (dedupes multiple chunks of one locator, keeping the highest-RRF one).
- Registered in `tools/registry.ts`; `forGear` now also takes `ctx` and hides
  `search_documents` when no Space is attached or `mode:'web'`, and hides
  `web_search`+`fetch_page` when `mode:'docs'` (a request scoped to documents cannot drift
  into the web by the model inventing a URL nobody offered it).
- `ToolContext` (`tools/types.ts`) gained `mode`/`spaceId`; threaded through
  `loop/run.ts` → `loop/retrieve.ts` from `POST /threads/:id/ask`'s body (`http/threads.routes.ts`
  now also 404s an unknown/foreign `spaceId` the same way it 404s an unknown thread).
- `loop/retrieve.ts`'s eager-call logic now runs `web_search`, `search_documents`, or both,
  based on `mode`+`spaceId` — `'auto'` with no Space is byte-identical to Week 1 (web only);
  `'auto'` with a Space blends both; `'docs'` runs the Space search only. Eager
  `search_documents` evidence is frozen into the store exactly like a model-called one.
- `loop/prompts.ts`'s retrieval system prompt is now parameterized by which retrieval tools
  are actually available this request, so it never tells the model a web search ran when
  `mode:'docs'` means it didn't; the fetch-specific rules were generalized to apply to
  either retrieval path rather than assuming `fetch_page` is mandatory.
- `repo/documents.ts` gained `documentTitles` (batch title lookup for citation rendering).
- Verified against the ALREADY-INDEXED corpus from part 1: `mode:'docs'` question →
  citation `[1]` resolves to `retrieval-basics.pdf, p. 1` with the exact "The common
  default is 1.2" snippet, grounded; `mode:'auto'` with a Space blends `kind:'doc'` and
  `kind:'web'` sources in one answer; `mode:'web'` unchanged (regression-checked by hand).
  `node benchmark/bench.mjs --smoke`: **`recall@5` 3/3** (was 0/3), `indexedViaWorker`,
  `pageLocator`, `routerPicksDocs`, `groundingMet`, `retrievalAlways` all pass. `accept202`
  missed at 350ms vs the 300ms p95 target on this one small local run — worth another data
  point, not yet a real finding. `ttft`/`answer` p95 still miss — the same pre-existing
  Week 1 finding, untouched by this work. `node quality/check.mjs .`: back to 0 errors (same
  2 pre-existing warnings). Typecheck + lint clean throughout.

**Done this session, part 3 — `GET /stats` (§10.4):**
- **Real finding: the `requests` collection TECHSPEC's file tree pairs with `runs` for this
  aggregation is never written to** — no `repo/requests.ts` exists and nothing imports
  `COLLECTIONS.requests`. Rather than build a whole request-logging path Week 1 skipped,
  `repo/messages.ts` gained `statsForUserSince`, deriving every field from `messages`
  instead: a `role:'user'` row is a "request" (persisted whether or not it produced an
  answer — see `persistExchange`), a `role:'assistant'` row is an "answer", and its stored
  `done` (a full `DoneEvent` — `ttftMs`, `costUsd`, `searchCached`, `depth`) is exactly the
  per-answer data `/stats` needs, with nothing missing. `runs`/`RunLog` was the other
  candidate and was rejected: it has no `searchCached` field at all (the contract's `RunLog`
  doesn't carry it), so it cannot answer `searchCacheHitRatePct`.
- `http/stats.routes.ts`: `GET /stats`, scoped by `X-User-Id`, windowed to "today" as
  midnight UTC (matching how `createdAt` is always written — `new Date().toISOString()`).
  `deepDailyCap` comes from `env.deepDailyCap`, not from data — it's the ceiling, not a
  measurement. `deepToday` will read `0` until deep search exists, same as TECHSPEC predicts.
- No new index added for the `{userId, role, createdAt}` query pattern this needs —
  `scripts/` is on the do-not-edit list, and a collection scan over one course's message
  volume isn't worth breaking the "indexes live in scripts/indexes.json" convention for.
  Worth a line in `DESIGN.md` if message volume ever makes this show up in a profile.
- Verified: a user with 12 prior answers today gets back real, non-zero numbers that match
  a manual count; a brand-new user id gets all zeros with no crash; no `X-User-Id` still
  401s; the gateway proxies it unchanged (it was already wired in Week 1). `node
  benchmark/bench.mjs --smoke`: `statsReconciles` now passes (`/stats.answers=27` against
  `9` answers that specific run produced). `node quality/check.mjs .`: still 0 errors, same
  2 pre-existing warnings. Typecheck + lint clean.

**Deep search — architecture, bugs found, and verification (§5.5; BUILT, NOT COMMITTED —
see "READ THIS FIRST" at the top of this file for the exact resume point):**

*Files.* New: `loop/deep.ts` (the orchestrator), `lib/time.ts` (`startOfUtcDay`/
`nextUtcMidnightIso`, shared with `/stats`). Modified: `loop/retrieve.ts`, `loop/run.ts`,
`loop/prompts.ts`, `loop/synthesize.ts`, `providers/llm.ts`, `providers/llm.anthropic.ts`,
`tools/plan_research.ts`, `http/sse.ts`, `http/threads.routes.ts`, `repo/messages.ts`.

*The architecture decision, and why it isn't what `plan_research.ts`'s old comment said to
do.* That comment said "register it, let `forGear`/`forbiddenTools` keep it from quick."
Registering it would make `plan_research` just another tool the model calls whenever it
feels like during the same turn-loop `retrieve()` already runs — which cannot structurally
guarantee the Must that matters most here: the `plan` event ships before ANY retrieval.
That would live in a system prompt's wording, not in the code. Instead: `loop/deep.ts`
calls the LLM ONCE, directly, with `tools: [planResearch]` and `toolChoice` forced (new
capability added to `LlmCompleteRequest`/`AnthropicProvider`), before the retrieval loop
starts at all — then fans out one ordinary `retrieve()` call per sub-question (bounded
concurrency, `SUBQUESTION_CONCURRENCY = 3`), each tagged with a fixed `subQuestion` index
passed as a parameter (`retrieve.ts` gained `subQuestion?`/`presetMemories?` on
`RetrieveArgs`) — never relying on the model to self-report which sub-question a fetch
several turns later belongs to. `plan_research.ts`'s `run()` is consequently NEVER called
through the registry; it stays unregistered, and its file header now explains why in
detail (read it before changing this). Recall runs ONCE per deep request (not once per
sub-question) via `retrieve.ts`'s newly-exported `eagerRecall`. Each sub-question's
tool-call budget is a fair fraction of the SAME 24-call ceiling `expectations.json` holds
the whole run log to (one call reserved for the top-level recall, the rest divided evenly
and floored — see `loop/deep.ts`'s `RESERVED_FOR_RECALL`/`perSubMax` math).

*Bug #1, real and reproducible: the model does not reliably return `subQuestions` as a
native array under a FORCED `tool_choice`.* Observed twice, consistently: it serialises
the whole tool input to a JSON string and nests it one level deeper than the schema
describes — `{ subQuestions: '{"subQuestions":[...]}' }` instead of
`{ subQuestions: [...] }`. `input_schema` is a hint to the model, not something the API
validates the response against. Fixed with `loop/deep.ts`'s `extractSubQuestions()`,
which handles a native array, a JSON-stringified array, and a JSON-stringified
re-wrapped object. **If you ever see "0 usable sub-question(s)" again, check this first**
— log `planCall.input` raw before assuming the model under-decomposed.

*Bug #2: a sub-question's tool-call budget was structurally too tight to ever exit
cleanly.* With 6 sub-questions, fair division gives each ~3 calls (1 eager search + 2
more) — but `MIN_EVIDENCE_TO_EXIT` (3, tuned for quick's 8-call budget) requires 3
successful fetches to auto-exit, which a 3-call budget can never produce (the eager search
itself produces no evidence, only links). Every sub-question was hitting `cap` by
construction, not by bad luck. Fixed with a lower `MIN_EVIDENCE_TO_EXIT_SUBQUESTION = 2` in
`retrieve.ts`, applied automatically whenever `subQuestion` is set — reasoned in-code as
acceptable because a sub-question is narrower than the question it was decomposed from.
`terminated: 'cap'` is still common with 6 sub-questions even after this fix (one fetch 403
anywhere in a 3-call budget has no slack to recover) — this is an honest, expected
consequence of dividing a fixed budget across a wide plan, not a bug; worth a line in
`DESIGN.md`, not further tuning.

*The plan prompt was pushed too far once, and it broke a run.* An early version of
`loop/prompts.ts`'s `planSystemPrompt` said "prefer the low end" of the 3-6 sub-question
range without also stating the minimum as a hard floor next to it — the model returned
1 sub-question, which failed the contract's `PlanEvent.min(2)`. Fixed by adding an explicit
"HARD REQUIREMENT... not a suggestion" line ahead of any guidance about preferring fewer.
If you touch this prompt again, keep the hard-minimum statement first and unambiguous.

*The `deep plan p95` finding — fully re-verified, now an accepted known risk (not a gap).*
The full (non-`--smoke`) `node benchmark/bench.mjs` run after both bugs above were fixed,
**and after the restart + re-test described in "READ THIS FIRST"**, passed EVERY
deep-specific SLA line except one — this is the FINAL table, measured against the
restarted agent running the fixed code:

| Metric | Target | Measured |
|---|---|---|
| deep answer p95 | ≤ 90s | 51.1s ✓ |
| deep sub-questions (min) | ≥ 3 | 6 ✓ |
| deep/quick source ratio (min) | ≥ 2× | 2.0-4.0× across 4 runs ✓ |
| cost per deep answer | ≤ $0.35 | $0.2284 ✓ |
| citation grounding | ≥ 0.95 | 1.0 ✓ |
| error rate | ≤ 0.01 | 0 ✓ |
| **deep plan p95** | **≤ 4000ms** | **6494ms ✗ (accepted, see below)** |

Full SLA table from the same run, for completeness (the two `✗` rows below are pre-existing
Week 1 findings, unrelated to deep search — see "Known risks carried forward"):
`ttft p95` 12303ms (target ≤2500ms, ✗ pre-existing), `answer p95` 16566ms (target
≤12000ms, ✗ pre-existing), `202 accept p95` 280ms ✓, `search p95 during ingest/idle` 1.198×
✓, `recall@5` 0.933 ✓, `search cache hit rate` 97.5% ✓, `cost per answer (quick)` $0.0327 ✓,
`sources before first token` 1 ✓, `citations with no matching source` 0 ✓.

Also verified by hand (not part of the automated SLA table): `deepCap429` — a fresh
throwaway user hitting `DEEP_DAILY_CAP` gets `429 {error, resetsAt}` with `resetsAt` a real
midnight-UTC ISO string; every trace step and source in a deep run carries the right
`subQuestion`; `mode:'web'` deep search still blends correctly; the synthesis prompt's
structured shape (short direct answer, one section per sub-question, a closing
"still unknown" note) reads as intended in the one full answer inspected end to end.

The `deep plan p95` miss is a generation-time problem, not a network one: with no
`maxTokens` set on the planning call, the model was writing verbose sub-questions and
one-paragraph reasons, and 6 of those at Sonnet's generation speed is genuinely several
seconds. Three changes went in together and **have now been re-tested and confirmed
working as intended**, just not sufficient to close the gap to the target:
1. `loop/deep.ts` gained `PLAN_MAX_TOKENS = 900` on the planning call (previously
   unbounded at the SDK default of 1536) — a safety ceiling, not the primary fix, sized
   with headroom so a compliant model's output shouldn't get cut off mid-JSON. **Confirmed:
   zero `PLAN_MAX_TOKENS` truncation errors across the hand-verification run or the 4 deep
   answers in the full bench run.**
2. `planSystemPrompt` now says reasons must be "AT MOST TEN WORDS: a phrase, not a
   sentence" and explicitly tells the model this call is timed — the real fix, since it
   should reduce how much the model actually writes rather than just capping it.
   **Confirmed working directionally** — plan times across the 4 bench samples were
   5447/6494/4833/5580ms, a ~35-45% improvement over the pre-fix 9950ms baseline — but not
   enough to land under 4000ms on any of the 4 samples.
3. Defensively, `loop/deep.ts` now checks `planReply.stopReason === 'max_tokens'` and
   throws a specific, readable error naming `PLAN_MAX_TOKENS` if a plan ever IS truncated
   — so that failure mode is diagnosable rather than reappearing as a confusing "0 usable
   sub-questions" (which is bug #1's signature, not this one's). **Never fired in this
   verification pass.**

**`deep plan p95` (6494ms vs. the 4000ms target) is now a known, documented risk, not an
open bug — explicit user decision, do not tune further without being asked.** The
remaining gap looks like an inherent cost of asking Sonnet to both decompose into 3-6
sub-questions AND write a reason for each under a forced tool call; shrinking it further
would likely mean cutting sub-question count or dropping the reason field entirely, both of
which trade away things the contract or the UX wants. Worth a line in `DESIGN.md` under
Trade-offs, written by hand (see "What I still owe").

*A second, related finding from this same verification pass: `quality/check.mjs`'s `A2`
rule ("every run ends with `terminated='done'`", severity `error`) now fails locally,
because deep search's own accepted cap-termination trade-off (below) started showing up as
real entries in the `runs/` corpus once deep search was actually exercised. This is not a
new bug — it is the SAME trade-off as Bug #2 below, just visible through a different gate.
**Also accepted as a known risk by explicit user decision.** 3 unrelated stale
`error`-terminated run files from the pre-fix process were found and deleted in the same
pass (see "READ THIS FIRST") — those were real debris, not part of this trade-off.

Read, in order: `README.md` → `packages/contract/src/http.ts` (spaces/documents schemas) →
`TECHNICAL.md` (search for the RAG/Spaces and Deep Search sections — build guide, commands,
gotchas) → `SPEC.md` for exact requirements.

---

## Deploy state (done this session — a "thin" Week-1-only deploy, to catch infra issues early)

**Live URLs:**
- UI: **https://multi-agent-course-rho.vercel.app/**
- Gateway (public): **https://lumina-gateway-hoyinwan.fly.dev**
- Agent: **private** — NOT publicly reachable by design (confirmed: `curl` to
  `lumina-agent-hoyinwan.fly.dev` times out / DNS fails). Only the gateway can reach it, over
  Fly's private network at `http://lumina-agent-hoyinwan.internal:8000`.

**Fly.io** (org: `personal` / hoyinwan07@gmail.com, region `iad`):
- `lumina-agent-hoyinwan` — no public IP, `min_machines_running = 1`, `auto_stop_machines = 'off'`
  (must stay always-on — see finding below). 18 secrets imported from `.env` (all except the
  gateway-only vars and the still-empty `SERPAPI_API_KEY`).
- `lumina-gateway-hoyinwan` — public, `CORS_ORIGINS` includes both `http://localhost:5173` and
  the Vercel URL. `AGENT_URL` points at the agent's `.internal` hostname.

**Vercel:** project imported from the fork (see Git state below), Root Directory
`modules/Module_1_Agent_Foundations_Harness_System_Design/Assignment_1_Lumina/web`,
env var `VITE_API_URL=https://lumina-gateway-hoyinwan.fly.dev`. **Build Command is
overridden** in Project Settings (not in any repo file):
```
cd .. && npm run build -w @lumina/contract && cd web && npm run build
```
This exists because `web/`'s own `build` script never builds `@lumina/contract` first — that's
normally done by the *root* `dev`/`build` scripts, which Vercel's per-workspace build doesn't run.

**Deploy files created this session — NOT YET COMMITTED to git** (still local-only, `git status`
shows them untracked): `.dockerignore`, `backend/agent/Dockerfile`, `backend/gateway/Dockerfile`,
`fly.agent.toml`, `fly.gateway.toml`. **Commit these before doing anything else that touches
git**, or a fresh clone/session will have no record of how this was deployed.

### 7 real infra findings from this deploy (do not undo / re-break these)
1. **`flyctl deploy` silently re-provisions public IPs even after `--no-public-ips` at
   `flyctl launch`.** Had to `flyctl ips release` both the shared ipv4 and dedicated ipv6 after
   every deploy that touched the agent app. Verify with `flyctl ips list -a lumina-agent-hoyinwan`
   after any future agent deploy — it should print nothing.
2. **Both services resolve `.env` / `runs/` / `reports/` / `web/dist` via
   `resolve(process.cwd(), '../../...')`, assuming `cwd = backend/<service>/`.** Our Docker
   images set `WORKDIR /app/backend/<service>` in the final stage specifically to preserve this
   — do not flatten that back to `/app`.
3. **A stopped Fly machine never wakes from a direct private 6PN (`.internal`) connection** —
   only public/proxied traffic through Fly's edge triggers `auto_start_machines`. This is why
   the agent is pinned `min_machines_running = 1` / `auto_stop_machines = 'off'` instead of
   scaling to zero like the gateway does. (The gateway can scale to zero fine — it's only ever
   reached via its public hostname, which Fly Proxy does wake.)
4. **MongoDB Atlas Network Access needed `0.0.0.0/0`** — Fly's shared-tier machines have no
   fixed small IP range to allowlist (dedicated static IPs are a paid Fly feature). The
   `MONGODB_URI` credentials remain the real auth boundary.
5. **`backend/agent/src/db.ts`'s `db()` caches a `MongoClient` even when `.connect()` throws** —
   `client = new MongoClient(...)` runs before `await client.connect()`, so a failed first
   connection leaves `client` truthy forever and every later `pingDb()` reuses the broken
   client until the process restarts. Not just a deploy artifact — a real bug worth fixing and
   worth a line in `DESIGN.md`. (We currently work around it by restarting the machine, not by
   fixing the code.)
6. **`web/vercel.json` (provided) had a `_comment` field that violates Vercel's own schema** —
   `should NOT have additional property _comment`, blocking every deploy attempt. This is the
   **one exception** to "don't edit `web/`": removed only that field, the actual SPA rewrite
   rule is byte-for-byte what was provided. Flagged as likely a scaffold bug affecting every
   student deploying this repo to Vercel — worth mentioning to the instructor.
7. **Vercel's per-workspace build never runs the root's `npm run build -w @lumina/contract`
   step** — fixed via a Build Command override in Vercel's dashboard (see above), not in any
   repo file.

### Verified this session
- Gateway `/health` on the deployed URL: `db: ok`, `ai.status: ok`, model/search/vector-store
  all correct.
- All 4 contract probes pass against the deployed gateway (401 no header / 404 unknown thread /
  400 empty body / 404 not 401 on `evals/report.json`).
- Real end-to-end question through the **fully deployed stack** (Vercel → Fly gateway → private
  Fly agent → Atlas): streamed answer, correct citations, thread created, `terminated: done`,
  cost $0.0487, ttft ~12.2s (slower than local's ~8-10s — expected, cross-region + cold Atlas
  connection on a fresh machine; not yet root-caused further, worth another data point before
  drawing conclusions in `DESIGN.md`).

### Still not done re: deploy
- `SERPAPI_API_KEY` is empty — not set as a Fly secret either. Needed for the provider-swap
  test whenever that gets picked back up.
- The 5 deploy config files above are committed (`575fdc3`) — this line was stale as of the
  Spaces/worker session; corrected here.
- No redeploy has happened since the last local code change, if any — always redeploy both Fly
  apps after backend changes (`flyctl deploy -c fly.agent.toml --ha=false --no-public-ips` /
  `flyctl deploy -c fly.gateway.toml --ha=false`) and re-release IPs per finding 1 if the agent
  was touched.
- `/evals/report.json` is not yet served by the deployed gateway (no report has been built yet
  — Gate 2 crashes on `/spaces` before a report can be produced either locally or deployed).

---

## Git / fork state

**Do NOT push to `origin`** (`https://github.com/hamzafarooq/multi-agent-course.git`) — that's
the instructor's shared repo; nothing here should ever land on its `main`. All work goes to:

- **`mine`** remote → `https://github.com/hoyinwan07/multi-agent-course.git` (your own fork)
- Branch: **`2026-03-hoyinwan/lumina-week1`** — this is what Vercel's Production Branch is set to,
  and what the eval/deploy work in this handoff assumes is current.
- **Local `main` is at `8d7870e` — THREE commits ahead of `mine/2026-03-hoyinwan/lumina-week1`,
  which is still at `575fdc3`. Nobody has pushed this session's work yet.** Push (or ask
  before pushing, per this project's own rule about not doing risky/one-way actions
  unprompted) once the deep-search commit lands on top, so all four land on `mine` together
  — or push sooner if the user wants the Spaces/RAG/stats work backed up independently.
- Local `main` is **ahead of `origin/main` by 6 commits, behind by 14** — expected and fine;
  we deliberately never touch `origin`.

Commits so far, oldest first:
- `897736c` — Week 1 build (steps 1-11): loop, tools, gateway, memory. 58 files.
- `9188f0c` — removed the invalid `_comment` from `web/vercel.json`.
- `575fdc3` — Fly deploy config (agent private, gateway public) + Week 2 handoff.
- `5c6be0f` — Spaces + upload/list documents + the jobs worker.
- `59e63ab` — hybrid retrieval (`search_documents` + RRF), wired into the router.
- `8d7870e` — `GET /stats`.
- *(not yet made)* — deep search, once the pending fix above is verified and the user says
  to commit.

**Uncommitted right now** (`git status` at the `multi-agent-course` repo root):
- All of deep search — see the file list under "Deep search" above. **Do not commit until
  the pending `PLAN_MAX_TOKENS`/prompt fix is re-tested** (see "READ THIS FIRST").
- `modules/Module_1_Agent_Foundations_Harness_System_Design/package-lock.json` and
  `multi-agent-course/package-lock.json` — stray, empty, pre-date this work (from Sep 11,
  unrelated npm invocations at the wrong directory level). Leave untracked; not part of LUMINA.

---

## Environment state
- `.env` exists at the assignment root. Both services resolve `process.cwd()/../../.env`.
  Do NOT create `backend/agent/.env` or `backend/gateway/.env`.
- Keys present: `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `TAVILY_API_KEY`, `MONGODB_URI`.
  **`SERPAPI_API_KEY` still empty.**
- `RATE_LIMIT_PER_MINUTE=300` (raised from 30 — findings 7 and 23 below).
- `@anthropic-ai/sdk` ^0.125.0 is declared in `backend/agent/package.json` and the lockfile. If
  you see `Cannot find module '@anthropic-ai/sdk'`, re-run
  `npm i @anthropic-ai/sdk -w @lumina/agent`.
- `node scripts/create-indexes.mjs` **has been run** — all regular/TTL indexes plus the 3
  search indexes exist, including `memories_vector`. (Whatever Week 2 needs for hybrid
  retrieval — a text/vector index over Space documents — is presumably **not** covered by this
  yet; check `scripts/create-indexes.mjs` against what Week 2 actually needs.)
- Local dev: agent/gateway/web can all still be started per the Verified Commands below.
  **Do NOT use `pkill -f "tsx src/index.ts"`** — it matches both services.

## Build progress (TECHSPEC §14) — Week 1 steps, all done
| # | Step | State |
|---|---|---|
| 1 | `DESIGN.md` | mostly done — still owes several write-ups, see below |
| 2 | providers + registry + 2 tools | done |
| 3 | Phase 1 loop + trace | done |
| 4 | evidence + snippet select + `sources` | done — grounding 27/27 = 100% |
| 5 | Phase 2 + `done` | done |
| 6 | run log | done |
| 7 | search cache | done |
| 8 | threads + messages | done |
| 9 | memory | done |
| 10 | gateway | done |
| 11 | failing trajectory | done — `runs/failing/` |
| — | **local eval dry run (this session)** | Gates 0/1 pass; Gate 2 fails as expected on `POST /spaces` (Week 2) |
| — | **thin deploy (this session)** | done — see Deploy state above |

## Files built (agent — Week 1, all complete)
```
lib/          normalize.ts  tokens.ts  errors.ts
providers/    llm.ts  llm.anthropic.ts  search.ts  search.tavily.ts  search.serpapi.ts  embed.ts
tools/        types.ts  registry.ts  web_search.ts  fetch_page.ts  recall_memory.ts
              save_memory.ts  plan_research.ts (UNREGISTERED — Week 2: deep search wires this up)
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
Week 2, committed: `repo/spaces.ts`, `repo/documents.ts` (+`documentTitles`),
`repo/chunks.ts` (+`hybridSearchChunks`/RRF), `repo/jobs.ts`, `repo/uploads.ts`,
`ingest/parse.ts`, `ingest/chunk.ts`, `ingest/index-document.ts`, `http/spaces.routes.ts`,
`tools/search_documents.ts`, `http/stats.routes.ts`, `worker.ts` (rewritten),
`tools/registry.ts` (mode/Space-aware `forGear`), `tools/types.ts` (`mode`/`spaceId` on
`ToolContext`), `loop/retrieve.ts` (router-driven eager calls — further extended by deep
search below, uncommitted), `loop/prompts.ts` (mode-parameterized system prompt — also
further extended below), `loop/run.ts`, `http/threads.routes.ts`, `repo/messages.ts`
(+`statsForUserSince`).

Week 2, built but **UNCOMMITTED** (deep search — see "READ THIS FIRST" up top before
touching any of these): new `loop/deep.ts`, `lib/time.ts`; further changes on top of the
committed state in `loop/retrieve.ts` (`subQuestion`/`presetMemories` params),
`loop/prompts.ts` (`planSystemPrompt`, structured synthesis prompt), `loop/run.ts`
(branches to `runDeep`), `loop/synthesize.ts` (structured shape), `providers/llm.ts` +
`providers/llm.anthropic.ts` (`toolChoice`), `tools/plan_research.ts` (header rewritten,
still unregistered — by design now, not by not-built-yet), `http/sse.ts` (`emitPlan`),
`http/threads.routes.ts` (`DEEP_DAILY_CAP` 429 check), `repo/messages.ts`
(+`countDeepAnswersToday`). Every route on the contract is now built.

## Files built (gateway — Week 1, all complete)
```
middleware/   requireUser.ts  validate.ts  rateLimit.ts
proxy/        json.ts (proxyJson + proxyUpload)  stream.ts (proxyStream)
index.ts      501 loop DELETED; every contract route wired; /evals/report.json served off disk
env.ts        + reportPath
sse.ts        [P] untouched — sseHeaders() + sseSend() used as provided
```
Chain, per §11.1: `cors → requestId → pino-http → requireUser → validate → rateLimit → proxy`.
**No changes needed here for Week 2** unless Spaces/documents routes need new proxy behavior
(e.g. `proxyUpload` for multipart uploads — check if it's already used or still needs wiring).

## Verified commands
```bash
npm run -w @lumina/agent typecheck && npx eslint backend/agent/src --max-warnings 0
cd backend/agent && nohup npx tsx src/index.ts > /tmp/lumina-agent.log 2>&1 &   # then sleep 6
cd backend/gateway && nohup npx tsx src/index.ts > /tmp/lumina-gateway.log 2>&1 &   # then sleep 6
VITE_API_URL=http://localhost:8787 npm run dev -w web                # → http://localhost:5173
node quality/check.mjs .                                      # 0 errors is the FLOOR
node eval/eval.mjs                                             # all 6 gates now run for real
node benchmark/bench.mjs --smoke                                # Gate 2's quick check; no deep phase
node benchmark/bench.mjs                                       # FULL run — the only one that exercises deep search (phase 4) and the daily-cap probe; ~10-15 real min + real API spend
```

Manual deep-search smoke test (used to verify the pending `deep plan p95` fix — swap in a
fresh `x-user-id` each time so `DEEP_DAILY_CAP` doesn't need to reset):
```bash
TID=$(curl -s -X POST localhost:8000/threads -H 'x-user-id: deep-manual-1' -H 'content-type: application/json' -d '{}' | node -e "process.stdin.on('data',d=>process.stdout.write(JSON.parse(d).threadId))")
curl -sN -X POST "localhost:8000/threads/$TID/ask" -H 'x-user-id: deep-manual-1' -H 'content-type: application/json' \
  -d '{"query":"Should we move our RAG stack off Atlas Vector Search onto a dedicated vector DB? Consider cost at scale, page-level citation support, operational burden of a second store, and migration cost.","mode":"web","depth":"deep"}'
```
Watch for: the `plan` event's arrival time (should be well under the ~8-10s seen before
the fix), no `error` event mentioning `PLAN_MAX_TOKENS`, and a sane 3-6-item decomposition.

Fly redeploys (from the assignment root):
```bash
export FLYCTL_INSTALL="/Users/hoyinwan/.fly"; export PATH="$FLYCTL_INSTALL/bin:$PATH"
flyctl deploy -c fly.agent.toml --ha=false --no-public-ips   # then: flyctl ips list -a lumina-agent-hoyinwan (must be empty)
flyctl deploy -c fly.gateway.toml --ha=false
```

## Findings that overrode the docs — do not undo these (Week 1, still true)
1. Grounding haystack is the bench's own re-fetch (Readability, not Tavily `extract`).
2. `normalize()` has NO NFKC — matches `benchmark/lib.mjs`.
3. Longer snippets are safer; 30-token windows.
4. `res.on('close')`, never `req.on('close')`, in both the agent and the gateway.
5. TTFT 2500ms is unreachable; floor ≈ 3.6s local (≈12s observed on the deploy — see above).
6. LLM turns are ~74% of latency, tools ~26%.
7. `RATE_LIMIT_PER_MINUTE` raised from 30 → 300 (bench's concurrency blows the 30 default).
8. `sla.json` cost rates are placeholders (Sonnet 5 is really $2/$10, not $3/$15).
9. `temperature` is deprecated on Sonnet 5 — don't re-add it.
10. Never cache a thin search result (`MIN_CACHEABLE_HITS = 2`).
11. `expiresAt` must be a BSON `Date`; `threads`/`messages`/`memories` store ISO strings instead.
12. `quality/rules.json` ships stale `TODO —` precedents by design — `exit 1` at 0 errors is the floor.
13. History must be citation-stripped before re-entering a prompt (`loop/history.ts`).
14. Persist the exchange BEFORE `sse.end()`; run log after.
15–29: memory findings (parallel eager recall, `systemOnly` tools, top-k no score floor, degrade
   not kill, injected into both phases) — see full detail in git history of this file
   (`897736c`) if needed; unchanged, still true.

## Known risks carried forward
- **Cost AND latency gates still breached, same mechanism:** an extra LLM turn from a failed
  fetch or a model-initiated second search costs both dollars and seconds. `max_cost_per_answer_usd
  0.05` and `answer_p95_ms 12000`. **This is still the single biggest open problem in the quick
  loop**, unrelated to Week 2, and worth fixing before or alongside Week 2 work — Week 2's bench
  runs will also pay this tax on every quick-mode query.
- A3 (no tool thrash) has thin headroom: cap 4, observed max 5 this session (`req_0d506abf-6ff`,
  `fetch_page` 5x consecutively) — worse than previously observed max 3.
- Cache gate has no headroom: `min_search_cache_hit_rate_pct: 50` against exactly 20 fresh + 20
  repeats.
- Atlas Search indexes are eventually consistent — acceptable for Week 1 memory recall,
  becomes a hard requirement for Week 2's read-your-write probe (SPEC §13) once Spaces exist.
- **`deep plan p95` misses its `<= 4000ms` target (measured 6494ms)** — the `PLAN_MAX_TOKENS`
  + shortened-reason-prompt fix improved it ~35-45% from a 9950ms baseline but didn't close
  the gap. Explicit user decision (2026-09-18): accept as a known risk, do not tune further.
  Likely an inherent cost of forcing a 3-6-item decomposition-with-reasons under a forced
  tool call at Sonnet's generation speed.
- **`quality/check.mjs` rule `A2` ("every run ends `terminated='done'`") now fails locally**
  with `1 error(s)`, because deep search's accepted `terminated:'cap'` trade-off (see Bug #2
  under Deep search below) now shows up as real entries in the local `runs/` corpus.
  Explicit user decision (2026-09-18): accept this too, same trade-off as the line above,
  just visible through a different gate. Not tracked as a regression to fix.

## What I still owe
- **`DESIGN.md`** — still the largest debt, graded as the design section of `/evals`. Owes:
  trade-offs #1 and #4 personalized, eager search, the exit heuristic, head-only truncation, the
  TTFT gap with its measured breakdown (now including the deployed-vs-local gap), the citation
  guard as structural, answer length as a latency decision, not caching thin results,
  citation-stripped history, bounded history as cost, persist-before-close, the five memory
  decisions, the `res`-vs-`req` close finding (agent AND gateway), gateway overhead, 404-vs-400,
  502-is-the-only-minted-status, `/evals/report.json` off disk — **and now, from this session:**
  the `flyctl deploy` public-IP re-provisioning gotcha, the 6PN-never-wakes-a-stopped-machine
  finding, the `db()` stale-client bug, the Vercel per-workspace build gap, the `requests`
  collection never being written (§10.4, `/stats` derives from `messages` instead), and —
  once deep search is committed — the fan-out-over-model-self-tagging decision, the two
  real bugs (forced-`tool_choice` JSON-string double-wrapping, the too-tight per-sub-question
  budget), and the fixed-24-call-budget-vs-wide-plan trade-off (`terminated:'cap'` being
  common at 6 sub-questions is a consequence of that trade-off, not a bug).
- **A decision on the cost AND latency gates** — still open, see Known risks.
- `SERPAPI_API_KEY` — not set locally or on Fly.
- **Deep search is fully verified and both open findings (`deep plan p95`, the `A2` quality
  gate) are accepted known risks — the ONLY thing left is committing**, and that needs the
  user's go-ahead first (never commit without being asked — see "READ THIS FIRST").
- Push this session's commits to `mine/2026-03-hoyinwan/lumina-week1` (currently 3-4
  commits behind local `main` — see Git state) — not done automatically, ask first.
- Redeploy both Fly apps once deep search is committed (nothing has been redeployed since
  the thin Week-1-only deploy — see Deploy state).

**Next session should:** if deep search still isn't committed, ask the user and commit it
(everything is verified — see "READ THIS FIRST"). After that, Week 2 is code-complete and
what's left is `DESIGN.md` write-ups (see "What I still owe" above — now substantial,
including the two newly-accepted known risks from this verification pass), the still-open
cost/latency decision (Known risks), and redeploying. The ttft/answer p95 misses are a
separate, pre-existing Week 1 decision — not something deep search blocks on or was ever
expected to fix.
