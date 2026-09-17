/**
 * Cost accounting (§10.2).
 *
 * The rates are READ FROM `benchmark/sla.json → cost_model`, never copied into code.
 * That file is the authority on thresholds, and a rate pasted here would drift from the
 * one the bench scores against — so the dollar figure on /evals would disagree with the
 * dollar figure in the gate, and both would look authoritative.
 *
 * Note for DESIGN.md: sla.json's rates are the placeholders the file itself warns about
 * ($3/$15 per MTok). Claude Sonnet 5 publishes $2/$10. The file is do-not-edit, so this
 * reads what is there and every reported cost is ~50% conservative. Better conservative
 * than disagreeing with the grader.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

type CostModel = {
  input_usd_per_mtok: number;
  output_usd_per_mtok: number;
  embedding_usd_per_mtok: number;
  search_usd_per_call: number;
};

const FALLBACK: CostModel = {
  input_usd_per_mtok: 3.0,
  output_usd_per_mtok: 15.0,
  embedding_usd_per_mtok: 0.02,
  search_usd_per_call: 0.008
};

let cached: CostModel | null = null;

function costModel(): CostModel {
  if (cached) return cached;
  try {
    const path = resolve(process.cwd(), '../../benchmark/sla.json');
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as { cost_model?: Partial<CostModel> };
    cached = { ...FALLBACK, ...(parsed.cost_model ?? {}) };
  } catch {
    // A missing sla.json must not take the service down, but it must be visible: the
    // fallback is the same numbers, so a silent swap changes nothing about the bill.
    cached = FALLBACK;
  }
  return cached;
}

export type Spend = {
  tokensIn: number;
  tokensOut: number;
  embeddingTokens: number;
  /** Provider calls actually made. Cache HITS COST NOTHING and must not appear here. */
  searchCalls: number;
};

export const emptySpend = (): Spend => ({
  tokensIn: 0,
  tokensOut: 0,
  embeddingTokens: 0,
  searchCalls: 0
});

/**
 * Accumulated across EVERY LLM turn in the request, not just synthesis. Phase 1's three
 * turns are most of the input tokens, and a cost that counts only the last call is the
 * kind of number that makes a product look affordable right up until the invoice.
 */
export function costUsd(spend: Spend): number {
  const m = costModel();
  const usd =
    (spend.tokensIn / 1e6) * m.input_usd_per_mtok +
    (spend.tokensOut / 1e6) * m.output_usd_per_mtok +
    (spend.embeddingTokens / 1e6) * m.embedding_usd_per_mtok +
    spend.searchCalls * m.search_usd_per_call;
  // Six places: a quick answer costs cents, and rounding to four hides the difference
  // between a cheap run and a very cheap one.
  return Math.round(usd * 1e6) / 1e6;
}

/** Total tokens, the single number the RunLog shape wants (§10.1). */
export const totalTokens = (spend: Spend): number => spend.tokensIn + spend.tokensOut;
