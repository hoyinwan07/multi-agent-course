/**
 * fetch_page — read a page and turn it into evidence. The only web tool that does.
 *
 * Two decisions in here are worth more than the rest of the file.
 *
 * 1. READABILITY, NOT THE PROVIDER'S READER — a grounding decision, not a taste one.
 *    The bench does not check a snippet against OUR extraction. It re-fetches the URL
 *    itself and strips the HTML with a regex (`benchmark/bench.mjs`), so the haystack is
 *    the page's own text nodes. Readability returns those same text nodes decoded.
 *    Tavily's reader returns markdown, and markdown injects tokens that were never in the
 *    page — `[label](https://…)` normalizes to `label https example com …`, and a
 *    12-token run that crosses one cannot match. So Readability is the default for both
 *    providers. (The residual risk is entities: the bench turns `don&#39;t` into `don t`
 *    while Readability gives us `don't`. lib/normalize.ts flags apostrophe-bearing
 *    candidates so snippet selection can prefer clean ones.)
 *
 * 2. THE MODEL DOES NOT GET THE PAGE TEXT — a cost decision.
 *    `max_cost_per_answer_usd` in sla.json has to cover every turn of Phase 1 AND the
 *    synthesis call. Returning four full pages to the model in Phase 1 bills them again
 *    on every later turn and again in Phase 2 — roughly double the input tokens for a
 *    turn whose only job is to decide "have I got enough?". So the observation is a
 *    receipt, and the text itself travels in the evidence store to Phase 2, where it is
 *    actually synthesized from.
 *
 * A failure here is a TOOL failure: a 403, a timeout, a JS-only page. It returns
 * ok:false with a non-empty error, the model sees it as an error, and the loop continues
 * with the pages it did get.
 */
import { Readability } from '@mozilla/readability';
import { JSDOM, VirtualConsole } from 'jsdom';
import { evidenceIdForUrl, type EvidenceItem } from '../evidence/store.js';
import { normalizedTokens } from '../lib/normalize.js';
import { approxTokens, cutOnWordBoundary, truncateToBudget, type Truncated } from '../lib/tokens.js';
import { extractViaProvider } from '../providers/search.js';
import type { Tool, ToolContext, ToolResult } from './types.js';

/**
 * Per-page token budget. The arithmetic, at sla.json's cost model: four pages at this
 * size is ~4.8k input tokens, and Phase 2 pays for all of them at once. Raising it is the
 * fastest way to fail the cost gate; lowering it starts cutting articles in half.
 */
const PAGE_TOKEN_BUDGET = 1200;

/** Well under the TTFT budget: a slow page must not spend the whole allowance. */
const FETCH_TIMEOUT_MS = 6000;

/** jsdom parses whatever it is handed. A 20 MB page is a memory event, not a source. */
const MAX_BYTES = 2_000_000;

/**
 * THE PARSE BUDGET — the single biggest lever on ttft p95, and the one thing in this file
 * that is about latency rather than grounding.
 *
 * `extract()` is the only synchronous, CPU-bound step in the whole request path, and this
 * service is one Node event loop on one shared vCPU. A jsdom parse does not yield: while
 * it runs, nothing else on the machine progresses — not another request's page fetch, not
 * its SSE writes, not the sockets carrying its LLM stream. So one big page does not slow
 * one answer down, it freezes every answer in flight.
 *
 * Measured, 2026-09-18, against the deployed agent at the bench's own concurrency of 4:
 * three unrelated requests all produced their first token at the same instant, 23.68s in,
 * because one of them was parsing
 * `elastic.co/docs/.../reciprocal-rank-fusion` — 1.87 MB of HTML that takes 5-6s of
 * straight-line CPU locally and was logged as an 18.2s `fetch_page` on Fly. That single
 * page is the ttft p95 of 24.4s.
 *
 * What makes it 1.87 MB is not article: the stripped document is 8,610 `<span>`, 7,095
 * `<li>` and 7,091 `<a>` against 55 `<p>` — the entire Elasticsearch docs tree inlined
 * into the nav of every page. The article itself is 18,034 characters and sits in the
 * first quarter of the file, and `PAGE_TOKEN_BUDGET` above keeps only ~5k of those
 * characters anyway.
 *
 * So the two steps below bound the parse without touching what comes out of it:
 *
 *   `stripNonContent`  removes script/style/svg/noscript/template/comments before jsdom
 *                      builds a node for each of them. Readability already ignores all
 *                      six, so this cannot change the extraction — verified byte-for-byte
 *                      across the bench's real pages. Worth 2x on a script-heavy page
 *                      (mongodb.com: 909 KB → 168 KB) and nothing at all on elastic.co,
 *                      whose bulk is markup that Readability does look at.
 *
 *   `PARSE_BYTE_BUDGET` is what actually catches elastic.co: 250 KB of post-strip markup
 *                      holds far more prose than `PAGE_TOKEN_BUDGET` can keep (the densest
 *                      page measured, freecodecamp, yields 37k characters of article from
 *                      89 KB), so a document that is still over the budget after stripping
 *                      is one whose tail is navigation. Measured on elastic.co: 5,197ms →
 *                      603ms, extracted text byte-identical at 18,034 characters.
 *
 * The residual risk is a page whose article sits AFTER 250 KB of chrome. It degrades the
 * way every other unreadable page does — `extract()` returns null, the tool reports an
 * honest failure, and the loop continues with the pages it did get. That is a trade worth
 * naming: a rare truncated article against a p95 that every concurrent request pays.
 */
const PARSE_BYTE_BUDGET = 250_000;

/** Below this, Readability found chrome rather than an article. See extract(). */
const MIN_ARTICLE_TOKENS = 120;

export const fetchPage: Tool = {
  name: 'fetch_page',

  description: [
    'Read one web page and make its text citable. This is the ONLY way to get text an',
    'answer may cite.',
    '',
    'Call this on 3-4 URLs in a SINGLE turn — emit all the calls together so the pages are',
    'read in parallel. It returns a receipt, not the page: the text is held for the answer',
    'step, where you will be given every page you successfully read, numbered.'
  ].join('\n'),

  inputSchema: {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'The absolute http(s) URL to read.' }
    },
    required: ['url'],
    additionalProperties: false
  },

  async run(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const raw = typeof input.url === 'string' ? input.url.trim() : '';
    if (!raw) return { ok: false, error: 'fetch_page requires a non-empty "url" string' };

    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      return { ok: false, error: `not a valid URL: ${raw}` };
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return { ok: false, error: `unsupported protocol ${url.protocol} for ${raw}` };
    }

    const fetched = await fetchHtml(url, ctx.signal);
    if (!fetched.ok) return { ok: false, error: fetched.error, reason: `fetch ${url.hostname} failed` };

    const extracted = extract(fetched.html, url.toString());
    if (!extracted) {
      // A page that served bytes but no readable prose. Common and expected: paywalls,
      // JS-only shells, cookie interstitials. It is data, and the loop keeps going.
      return {
        ok: false,
        error: `no readable article text extracted from ${url.toString()} (paywall, JS-only page, or non-article)`,
        reason: `extracted ${url.hostname} — no main content`
      };
    }

    const budgeted = truncateToBudget(extracted.text, PAGE_TOKEN_BUDGET);
    const item: EvidenceItem = {
      id: evidenceIdForUrl(url.toString()),
      kind: 'web',
      title: extracted.title || url.hostname,
      url: url.toString(),
      fullText: extracted.text,
      sentText: budgeted.text,
      segments: budgeted.segments
    };

    return {
      ok: true,
      evidence: [item],
      observation: [
        `Read "${item.title}" (${url.hostname}).`,
        `${approxTokens(budgeted.text)} tokens of article text captured${budgeted.truncated ? ' (truncated to the page budget)' : ''}.`,
        `Preview: ${preview(budgeted.text)}`,
        'The full text is held for the answer step. Do not quote from this preview.'
      ].join(' '),
      reason: `fetched ${url.hostname} — ${approxTokens(budgeted.text)} tokens captured`
    };
  }
};

/**
 * THE 403 FALLBACK — read a page through the search provider's reader instead of directly.
 *
 * Called only by `retrieve.ts`, and only when a turn's direct fetches were refused AND the
 * evidence store is short of what Phase 1 needs to exit. The gate is the whole design, and
 * it is a cost decision measured over `runs/`: a Tavily extract is $0.008 at sla.json's
 * declared rate, and the extra LLM turn that a starved run spends refining its search is
 * $0.0289 (refined runs mean $0.0674 against $0.0386 for single-search runs). So the
 * fallback is 3.6x cheaper than the thing it prevents — but only when it prevents it.
 * Of the 91 quick runs with a 403, only 24 went on to refine; firing on the other 67 would
 * be paying $0.008 for evidence the run already had. Modelled over the same 375 runs:
 * on every 403 it takes `quickBudget` from 63 over-budget to 87, gated it takes it to 60.
 *
 * WHY THIS IS NOT THE THING `fetch_page`'S HEADER REJECTS. Comment 1 at the top of this
 * file rules out the provider's reader because it returns markdown, and markdown link
 * syntax injects tokens the grader's HTML stripper never sees. That reasoning is about
 * pages the grader can re-fetch. It cannot re-fetch these: `benchmark/bench.mjs:212` uses
 * its own unadorned user-agent (`lumina-bench/0.1`), and all six hosts sampled refuse it
 * exactly as they refuse us. `scoreGrounding` counts such a citation `unverifiable` and
 * `bench.mjs:833` excludes it from the denominator, so on precisely this set the markdown
 * risk cannot materialise. `markdownToText` below narrows it anyway rather than relying on
 * that, because a publisher can start serving the grader tomorrow.
 *
 * NOT A WAY AROUND ANYBODY'S BLOCK. Our user-agent stays honest and we stop fetching
 * directly the moment a host refuses. Tavily is a declared commercial crawler with its own
 * relationship to these publishers; asking it for a page is asking a party that is allowed
 * to have it, not impersonating a browser.
 */
export async function fetchPageViaExtract(url: string, ctx: ToolContext): Promise<ToolResult> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, error: `not a valid URL: ${url}` };
  }

  let raw: string;
  try {
    raw = await extractViaProvider(url, { signal: ctx.signal });
  } catch (e) {
    // A page the reader could not get either. Still a TOOL failure, reported as one — the
    // run continues with what it has, exactly as it would have without the retry.
    return {
      ok: false,
      error: `${url} refused a direct fetch and the provider's reader could not read it either: ${errorText(e)}`,
      reason: `extract ${parsed.hostname} — reader failed too`
    };
  }

  const text = markdownToText(raw);
  if (approxTokens(text) < MIN_ARTICLE_TOKENS) {
    return {
      ok: false,
      error: `no readable article text extracted from ${url} via the provider's reader`,
      reason: `extract ${parsed.hostname} — no main content`
    };
  }

  const budgeted = budgetNearQuery(text, PAGE_TOKEN_BUDGET, ctx.query);
  const item: EvidenceItem = {
    // The SAME id a direct fetch would have minted, so a page read both ways dedupes in
    // `mergeEvidence` instead of being cited twice under two numbers.
    id: evidenceIdForUrl(url),
    kind: 'web',
    title: parsed.hostname,
    url,
    fullText: text,
    sentText: budgeted.text,
    segments: budgeted.segments
  };

  return {
    ok: true,
    evidence: [item],
    observation: [
      `Read "${item.title}" (${parsed.hostname}) through the search provider's reader,`,
      `because the site refused a direct fetch.`,
      `${approxTokens(budgeted.text)} tokens of article text captured${budgeted.truncated ? ' (truncated to the page budget)' : ''}.`,
      `Preview: ${preview(budgeted.text)}`,
      'The full text is held for the answer step. Do not quote from this preview.'
    ].join(' '),
    // The trace says which path produced the page. A reader of the trajectory must be able
    // to tell a direct read from a recovered one without reading this file.
    reason: `fetched ${parsed.hostname} via the provider's reader (direct fetch refused) — ${approxTokens(budgeted.text)} tokens captured`
  };
}

/**
 * Markdown → something an HTML stripper would have produced.
 *
 * Only the two constructs that invent tokens: an inline link's target, and an image whose
 * alt text is not prose the page showed. Everything else markdown does (`#`, `**`) leaves
 * punctuation that `lib/normalize.ts` collapses anyway, and each extra rule here is another
 * chance to cut a real sentence in half.
 */
const markdownToText = (md: string): string =>
  md
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '') //      images: alt text is not page prose
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1') //   links: keep the label, drop the target
    .replace(/[ \t\u00a0]+/g, ' ')
    .replace(/[ \t]*\n[ \t]*/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

/**
 * Budget a page to `maxTokens` by keeping the window most about the QUESTION, rather than
 * the first N tokens.
 *
 * `truncateToBudget` takes the head, and for Readability output that is right: Readability
 * has already thrown the navigation away, so the head of what it returns is the head of the
 * article. The provider's reader has not — it hands back the whole page as markdown, chrome
 * included. Measured on the pages this fallback exists for, the first 1,200 tokens of a
 * Medium article are "Sign up Sign in Sign up Sign in" and the first of a Server Fault page
 * are its signup terms. Head-truncating those sends Phase 2 a source block of navigation
 * and no article — and `prompts.ts`'s `sourceBlock` puts `sentText` in front of the model
 * verbatim, so that is what the answer would be written from.
 *
 * Snippet selection would survive it (`evidence/select.ts` scores by query terms, and
 * "Sign up Sign in" scores zero), which is exactly what makes the bug quiet: the citation
 * would be fine and the ANSWER would be written from chrome.
 *
 * THE SUBSTRING GUARANTEE IS PRESERVED because the result is still ONE contiguous slice of
 * `fullText` — the same shape `truncateToBudget` returns, just taken from a different
 * offset. `lib/tokens.ts` warns that stitching the best passages together would cost that
 * guarantee; this deliberately does not stitch.
 */
function budgetNearQuery(fullText: string, maxTokens: number, query: string): Truncated {
  const budgetChars = maxTokens * 4;
  if (fullText.length <= budgetChars) return { text: fullText, segments: [fullText], truncated: false };

  const wanted = new Set(normalizedTokens(query).filter((t) => t.length > 2));
  if (!wanted.size) return truncateToBudget(fullText, maxTokens);

  // Quarter-budget stride: fine enough that the article cannot sit entirely between two
  // windows, coarse enough that a long page is a handful of scores, not thousands.
  const stride = Math.max(1, Math.floor(budgetChars / 4));
  let best = { start: 0, score: -1 };
  for (let start = 0; start < fullText.length; start += stride) {
    const slice = fullText.slice(start, start + budgetChars);
    let score = 0;
    for (const token of normalizedTokens(slice)) if (wanted.has(token)) score += 1;
    if (score > best.score) best = { start, score };
    if (start + budgetChars >= fullText.length) break;
  }

  // Start on a word boundary too: a window opening mid-word gives the model a fragment and
  // gives the grader a token that is on no page.
  const from = best.start === 0 ? 0 : fullText.indexOf(' ', best.start) + 1 || best.start;
  const window = cutOnWordBoundary(fullText.slice(from, from + budgetChars), budgetChars).trim();
  return { text: window, segments: [window], truncated: true };
}

const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

type FetchOutcome = { ok: true; html: string } | { ok: false; error: string };

async function fetchHtml(url: URL, signal: AbortSignal): Promise<FetchOutcome> {
  // The caller's abort (client disconnect) AND our own per-fetch deadline. Either ends it.
  const timeout = AbortSignal.timeout(FETCH_TIMEOUT_MS);
  const combined = AbortSignal.any([signal, timeout]);

  let res: Response;
  try {
    res = await fetch(url, {
      redirect: 'follow',
      headers: {
        // Honest about who we are. Some publishers block an unidentified client outright.
        'user-agent': 'lumina/0.1 (+FDE bootcamp research agent)',
        accept: 'text/html,application/xhtml+xml'
      },
      signal: combined
    });
  } catch (e) {
    const why = timeout.aborted ? `timed out after ${FETCH_TIMEOUT_MS}ms` : String(e instanceof Error ? e.message : e);
    return { ok: false, error: `could not fetch ${url.toString()}: ${why}` };
  }

  if (!res.ok) {
    return { ok: false, error: `${url.toString()} returned ${res.status} ${res.statusText}` };
  }

  const type = res.headers.get('content-type') ?? '';
  if (!/(text\/html|application\/xhtml)/i.test(type)) {
    // PDFs and friends are the Week 2 document path, not something to guess at here.
    return { ok: false, error: `${url.toString()} is ${type || 'an unknown type'}, not HTML` };
  }

  const html = await res.text().catch(() => '');
  if (!html.trim()) return { ok: false, error: `${url.toString()} returned an empty body` };
  return { ok: true, html: html.length > MAX_BYTES ? html.slice(0, MAX_BYTES) : html };
}

/**
 * Everything jsdom would build a node for and Readability would then ignore.
 *
 * Regex on HTML, deliberately: the alternative is to build the DOM in order to prune it,
 * which is the cost this exists to avoid. It is safe HERE because it is not parsing — a
 * missed or over-eager match costs some bytes either way and never produces a node that
 * lies about the page. Nothing that can carry article text is in the list, and `<template>`
 * is inert content by definition.
 */
const stripNonContent = (html: string): string =>
  html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, '')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, '')
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript\s*>/gi, '')
    .replace(/<svg\b[^>]*>[\s\S]*?<\/svg\s*>/gi, '')
    .replace(/<template\b[^>]*>[\s\S]*?<\/template\s*>/gi, '');

function extract(html: string, url: string): { title: string; text: string } | null {
  // jsdom logs every CSS parse error on a real-world page. Swallow them: they are noise,
  // not signal, and they would drown the one log line per answer that matters.
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', () => {});

  // Both steps happen before a single node exists. See PARSE_BYTE_BUDGET for why this is
  // the ttft fix and why neither one can change what comes out.
  const stripped = stripNonContent(html);
  const source = stripped.length > PARSE_BYTE_BUDGET ? stripped.slice(0, PARSE_BYTE_BUDGET) : stripped;

  let dom: JSDOM;
  try {
    // Scripts never run — no `runScripts` option. Parsing a hostile page must not
    // execute it, and this process holds every provider key.
    dom = new JSDOM(source, { url, virtualConsole });
  } catch {
    return null;
  }

  try {
    const article = new Readability(dom.window.document).parse();
    const text = tidy(article?.textContent ?? '');
    // A real article clears this easily. Below it, Readability found no main content and
    // what we are holding is navigation chrome — measured: a page yielding 70 tokens gave
    // a snippet of menu items, and menu items are where Readability's element joins
    // diverge most from the grader's HTML stripper. Cheaper to call it a failed fetch.
    if (approxTokens(text) < MIN_ARTICLE_TOKENS) return null;
    return { title: (article?.title ?? '').trim(), text };
  } catch {
    return null;
  } finally {
    dom.window.close();
  }
}

/**
 * Whitespace only. Safe because `normalize` collapses whitespace on both sides of the
 * grounding comparison — but nothing else may be touched here, or `segments` stops being
 * a run of real page text and the guarantee in lib/tokens.ts is a comment, not a fact.
 */
const tidy = (s: string): string =>
  s
    .replace(/[ \t\u00a0]+/g, ' ')
    .replace(/[ \t]*\n[ \t]*/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

const preview = (s: string): string => {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length > 180 ? `${one.slice(0, 180)}…` : one;
};
