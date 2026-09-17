/**
 * The one distinction "fail loud" rests on (TECHSPEC §9, AGENTS.md).
 *
 *   A tool that ran and failed is DATA — the model should see it, the loop continues.
 *     A page 403s. Extraction yields nothing. A PDF is a scan.
 *     → { ok: false, error } + a trace step with a non-empty error.
 *
 *   A provider that is down is NOT data — it is the end of the run.
 *     The search API 503s. The key is rejected. The LLM SDK throws.
 *     → ProviderError, uncaught by the tool wrapper, terminated:"error", HTTP 502.
 *
 * Without a marker on the exception, one catch has to guess which it was, and the
 * guess is always "recoverable" — which is precisely how Live Translate shipped English
 * for weeks behind 200s. So the decision is made at the throw site, by type.
 */
export class ProviderError extends Error {
  readonly provider: string;
  readonly status?: number;

  constructor(provider: string, message: string, status?: number) {
    super(`${provider}: ${message}`);
    this.name = 'ProviderError';
    this.provider = provider;
    this.status = status;
  }
}

export const isProviderError = (e: unknown): e is ProviderError => e instanceof ProviderError;

/** Error → string, for a trace step's `error` field. Never empty: the contract rejects that. */
export function errorMessage(e: unknown): string {
  if (e instanceof Error && e.message.trim()) return e.message;
  const s = String(e ?? '').trim();
  return s || 'unknown error';
}

/** A missing key is a configuration failure, and it is fatal to the run, not to one tool. */
export function requireSecret(provider: string, value: string, envName: string): string {
  if (!value) throw new ProviderError(provider, `${envName} is not set`);
  return value;
}
