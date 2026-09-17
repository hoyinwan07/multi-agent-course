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
import { approxTokens, truncateToBudget } from '../lib/tokens.js';
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

function extract(html: string, url: string): { title: string; text: string } | null {
  // jsdom logs every CSS parse error on a real-world page. Swallow them: they are noise,
  // not signal, and they would drown the one log line per answer that matters.
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', () => {});

  let dom: JSDOM;
  try {
    // Scripts never run — no `runScripts` option. Parsing a hostile page must not
    // execute it, and this process holds every provider key.
    dom = new JSDOM(html, { url, virtualConsole });
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
