# Learner Progress

<!-- Claude reads this at the start of each session and updates it at the end.
     Learners: you don't need to touch this — Claude maintains it. -->

## Learner profile
- Name: [unset]
- Preferred learning style: [unset — set during /start: Socratic | Lecture+checkpoints | Build-along]
- For hands-on Assignment 1 (LUMINA) build sessions specifically: prefers "I drive, you
  review" — Claude implements against the spec/contract directly and narrates key decisions,
  learner reviews the diff, rather than build-along or lecture pauses. Asked for this
  2026-09-18 when picking up Week 2. Revisit if the learner asks for something else.
- Started: [date]
- Last session: 2026-09-18

## Module status

| Module | Status | Notes / weak spots |
|--------|--------|--------------------|
| 01 — Agent Foundations, Agent Harness & System Design | in progress | Learner is well past lesson content, actively building the Module 1 project (LUMINA) directly with Claude as engineering partner rather than through `teach-module`. Week 1 (loop, tools, gateway, memory) shipped and deployed (Vercel + Fly.io) before this session. This session (2026-09-18), three passes, each committed: (1) `5c6be0f` — `POST/GET /spaces`, upload/list documents, the jobs worker (GridFS → pdfjs-dist parse → chunk → embed → read-your-write probe → `indexed`, SPEC §5.4) — unblocked `node eval/eval.mjs` past Gate 2. (2) `59e63ab` — hybrid retrieval: `search_documents` tool, `$vectorSearch`+`$search` fused by RRF in `repo/chunks.ts`, wired into the router (`mode: 'web'/'docs'/'auto'`) — `recall@5` went 0/3 → 3/3 on the smoke bench. (3) `GET /stats` — found and worked around a real Week 1 gap (the `requests` collection is never written to; derived all of `/stats` from `messages` instead, documented in `HANDOFF.md`) — `bench.mjs`'s `statsReconciles` now passes. Only deep search is left on the LUMINA contract — see `Assignment_1_Lumina/HANDOFF.md` for the live state. No signal yet on whether the learner wants the underlying course concepts (harness design, async job patterns, RRF, hybrid retrieval) taught/quizzed separately from building them. |
| 02 — Skills & Subagents: Product Architecture & Coordination | not started | |
| 03 — Production Agentic RAG & AI Systems | not started | |
| 04 — Multi-Agent Systems & Orchestration | not started | |
| 05 — Real-Time Voice Agents & Conversational Systems | not started | |
| 06 — Leading AI Systems Across Teams | not started | |
| 07 — Demo Day (EPYHIA) | not started | |

Status values: not started · in progress · completed · needs review

## Weak spots to revisit
- [none yet]

## Next step
- Commit the `GET /stats` work (awaiting learner go-ahead), then build deep search — the
  last route on the LUMINA contract. See
  `modules/Module_1_Agent_Foundations_Harness_System_Design/Assignment_1_Lumina/HANDOFF.md`.
