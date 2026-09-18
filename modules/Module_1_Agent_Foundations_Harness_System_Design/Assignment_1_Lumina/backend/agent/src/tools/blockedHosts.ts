/**
 * Hosts that refuse this agent outright, kept off the menu the model picks URLs from.
 *
 * WHAT THIS IS NOT: it is not a way around anybody's bot detection. The user-agent in
 * `fetch_page.ts` stays honest, and the correct response to a site that has said no is to
 * stop asking it — not to dress up as a browser. This list is how we stop asking.
 *
 * WHY IT EARNS ITS PLACE. Measured over the 1,685 `fetch_page` calls in `runs/`:
 *
 *   403          177   <- 65% of all failures once #3 fixed the timeouts
 *   timeout       68   <- fixed by fast-follow #3; all 8 sampled URLs now succeed
 *   no-article    52   <- correct behaviour: client-rendered pages with no prose in the
 *                         HTML (geeksforgeeks, khanacademy et al. extract 0 tokens, so
 *                         there is nothing MIN_ARTICLE_TOKENS could be lowered to catch)
 *
 * and a 403 is not a neutral failure. `retrieve.ts` needs MIN_EVIDENCE_TO_EXIT pages; a
 * turn that spends three of its four fetches on blocked hosts comes up short and the model
 * spends another turn searching again. That second search is what actually costs points:
 * `searchCachedFrom()` requires EVERY search in a run to be a cache hit, so one refinement
 * on a novel phrase reports `searchCached: false` for the whole run — and the bench's cache
 * gate has exactly zero margin (20 fresh + 20 repeats, ceiling 50%, gate >=50%). Of the 37
 * runs that refined, 24 (65%) had a 403 in the first round and 14 failed on nothing else.
 * The same second round is most of `quickBudget`'s over-$0.05 runs.
 *
 * HOW THE LIST WAS CHOSEN. Every entry below was recorded 403ing at least twice in `runs/`
 * AND re-probed live on 2026-09-18, one sample URL each: 14 of 14 returned 403 again. These
 * are deterministic refusals, not flaky ones. Together they account for 155 of the 177
 * recorded 403s (88%); the ~19 hosts with a single 403 each are left in, because one
 * refusal is not evidence of a policy and the cost of being wrong is a page we never read.
 *
 * MAINTENANCE. A host here is a host we have stopped reading, so it is a real editorial
 * loss (britannica and stackoverflow are genuinely useful). If one of them ever starts
 * serving us again, delete the line — the list is deliberately small, explicit, and has no
 * wildcard beyond the registrable-domain match in `isBlockedHost`.
 */

/**
 * Registrable domains, matched on the host itself or any subdomain — `medium.com` covers
 * `sanjmo.medium.com`, `investing.com` covers the ca/uk/ng/in editions, `cloudflare.com`
 * covers `community.cloudflare.com`. Recorded 403 counts are the comment on each line.
 */
const BLOCKED_DOMAINS: readonly string[] = [
  'medium.com', //          49 — 38 on the apex plus 11 across publication subdomains
  'investing.com', //       28 — www, ca, uk, ng and in editions of the same article
  'serverfault.com', //     12
  'cloudflare.com', //      14 — community.cloudflare.com (12) and www (2)
  'towardsai.net', //       10 — pub.towardsai.net, a Medium publication
  'npmjs.com', //           10
  'openai.com', //           9
  'gopenai.com', //          9 — blog.gopenai.com, a Medium publication
  'dataaspirant.com', //     5
  'britannica.com', //       4
  'stackoverflow.com', //    3
  'baeldung.com' //          2
];

/**
 * True when `hostname` is a blocked domain or a subdomain of one.
 *
 * Suffix matching is anchored on a dot so `notmedium.com` is not caught by `medium.com` —
 * the cheap `endsWith` version of this check is the kind of bug that silently removes a
 * legitimate source and never shows up in a test.
 */
export function isBlockedHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, '');
  return BLOCKED_DOMAINS.some((domain) => host === domain || host.endsWith(`.${domain}`));
}
