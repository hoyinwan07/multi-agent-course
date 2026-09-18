# LUMINA — session handoff (Week 1 SHIPPED + deployed; Week 2 starts here)

## Working directory
`modules/Module_1_Agent_Foundations_Harness_System_Design/Assignment_1_Lumina/`

npm workspace root (`package.json` workspaces, `.env`, `runs/`). **Every path below is relative
to it.** Agent commands run from `backend/agent/`, gateway commands from `backend/gateway/`.

## Context
**Assignment 1: LUMINA**, FDE Agent Engineering Bootcamp cohort 2026-03. Due end of Week 2;
currently starting **Week 2**. Perplexity-style citation-grounded research agent, two Express
services. React UI + API contract are **provided and must not be edited** (one exception below).

- `backend/gateway/` (:8787) — edge: CORS, `X-User-Id`, request ids, pino, zod, rate limit,
  SSE pass-through, serves `web/dist`. **No provider keys. COMPLETE.**
- `backend/agent/` (:8000) — the work: loop, tools, memory **done (Week 1)**. RAG, deep search,
  jobs worker, `/stats` are **Week 2, not started.**

**Do not edit:** `web/`, `packages/contract/`, `benchmark/`, `eval/`, `quality/`, `scripts/`.
One exception already made and explained below (`web/vercel.json`). Submission is a
**deployed URL**, not code.

## Document authority order (higher wins; if prose disagrees, prose is stale)
1. `packages/contract/src/` — executable zod schemas
2. `benchmark/sla.json`, `expectations.json`, `eval/rubric.json` — all thresholds
3. `AGENTS.md` → 4. `SPEC.md` → 5. `TECHSPEC.md`, `DESIGN.md` (mine)

---

## Week 2: what's actually left (start here)

**Spaces + the jobs worker are DONE this session** (see "Done this session" below) — Gate 2
now runs for real instead of crashing. What's left on the contract:

| Route | Purpose | Status |
|---|---|---|
| `GET /stats` | Deep-run cost + remaining daily allowance (needed for the submission video) | 501, not started |
| `POST /spaces` | Create a Space | ✅ done |
| `GET /spaces` | List Spaces | ✅ done |
| `POST /spaces/:spaceId/documents` | Upload → `202` → parse → chunk → embed → probe → `indexed` (the jobs worker) | ✅ done |
| `GET /spaces/:spaceId/documents` | List documents + status | ✅ done |

Deep search itself hangs off the **existing** `POST /threads/:threadId/ask` route via
`{"depth":"deep"}` — no new route, but the Phase 1 loop needs to plan sub-questions, research
each, and merge into one citation numbering (README's build-sequence step 8).

**Hybrid retrieval is ALSO done now (same session, second pass)** — see "Done this session,
part 2" below. `recall@5` went from `0/3` to `3/3` on the smoke bench.

**What's next, in order:**
1. `GET /stats` — deep-run cost + `deepDailyCap` remaining, off the `requests`/`runs`
   collections already populated in Week 1.
2. Deep search (README step 8): `plan_research` fan-out + merged citation numbering.

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
- Local `main` and `mine/2026-03-hoyinwan/lumina-week1` are in sync as of commit `575fdc3`,
  plus whatever this session commits on top (see "Done this session" above).
- Local `main` is **ahead of `origin/main` by 3 commits, behind by 14** — this is expected and
  fine; we deliberately never touch `origin`.

Commits so far:
- `897736c` — Week 1 build (steps 1-11): loop, tools, gateway, memory. 58 files.
- `9188f0c` — removed the invalid `_comment` from `web/vercel.json`.
- `575fdc3` — Fly deploy config (agent private, gateway public) + Week 2 handoff. Includes
  `.dockerignore`, both Dockerfiles, `fly.agent.toml`, `fly.gateway.toml` — these are
  committed; an earlier version of this section calling them "uncommitted" was stale.
- Spaces + jobs worker (this session) — see the commit this session made, listed at the top
  of the file once committed.

**Uncommitted right now** (`git status` at the `multi-agent-course` repo root):
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
Week 2, added this session: `repo/spaces.ts`, `repo/documents.ts` (+`documentTitles`),
`repo/chunks.ts` (+`hybridSearchChunks`/RRF), `repo/jobs.ts`, `repo/uploads.ts`,
`ingest/parse.ts`, `ingest/chunk.ts`, `ingest/index-document.ts`, `http/spaces.routes.ts`,
`tools/search_documents.ts`, `worker.ts` (rewritten). Touched: `tools/registry.ts`
(mode/Space-aware `forGear`), `tools/types.ts` (`mode`/`spaceId` on `ToolContext`),
`loop/retrieve.ts` (router-driven eager calls), `loop/prompts.ts` (mode-parameterized
system prompt), `loop/run.ts`, `http/threads.routes.ts`. Still to build: `GET /stats`, and
deep-search planning (`tools/plan_research.ts` already exists but is unregistered/unused).

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
node quality/check.mjs .                                      # 0 errors; exit 1 is the FLOOR
node eval/eval.mjs                                             # stops at Gate 2 until /spaces exists
node benchmark/bench.mjs --smoke                                # same Gate-2 crash, same reason
```

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

## What I still owe
- **`DESIGN.md`** — still the largest debt, graded as the design section of `/evals`. Owes:
  trade-offs #1 and #4 personalized, eager search, the exit heuristic, head-only truncation, the
  TTFT gap with its measured breakdown (now including the deployed-vs-local gap), the citation
  guard as structural, answer length as a latency decision, not caching thin results,
  citation-stripped history, bounded history as cost, persist-before-close, the five memory
  decisions, the `res`-vs-`req` close finding (agent AND gateway), gateway overhead, 404-vs-400,
  502-is-the-only-minted-status, `/evals/report.json` off disk — **and now, from this session:**
  the `flyctl deploy` public-IP re-provisioning gotcha, the 6PN-never-wakes-a-stopped-machine
  finding, the `db()` stale-client bug, and the Vercel per-workspace build gap.
- **A decision on the cost AND latency gates** — still open, see Known risks.
- `SERPAPI_API_KEY` — not set locally or on Fly.
- **Commit the 5 deploy config files** sitting uncommitted right now (see Git state).
- **Rest of Week 2**: deep search + `/stats`. Spaces, the jobs worker, and hybrid retrieval
  are all done (this session) — see above.

**Next session should:** commit this session's work (Spaces + worker + hybrid retrieval —
see git state below), then build `GET /stats` (cheap — `requests`/`runs` already carry
everything it needs) and deep search (`plan_research` fan-out + merged citation numbering).
The ttft/answer p95 misses are the one thing still open from Week 1 and are a separate
decision (see Known risks), not something either of these blocks on.
