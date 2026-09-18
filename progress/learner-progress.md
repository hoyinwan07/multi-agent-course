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
| 01 — Agent Foundations, Agent Harness & System Design | in progress | Learner is well past lesson content, actively building the Module 1 project (LUMINA) directly with Claude as engineering partner rather than through `teach-module`. Week 1 (loop, tools, gateway, memory) shipped and deployed (Vercel + Fly.io) before this session. This session (2026-09-18), four commits landed, completing every route on the LUMINA contract: `5c6be0f` (Spaces + upload/documents + jobs worker), `59e63ab` (hybrid retrieval: `search_documents` + RRF, router wiring), `8d7870e` (`GET /stats`, working around a real Week 1 gap — the `requests` collection was never written to), and `2b96a5d` (deep search: plan → fan-out → synthesize). Deep search's own build surfaced two real bugs (a forced-`tool_choice` JSON-double-encoding quirk; a too-tight per-sub-question evidence-exit threshold) and one prompt regression (under-decomposition below the required minimum), all fixed and verified. Its `deep_plan_p95_ms` fix was re-tested against a restarted agent and a full bench run: improved from 9950ms to 6494ms but still misses the 4000ms target, and a related `quality/check.mjs` gate (`A2`, "every run ends `terminated='done'`") started failing on deep search's own accepted cap-termination trade-off. Both were reviewed with the learner and explicitly accepted as documented known risks rather than tuned further — full detail in `Assignment_1_Lumina/HANDOFF.md`. **Week 2 is now code-complete.** What's left: `DESIGN.md` write-ups (the learner's own instructor requires this be handwritten, not Claude-authored — Claude reviewed it against the current code and gave the learner a list of exact stale/missing spots to fix by hand, but made no edits), the still-open cost/latency decision on the quick loop (pre-existing Week 1 finding), and redeploying both Fly apps. No signal yet on whether the learner wants the underlying course concepts (harness design, async job patterns, RRF, hybrid retrieval, forced tool-calling quirks) taught/quizzed separately from building them. |
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
- Week 2 code is done and committed. Remaining work is the handwritten `DESIGN.md`
  updates (learner's own task — see the exact list Claude gave them this session),
  deciding on the pre-existing quick-loop cost/latency gates, and redeploying both Fly
  apps once the learner is ready. See `Assignment_1_Lumina/HANDOFF.md` for full state.
